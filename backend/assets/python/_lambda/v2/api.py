import difflib
import hashlib
import json
import re
import secrets
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from boto3.dynamodb.conditions import Attr

import media
import push
from collect_today import NO_VALUE, collect_for_user, interval_days, query_all, table

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


# ---------- Siri-Kurzbefehl ----------

MONTHS = {"januar": 1, "jänner": 1, "februar": 2, "märz": 3, "april": 4, "mai": 5, "juni": 6, "juli": 7,
          "august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12}


def parse_deadline(text, today_date):
    """'Steuer bis Freitag' -> ('Steuer', Datum). Wie parseDeadline im Frontend, plus Monatsnamen."""
    m = re.match(r"^(.*\S)\s+bis\s+(?:zum\s+|zur\s+|am\s+)?(.+)$", text, re.IGNORECASE)
    if not m:
        return text, None
    name, when = m.group(1).strip(), m.group(2).strip().lower().rstrip(".")
    d = None
    if when == "heute":
        d = today_date
    elif when == "morgen":
        d = today_date + timedelta(days=1)
    elif when == "übermorgen":
        d = today_date + timedelta(days=2)
    elif re.fullmatch(r"[a-zäöü]+", when) and when[:2] in WEEKDAYS:
        d = today_date + timedelta(days=(WEEKDAYS[when[:2]] - today_date.weekday()) % 7)
    else:
        dm = re.fullmatch(r"(\d{1,2})\.\s*(\d{1,2}|[a-zäöü]+)\.?\s*(\d{2}|\d{4})?", when)
        if dm:
            month = int(dm.group(2)) if dm.group(2).isdigit() else MONTHS.get(dm.group(2))
            year = dm.group(3)
            try:
                if month:
                    y = int(year if not year or len(year) == 4 else "20" + year) if year else today_date.year
                    d = date(y, month, int(dm.group(1)))
                    if not year and d < today_date:
                        d = date(y + 1, month, int(dm.group(1)))
            except ValueError:
                d = None
    if d is None:
        return text, None
    return name, d


def hash_key(key):
    return hashlib.sha256(key.encode()).hexdigest()


def create_quick_key(p, body):
    """Erzeugt einen neuen Schlüssel für den Kurzbefehl, der alte wird ungültig. Nur der Hash wird gespeichert."""
    key = secrets.token_urlsafe(24)
    table.update_item(
        Key={"PK": f"USER#{p['userId']}", "SK": "PROFILE"},
        UpdateExpression="SET quick_key_hash = :h",
        ExpressionAttributeValues={":h": hash_key(key)},
        ConditionExpression="attribute_exists(PK)",
    )
    _KEY_CACHE.clear()
    return 201, {"key": key}


_KEY_CACHE = {}


def user_from_quick_key(key):
    if not key:
        return None
    h = hash_key(key)
    if h not in _KEY_CACHE:
        profiles = table.scan(FilterExpression=Attr("SK").eq("PROFILE"))["Items"]
        match = next((i for i in profiles if secrets.compare_digest(i.get("quick_key_hash", ""), h)), None)
        _KEY_CACHE[h] = match["PK"].removeprefix("USER#") if match else None
    return _KEY_CACHE[h]


def normalize(text):
    text = text.lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(a, b)
    return " ".join(re.findall(r"[a-z0-9]+", text))


def best_match(query, candidates):
    """Sucht den Namen, der am besten zum Gesprochenen passt. Gibt (Treffer, Zweitbester) zurück."""
    q = normalize(query)
    if not q:
        return None, None
    scored = []
    for c in candidates:
        n = normalize(c["name"])
        score = difflib.SequenceMatcher(None, q, n).ratio()
        if q == n:
            score = 2
        elif q in n or n in q:
            score = max(score, 0.85)
        elif set(q.split()) <= set(n.split()):
            score = max(score, 0.8)
        scored.append((score, c))
    scored.sort(key=lambda x: -x[0])
    good = [c for score, c in scored if score >= 0.6]
    if not good:
        return None, None
    top = scored[0]
    runner = scored[1] if len(scored) > 1 and scored[1][0] >= 0.6 and top[0] - scored[1][0] < 0.05 else None
    return top[1], (runner[1] if runner else None)


def join_names(names):
    names = list(names)
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " und " + names[-1]


def open_today(tasks):
    return sorted([t for t in tasks if t.get("today") == 1 and t.get("kontext", "privat") == "privat"],
                  key=lambda t: (int(t.get("priority") or NO_VALUE), t.get("ordnung", NO_VALUE)))


def say_open(tasks, prefix=""):
    rest = open_today(tasks)
    if not rest:
        return prefix + "Heute ist alles erledigt."
    names = [t["name"] for t in rest]
    if len(names) == 1:
        return prefix + f"Noch eine Aufgabe: {names[0]}."
    return prefix + f"Noch {len(names)}: {join_names(names)}."


DONE_WORDS = r"\b(erledigt|fertig|gemacht|abhaken|abgehakt|hake|ab|ist|sind|habe|hab|ich|die|der|das|den)\b"
LIST_PATTERN = r"^(was|welche|wie ?viel|liste|zeig|sag)\b|steht .*an|noch offen|noch zu tun|ansteht"
DONE_PATTERN = r"\b(erledigt|fertig|gemacht|abhaken|abgehakt)\b|^hake\b"
TODAY_PATTERN = r"\b(auf heute|heute|hinzufuegen|hinzu|dazu)\b"


def quick_add(event):
    """POST /quick vom Kurzbefehl. Versteht vier Arten von Sätzen und antwortet mit Text für Siri:

    - "Was steht heute an?"        -> offene private Aufgaben von heute
    - "Küche saugen erledigt"      -> hakt die passende Aufgabe ab
    - "Einkaufen" / "Einkaufen heute" -> passender Evergreen kommt auf heute
    - alles andere                 -> einmalige Aufgabe, optional mit "bis ..."
    """
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    user_id = user_from_quick_key(headers.get("x-quarto-key"))
    if user_id is None:
        return 403, "Schlüssel ungültig. Erzeuge in Quarto unter Konto einen neuen."
    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        body = {"text": event.get("body") or ""}
    text = str(body.get("text") or "").strip().rstrip(".!? ")
    if not text:
        return 400, "Ich habe nichts verstanden."
    plain = normalize(text)
    tasks = [i for i in query_all(f"USER#{user_id}") if i["SK"].startswith("TASK#")]

    # Was steht an?
    if re.search(LIST_PATTERN, plain):
        return 200, say_open(tasks)

    # Abhaken
    if re.search(DONE_PATTERN, plain):
        query = re.sub(r"\s+", " ", re.sub(DONE_WORDS, " ", plain)).strip()
        candidates = open_today(tasks) + [t for t in tasks if t.get("long_term") and t.get("today") != 1
                                          and t.get("kontext", "privat") == "privat"]
        match, other = best_match(query, candidates)
        if match is None:
            return 200, "Dazu finde ich nichts. " + say_open(tasks)
        if other is not None:
            return 200, f"Meinst du {match['name']} oder {other['name']}? Sag es bitte genauer."
        set_done({"userId": user_id, "taskId": match["id"]}, {})
        notify_others(user_id, {})
        remaining = [t for t in tasks if t["id"] != match["id"]]
        return 200, say_open(remaining, prefix=f"{match['name']} ist erledigt. ")

    # Evergreen auf heute
    evergreens = [t for t in tasks if t.get("evergreen")]
    query = re.sub(r"\s+", " ", re.sub(TODAY_PATTERN, " ", plain)).strip()
    match, _ = best_match(query, evergreens) if evergreens else (None, None)
    wants_today = bool(re.search(TODAY_PATTERN, plain))
    if match is not None and (wants_today or normalize(match["name"]) == query):
        if any(t.get("today") == 1 and normalize(t["name"]) == normalize(match["name"]) for t in tasks):
            return 200, f"{match['name']} steht schon auf heute."
        create_task({}, {"user_id": user_id, "name": match["name"], "spontan": True, "kontext": "privat"})
        notify_others(user_id, {})
        return 201, f"{match['name']} steht jetzt auf heute."

    # Sonst: einmalige Aufgabe
    kontext = "privat"
    m = re.match(r"^arbeit\b[\s:,.-]*(.*)$", text, re.IGNORECASE)
    if m:
        kontext, text = "arbeit", m.group(1).strip()
    if not text:
        return 400, "Ich habe nichts verstanden."
    name, deadline = parse_deadline(text, today())
    name = name[:1].upper() + name[1:]
    task_id = uuid.uuid4().hex
    item = {**key(user_id, task_id), "id": task_id, "name": name, "kontext": kontext,
            "long_term": True, "spontan": False, "today": 0,
            "ordnung": max((i.get("ordnung", 0) for i in tasks), default=0) + 1000}
    if deadline:
        item["deadline"] = deadline.isoformat()
    table.put_item(Item=item)
    where = "Arbeit" if kontext == "arbeit" else "Einmalig"
    when = f", bis {deadline.day}.{deadline.month}." if deadline else "."
    return 201, f"{name} steht unter {where}{when}"


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
        "vacationFrom": prof.get("vacation_from"),
        "vacationTo": prof.get("vacation_to"),
        "notifications": push.notifications_of(prof),
    }


