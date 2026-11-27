import json
import re
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from boto3.dynamodb.conditions import Attr

from collect_today import NO_VALUE, collect_for_user, query_all, table

PRIORITIES = {1: "ASAP", 2: "HIGH", 3: "MEDIUM", 4: "LOW"}
FIELDS = {
    "name": "name", "duration": "duration", "dueDate": "due_date", "due_date": "due_date",
    "rhythm": "rhythm", "today": "today", "priority_level_id": "priority", "priority": "priority",
    "ordnung": "ordnung", "spontan": "spontan", "longTerm": "long_term", "long_term": "long_term", "kontext": "kontext", "deadline": "deadline", "notiz": "notiz", "subtasks": "subtasks", "evergreen": "evergreen",
}


def today():
    return datetime.now(ZoneInfo("Europe/Berlin")).date()


def to_json(o):
    if isinstance(o, Decimal):
        return int(o) if o == int(o) else float(o)
    raise TypeError(type(o))


def key(user_id, task_id):
    return {"PK": f"USER#{user_id}", "SK": f"TASK#{task_id}"}


def get_profile(user_id):
    return table.get_item(Key={"PK": f"USER#{user_id}", "SK": "PROFILE"}).get("Item")


def get_item(user_id, task_id):
    return table.get_item(Key=key(user_id, task_id)).get("Item")


NUMERIC = {"duration", "priority", "today"}
WEEKDAYS = {"mo": 0, "di": 1, "mi": 2, "do": 3, "fr": 4, "sa": 5, "so": 6}
WEEKDAY_NAMES = {v: k for k, v in WEEKDAYS.items()}
MONTH_END = {"eom", "monatsende", "ende", "letzter"}


def parse_rhythm(value):
    """'7' -> alle 7 Tage, 'do' -> jeden Donnerstag, 'eom' -> letzter Tag im Monat."""
    if value is None or value == "":
        return None, None
    s = str(value).strip().lower()
    if s.isdigit():
        return int(s), None
    m = re.fullmatch(r"(\d{1,2})\.", s)
    if m and 1 <= int(m.group(1)) <= 31:
        return None, f"monatstag:{int(m.group(1))}"
    if s[:2] in WEEKDAYS:
        return None, f"woche:{WEEKDAYS[s[:2]]}"
    if s in MONTH_END:
        return None, "monat:letzter"
    raise ValueError(f"Unbekannter Rhythmus: {value}")


def rhythm_label(t):
    regel = t.get("regel")
    if regel and regel.startswith("woche:"):
        return WEEKDAY_NAMES[int(regel.split(":")[1])]
    if regel and regel.startswith("monatstag:"):
        return regel.split(":")[1] + "."
    if regel == "monat:letzter":
        return "eom"
    return t.get("rhythm")


def last_day(year, month):
    nxt = datetime(year + (month == 12), month % 12 + 1, 1).date()
    return nxt - timedelta(days=1)


def next_due(item, today_date):
    regel = item.get("regel")
    due = item.get("due_date")
    base = max(today_date, datetime.fromisoformat(due).date()) if due else today_date
    if regel and regel.startswith("woche:"):
        weekday = int(regel.split(":")[1])
        return base + timedelta(days=(weekday - base.weekday()) % 7 or 7)
    if regel and regel.startswith("monatstag:"):
        day = int(regel.split(":")[1])

        def on_day(year, month):
            return datetime(year, month, min(day, last_day(year, month).day)).date()

        candidate = on_day(base.year, base.month)
        if candidate > base:
            return candidate
        return on_day(base.year + (base.month == 12), base.month % 12 + 1)
    if regel == "monat:letzter":
        end = last_day(base.year, base.month)
        if base < end:
            return end
        return last_day(base.year + (base.month == 12), base.month % 12 + 1)
    rhythm = int(item.get("rhythm") or 0)
    return today_date + timedelta(days=rhythm) if rhythm else None


def normalize_subtasks(value):
    """Nimmt Textzeilen oder {id, name, done} an und liefert eine saubere Liste."""
    result = []
    for s in value or []:
        if isinstance(s, str):
            s = {"name": s}
        name = str(s.get("name") or "").strip()
        if name:
            result.append({"id": s.get("id") or uuid.uuid4().hex[:8], "name": name, "done": bool(s.get("done"))})
    return result or None


def parse(body):
    body = dict(body)
    if isinstance(body.get("priorityLevel"), dict):
        body["priority"] = body["priorityLevel"].get("id")
    data = {}
    for k, v in body.items():
        if k not in FIELDS:
            continue
        field = FIELDS[k]
        if field == "subtasks":
            data["subtasks"] = normalize_subtasks(v)
            continue
        if field == "rhythm":
            data["rhythm"], data["regel"] = parse_rhythm(v)
            continue
        if v == "":
            v = None
        elif field in NUMERIC and isinstance(v, str):
            v = int(v)
        elif isinstance(v, float):
            v = Decimal(str(v))
        data[field] = v
    return data


def to_dto(t, user_id, profile):
    prio = int(t["priority"]) if t.get("priority") is not None else None
    return {
        "id": t["id"],
        "userId": {"id": user_id, "name": profile["name"], "default_duration": profile.get("default_duration")},
        "priorityLevel": {"id": prio, "name": PRIORITIES.get(prio)},
        "name": t["name"],
        "duration": t.get("duration"),
        "dueDate": t.get("due_date"),
        "rhythm": rhythm_label(t),
        "today": t.get("today", 0),
        "ordnung": t.get("ordnung"),
        "spontan": t.get("spontan", False),
        "longTerm": t.get("long_term", False),
        "kontext": t.get("kontext", "privat"),
        "deadline": t.get("deadline"),
        "notiz": t.get("notiz"),
        "subtasks": t.get("subtasks") or [],
        "evergreen": bool(t.get("evergreen", False)),
    }


def list_users(p, body):
    profiles = table.scan(FilterExpression=Attr("SK").eq("PROFILE"))["Items"]
    users = [{"id": i["PK"].removeprefix("USER#"), "name": i["name"],
              "default_duration": i.get("default_duration")} for i in profiles]
    name = p.get("user_name")
    if name is None:
        return 200, users
    match = next((u for u in users if u["name"].lower() == name.lower()), None)
    if match is None:
        return 404, {"message": "User not found"}
    return 200, match


def list_tasks(p, body, mode="all"):
    user_id = p["userId"]
    profile = get_profile(user_id)
    if profile is None:
        return 404, {"message": "User not found"}
    tasks = [i for i in query_all(f"USER#{user_id}") if i["SK"].startswith("TASK#")]
    wanted = p.get("kontext") or "privat"
    tasks = [t for t in tasks if t.get("kontext", "privat") == wanted]
    if mode == "today":
        tasks = [t for t in tasks if t.get("today") == 1]
        tasks.sort(key=lambda t: t.get("ordnung", NO_VALUE))
    elif mode == "long":
        tasks = [t for t in tasks if t.get("long_term") and t.get("today") != 1]
        tasks.sort(key=lambda t: t.get("ordnung", NO_VALUE))
    else:
        tasks = [t for t in tasks if not t.get("long_term")]
        tasks.sort(key=lambda t: (t.get("due_date") or "9999-12-31",
                                  int(t.get("priority") or NO_VALUE),
                                  int(t.get("rhythm") or NO_VALUE)))
    return 200, [to_dto(t, user_id, profile) for t in tasks]


def collect(p, body):
    result = collect_for_user(p["userId"], nightly=False)
    if result is None:
        return 404, {"message": "User not found"}
    return 202, result