def put_profile_route(p, body):
    try:
        daily = int(body.get("dailyLimit"))
        maximum = int(body.get("maxLimit"))
    except (TypeError, ValueError):
        return 400, {"message": "Zeitlimits müssen Zahlen sein"}
    if not (1 <= daily <= 240 and daily <= maximum <= 240):
        return 400, {"message": "Limits zwischen 1 und 240, Maximum mindestens so groß wie das tägliche Limit"}

    # Urlaub: beide Daten oder keins, leer heißt kein Urlaub
    vac_from = body.get("vacationFrom") or None
    vac_to = body.get("vacationTo") or None
    if bool(vac_from) != bool(vac_to):
        return 400, {"message": "Urlaub braucht Start- und Enddatum"}
    if vac_from:
        try:
            if datetime.fromisoformat(vac_from).date() > datetime.fromisoformat(vac_to).date():
                return 400, {"message": "Urlaubsende liegt vor dem Start"}
        except ValueError:
            return 400, {"message": "Urlaubsdaten im Format JJJJ-MM-TT"}
        expr = "SET default_duration = :d, max_duration = :m, vacation_from = :vf, vacation_to = :vt"
        values = {":d": daily, ":m": maximum, ":vf": vac_from, ":vt": vac_to}
    else:
        expr = "SET default_duration = :d, max_duration = :m REMOVE vacation_from, vacation_to"
        values = {":d": daily, ":m": maximum}
    table.update_item(
        Key={"PK": f"USER#{p['userId']}", "SK": "PROFILE"},
        UpdateExpression=expr,
        ExpressionAttributeValues=values,
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


# ---------- Push ----------

def push_key(p, body):
    return 200, {"publicKey": push.vapid_keys()["publicKey"]}


def push_subscribe(p, body):
    sub = body.get("subscription") or {}
    keys = sub.get("keys") or {}
    if not sub.get("endpoint", "").startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        return 400, {"message": "Ungültiges Abo"}
    push.save_subscription(p["userId"], sub)
    return 201, {"ok": True}


def push_unsubscribe(p, body):
    if body.get("endpoint"):
        push.delete_subscription(p["userId"], body["endpoint"])
    return 200, {"ok": True}


def redistribute(p, body):
    """Verteilt überfällige private Aufgaben auf die kommenden Tage.

    Pro Tag kommt höchstens so viel dazu, wie das Tageslimit über dem Bedarf frei lässt
    (mindestens 5 Minuten). Die relativ am längsten überfälligen kommen zuerst dran.
    Aufgaben, die heute schon auf der Liste stehen, bleiben, wie sie sind.
    """
    user_id = p["userId"]
    profile = get_profile(user_id)
    if profile is None:
        return 404, {"message": "User not found"}
    now = today()
    tasks = [i for i in query_all(f"USER#{user_id}") if i["SK"].startswith("TASK#")
             and i.get("kontext", "privat") == "privat"]
    recurring = [t for t in tasks if not t.get("long_term") and not t.get("spontan") and not t.get("evergreen")]
    demand = sum(int(t.get("duration") or 0) / interval_days(t) for t in recurring if interval_days(t))
    spare = max(5, int(profile.get("default_duration", 15)) - demand)

    overdue = [t for t in recurring if t.get("due_date") and t["due_date"] < now.isoformat() and t.get("today") != 1]
    overdue.sort(key=lambda t: -(now - date.fromisoformat(t["due_date"])).days / (interval_days(t) or 7))

    load = {}
    last = now
    for t in overdue:
        minutes = int(t.get("duration") or 0)
        day = 1
        # Erster Tag, an dem die Aufgabe noch in den freien Platz passt; zu große bekommen einen Tag für sich
        while not (load.get(day, 0) + minutes <= spare or load.get(day, 0) == 0):
            day += 1
        load[day] = load.get(day, 0) + minutes
        due = now + timedelta(days=day)
        last = max(last, due)
        table.update_item(Key=key(user_id, t["id"]), UpdateExpression="SET due_date = :d",
                          ExpressionAttributeValues={":d": due.isoformat()})
    return 200, {"moved": len(overdue), "until": last.isoformat() if overdue else None}


def put_notifications(p, body):
    """Benachrichtigungen pro Nutzer: Uhrzeit in 15-Minuten-Schritten, Tage, Inhalt."""
    items = body.get("notifications")
    if not isinstance(items, list) or len(items) > 10:
        return 400, {"message": "Höchstens 10 Benachrichtigungen"}
    clean = []
    for n in items:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(n.get("time") or ""))
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            return 400, {"message": "Uhrzeit im Format HH:MM"}
        minute = int(m.group(2)) - int(m.group(2)) % 15
        if n.get("days") not in push.DAYS or n.get("kind") not in push.KINDS:
            return 400, {"message": "Unbekannte Tage oder unbekannter Inhalt"}
        clean.append({"time": f"{int(m.group(1)):02d}:{minute:02d}", "days": n["days"], "kind": n["kind"]})
    clean.sort(key=lambda n: n["time"])
    table.update_item(
        Key={"PK": f"USER#{p['userId']}", "SK": "PROFILE"},
        UpdateExpression="SET notifications = :n",
        ExpressionAttributeValues={":n": clean},
        ConditionExpression="attribute_exists(PK)",
    )
    return 200, {"notifications": clean}