def create_task(p, body):
    user_id = str(body.get("user_id") or body.get("userId") or "")
    profile = get_profile(user_id)
    if profile is None:
        return 404, {"message": "User not found"}
    data = parse(body)
    if not data.get("name"):
        return 400, {"message": "name is required"}
    existing = [i for i in query_all(f"USER#{user_id}") if i["SK"].startswith("TASK#")]
    max_order = max((i.get("ordnung", 0) for i in existing), default=0)
    task_id = uuid.uuid4().hex
    item = {"today": 0, "spontan": False, "long_term": False, **data,
            **key(user_id, task_id), "id": task_id}
    item.setdefault("ordnung", max_order + 1000)
    if item["spontan"]:
        item["today"] = 1
    item = {k: v for k, v in item.items() if v is not None}
    table.put_item(Item=item)
    return 201, {"message": "Task created successfully", "task": to_dto(item, user_id, profile)}


def get_task(p, body):
    item = get_item(p["userId"], p["taskId"])
    if item is None:
        return 404, {"message": "Task not found"}
    return 200, to_dto(item, p["userId"], get_profile(p["userId"]))


def update_task(p, body):
    item = get_item(p["userId"], p["taskId"])
    if item is None:
        return 404, {"message": "Task not found"}
    item.update(parse(body))
    item = {k: v for k, v in item.items() if v is not None}
    table.put_item(Item=item)
    return 200, to_dto(item, p["userId"], get_profile(p["userId"]))


def delete_task(p, body):
    table.delete_item(Key=key(p["userId"], p["taskId"]))
    return 200, {"message": "Task deleted successfully"}


def count_done(user_id, item):
    """Zählt erledigte private Minuten für den Fortschrittsbalken, pro Tag neu."""
    minutes = int(item.get("duration") or 0)
    if minutes <= 0 or item.get("kontext", "privat") != "privat" or item.get("long_term"):
        return
    prof = get_profile(user_id) or {}
    day = today().isoformat()
    done = int(prof.get("done_minutes", 0)) if prof.get("done_date") == day else 0
    table.update_item(
        Key={"PK": f"USER#{user_id}", "SK": "PROFILE"},
        UpdateExpression="SET done_minutes = :m, done_date = :d",
        ExpressionAttributeValues={":m": done + minutes, ":d": day},
    )


def set_done(p, body):
    item = get_item(p["userId"], p["taskId"])
    if item is None:
        return 404, {"message": "Task not found"}
    count_done(p["userId"], item)
    nxt = None if item.get("spontan") else next_due(item, today())
    if nxt is None:
        table.delete_item(Key=key(p["userId"], p["taskId"]))
    else:
        # Wiederkehrend: nächste Fälligkeit setzen und alle Unteraufgaben zurücksetzen
        expr = "SET due_date = :d, today = :z"
        values = {":d": nxt.isoformat(), ":z": 0}
        if item.get("subtasks"):
            expr += ", subtasks = :s"
            values[":s"] = [{**s, "done": False} for s in item["subtasks"]]
        table.update_item(
            Key=key(p["userId"], p["taskId"]),
            UpdateExpression=expr,
            ExpressionAttributeValues=values,
        )
    return 202, {"message": "Task set to done successfully"}


def toggle_today(p, body):
    item = get_item(p["userId"], p["taskId"])
    if item is None:
        return 404, {"message": "Task not found"}
    new = 0 if item.get("today") == 1 else 1
    table.update_item(Key=key(p["userId"], p["taskId"]),
                      UpdateExpression="SET today = :v", ExpressionAttributeValues={":v": new})
    return 202, {"message": f"Task today set to {new} successfully"}


def shift(days):
    def handler(p, body):
        if get_item(p["userId"], p["taskId"]) is None:
            return 404, {"message": "Task not found"}
        table.update_item(
            Key=key(p["userId"], p["taskId"]),
            UpdateExpression="SET due_date = :d, today = :z",
            ExpressionAttributeValues={":d": (today() + timedelta(days=days)).isoformat(), ":z": 0},
        )
        return 202, {"message": f"Task moved by {days} days"}
    return handler


def get_profile_route(p, body):
    prof = get_profile(p["userId"])
    if prof is None:
        return 404, {"message": "User not found"}
    base = int(prof.get("default_duration", 15))
    maximum = int(prof.get("max_duration", 30))
    return 200, {
        "name": prof["name"],
        "dailyLimit": base,
        "maxLimit": maximum,
        "budgetToday": min(maximum, max(base, int(prof.get("budget", base)))),
        "doneToday": int(prof.get("done_minutes", 0)) if prof.get("done_date") == today().isoformat() else 0,
    }


def put_profile_route(p, body):
    try:
        daily = int(body.get("dailyLimit"))
        maximum = int(body.get("maxLimit"))
    except (TypeError, ValueError):
        return 400, {"message": "Zeitlimits müssen Zahlen sein"}
    if not (1 <= daily <= 240 and daily <= maximum <= 240):
        return 400, {"message": "Limits zwischen 1 und 240, Maximum mindestens so groß wie das tägliche Limit"}
    table.update_item(
        Key={"PK": f"USER#{p['userId']}", "SK": "PROFILE"},
        UpdateExpression="SET default_duration = :d, max_duration = :m",
        ExpressionAttributeValues={":d": daily, ":m": maximum},
        ConditionExpression="attribute_exists(PK)",
    )
    return get_profile_route(p, body)


_LOGIN_CACHE = {}


def user_from_token(event):
    claims = ((((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims")) or {}
    login = (claims.get("cognito:username") or "").lower()
    if not login:
        return None, None
    if login not in _LOGIN_CACHE:
        profiles = table.scan(FilterExpression=Attr("SK").eq("PROFILE"))["Items"]
        match = next((i for i in profiles if i["name"].lower() == login), None)
        _LOGIN_CACHE[login] = match["PK"].removeprefix("USER#") if match else None
    return login, _LOGIN_CACHE[login]


ROUTES = {
    "GET /user": list_users,
    "GET /user/{userId}/profile": get_profile_route,
    "PUT /user/{userId}/profile": put_profile_route,
    "GET /user/{userId}/tasks": list_tasks,
    "GET /user/{userId}/tasks/today": lambda p, b: list_tasks(p, b, mode="today"),
    "GET /user/{userId}/tasks/long": lambda p, b: list_tasks(p, b, mode="long"),
    "PATCH /user/{userId}/tasks/today": collect,
    "POST /task": create_task,
    "GET /user/{userId}/task/{taskId}": get_task,
    "PUT /user/{userId}/task/{taskId}": update_task,
    "DELETE /user/{userId}/task/{taskId}": delete_task,
    "PATCH /user/{userId}/task/{taskId}/done": set_done,
    "PATCH /user/{userId}/task/{taskId}/today": toggle_today,
    "PATCH /user/{userId}/task/{taskId}/tomorrow": shift(1),
    "PATCH /user/{userId}/task/{taskId}/next-week": shift(7),
}


def lambda_handler(event, context):
    handler = ROUTES.get(event.get("routeKey", ""))
    if handler is None:
        status, payload = 404, {"message": "Route not found"}
    else:
        try:
            body = json.loads(event.get("body") or "{}")
            params = {**(event.get("queryStringParameters") or {}), **(event.get("pathParameters") or {})}
            login, uid = user_from_token(event)
            if uid is None or params.get("userId", uid) != uid:
                status, payload = 403, {"message": "Forbidden"}
            else:
                params["userId"] = uid
                params["user_name"] = login
                if isinstance(body, dict):
                    body["user_id"] = uid
                status, payload = handler(params, body)
        except Exception as e:
            print(f"Error: {e}")
            status, payload = 500, {"message": "An error occurred", "error": str(e)}
    return {"statusCode": status, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(payload, default=to_json)}