def push_test(p, body):
    items = query_all(f"USER#{p['userId']}")
    today_iso = today().isoformat()
    message = push.morning_message(items, today_iso) or {
        "title": "Testnachricht", "body": "Funktioniert. Heute steht nichts mit ASAP oder Deadline an.",
        "url": push.APP_URL}
    return 200, {"sent": push.send_to_user(p["userId"], message, items)}


# ---------- Kino & TV ----------

def media_search(p, body):
    q = (p.get("q") or "").strip()
    return 200, media.search(q) if len(q) >= 2 else []


def media_seasons(p, body):
    return 200, media.tv_seasons(int(p["tmdbId"]))


def media_list(p, body):
    return 200, media.list_media(p["userId"])


def media_add(p, body):
    kind = body.get("type")
    if kind not in ("movie", "tv") or not body.get("tmdbId"):
        return 400, {"message": "type movie oder tv und tmdbId nötig"}
    info = media.fetch_info(kind, int(body["tmdbId"]), body.get("season"))
    if kind == "tv" and info.get("season") is None:
        return 400, {"message": "Die Serie hat noch keine Staffel"}
    return 201, media.to_dto(media.store(p["userId"], kind, int(body["tmdbId"]), info))


def media_item(user_id, media_id):
    return table.get_item(Key={"PK": f"USER#{user_id}", "SK": f"MEDIA#{media_id}"}).get("Item")


def media_watched(p, body):
    item = media_item(p["userId"], p["mediaId"])
    if item is None:
        return 404, {"message": "Nicht gefunden"}
    watched = not item.get("watched")
    table.update_item(Key={"PK": item["PK"], "SK": item["SK"]}, UpdateExpression="SET watched = :w",
                      ExpressionAttributeValues={":w": watched})
    return 200, media.to_dto({**item, "watched": watched})


def media_delete(p, body):
    table.delete_item(Key={"PK": f"USER#{p['userId']}", "SK": f"MEDIA#{p['mediaId']}"})
    return 204, {}


def media_refresh(p, body):
    return 200, {"changes": media.refresh_user(p["userId"]), "items": media.list_media(p["userId"])}


ROUTES = {
    "GET /user": list_users,
    "GET /user/{userId}/profile": get_profile_route,
    "PUT /user/{userId}/profile": put_profile_route,
    "POST /user/{userId}/quick-key": create_quick_key,
    "GET /push/key": push_key,
    "POST /user/{userId}/push": push_subscribe,
    "DELETE /user/{userId}/push": push_unsubscribe,
    "POST /user/{userId}/push/test": push_test,
    "PUT /user/{userId}/notifications": put_notifications,
    "POST /user/{userId}/redistribute": redistribute,
    "GET /media/search": media_search,
    "GET /media/tv/{tmdbId}/seasons": media_seasons,
    "GET /user/{userId}/media": media_list,
    "POST /user/{userId}/media": media_add,
    "PATCH /user/{userId}/media/{mediaId}/watched": media_watched,
    "DELETE /user/{userId}/media/{mediaId}": media_delete,
    "POST /user/{userId}/media/refresh": media_refresh,
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


def notify_others(user_id, event):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    try:
        push.notify_status(user_id, exclude_device=headers.get("x-quarto-device"))
    except Exception as e:
        # Eine fehlgeschlagene Mitteilung darf die eigentliche Aktion nie scheitern lassen
        print(f"Push nach Änderung fehlgeschlagen: {e}")


def lambda_handler(event, context):
    if event.get("routeKey") == "POST /quick":
        try:
            status, text = quick_add(event)
        except Exception as e:
            print(f"Error: {e}")
            status, text = 500, "Das hat nicht geklappt."
        return {"statusCode": status, "headers": {"Content-Type": "text/plain; charset=utf-8"}, "body": text}
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
                # Ändert sich die Zahl offener Aufgaben von Heute, bekommen die anderen Geräte eine Mitteilung
                watch = event["routeKey"].split(" ")[0] != "GET" and "/task" in event["routeKey"]
                before = push.open_today_count(query_all(f"USER#{uid}")) if watch else None
                status, payload = handler(params, body)
                if watch and status < 300:
                    after = push.open_today_count(query_all(f"USER#{uid}"))
                    if after != before:
                        notify_others(uid, event)
        except Exception as e:
            print(f"Error: {e}")
            status, payload = 500, {"message": "An error occurred", "error": str(e)}
    return {"statusCode": status, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(payload, default=to_json)}
