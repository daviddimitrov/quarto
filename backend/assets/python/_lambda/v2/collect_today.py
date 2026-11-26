import json
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import boto3
from boto3.dynamodb.conditions import Attr, Key

table = boto3.resource("dynamodb").Table(os.environ.get("TABLE_NAME", "quarto"))
NO_VALUE = 10**9  # wie NULLS LAST in Postgres


def query_all(pk):
    kwargs = {"KeyConditionExpression": Key("PK").eq(pk)}
    items = []
    while True:
        resp = table.query(**kwargs)
        items += resp["Items"]
        if "LastEvaluatedKey" not in resp:
            return items
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def kontext(t):
    return t.get("kontext", "privat")


def interval_days(t):
    """Rhythmus in Tagen: Zahl wie angegeben, Wochentag 7, Monatsregeln 30."""
    regel = t.get("regel") or ""
    if regel.startswith("woche:"):
        return 7
    if regel.startswith("mon"):
        return 30
    try:
        days = int(t.get("rhythm") or 0)
    except (TypeError, ValueError):
        return None
    return days if days > 0 else None


def overdue_days(t, today_date):
    return (today_date - datetime.fromisoformat(t["due_date"]).date()).days


def is_starving(t, today_date):
    """Hängt zu lange fest: überfällig um den eigenen Rhythmus, höchstens 7 Tage."""
    days = interval_days(t)
    limit = min(days, 7) if days else 7
    return overdue_days(t, today_date) >= limit


def collect_for_user(user_id, nightly):
    pk = f"USER#{user_id}"
    items = query_all(pk)
    profile = next((i for i in items if i["SK"] == "PROFILE"), None)
    if profile is None:
        return None
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    today = now.date().isoformat()
    workday = now.weekday() < 5
    tasks = [i for i in items if i["SK"].startswith("TASK#")]

    base = int(profile.get("default_duration", 15))
    maximum = int(profile.get("max_duration", 30))
    if nightly:
        # Offen gebliebene private Minuten von gestern wandern auf heute, gedeckelt
        open_minutes = sum(
            int(t.get("duration") or 0) for t in tasks
            if kontext(t) == "privat" and t.get("today") == 1
            and not t.get("spontan") and not t.get("long_term")
        )
        budget = min(maximum, base + open_minutes)
        table.update_item(
            Key={"PK": pk, "SK": "PROFILE"},
            UpdateExpression="SET budget = :b",
            ExpressionAttributeValues={":b": budget},
        )
    else:
        budget = min(maximum, max(base, int(profile.get("budget", base))))

    # Private spontane To-dos verfallen nachts, ASAP-Tasks auf Arbeit bleiben bis erledigt
    if nightly:
        expired = [t for t in tasks if t.get("spontan") and kontext(t) == "privat"]
        with table.batch_writer() as batch:
            for t in expired:
                batch.delete_item(Key={"PK": pk, "SK": t["SK"]})
        tasks = [t for t in tasks if t not in expired]

    def is_due(t):
        return (not t.get("spontan") and not t.get("long_term")
                and t.get("due_date") and t["due_date"] <= today)

    # Privat: nach Priorität, Fälligkeit und Rhythmus bis zum Zeitbudget
    private = [t for t in tasks if kontext(t) == "privat" and is_due(t)]
    private.sort(key=lambda t: (
        int(t.get("priority") or NO_VALUE),
        t["due_date"],
        int(t.get("rhythm") or NO_VALUE) if str(t.get("rhythm") or "").isdigit() else NO_VALUE,
    ))
    chosen, total = set(), 0

    # Erst was zu lange festhängt, am stärksten überfällige zuerst. Die erste
    # davon kommt immer rein, damit große Aufgaben nicht ewig hinten runterfallen
    starving = [t for t in private if is_starving(t, now.date())]
    starving.sort(key=lambda t: -overdue_days(t, now.date()) / (interval_days(t) or 7))
    for t in starving:
        d = int(t.get("duration") or 0)
        if not chosen or total + d <= budget:
            total += d
            chosen.add(t["SK"])

    # Dann der Rest nach Priorität, kleine Aufgaben füllen übrige Minuten auf
    for t in private:
        d = int(t.get("duration") or 0)
        if t["SK"] not in chosen and total + d <= budget:
            total += d
            chosen.add(t["SK"])

    # Arbeit: an Werktagen alles Fällige, ohne Budget
    work = [t for t in tasks if kontext(t) == "arbeit" and is_due(t)] if workday else []
    chosen.update(t["SK"] for t in work)

    # Langfristige Tasks zwei Tage vor der Deadline nach oben holen, ohne Budget
    soon = (now.date() + timedelta(days=2)).isoformat()
    deadline_tasks = [
        t for t in tasks
        if t.get("long_term") and t.get("deadline") and t["deadline"] <= soon
        and (kontext(t) == "privat" or workday)
    ]
    chosen.update(t["SK"] for t in deadline_tasks)

    for t in tasks:
        if t.get("spontan"):
            continue
        new = 1 if t["SK"] in chosen else 0
        if int(t.get("today", 0)) != new:
            table.update_item(
                Key={"PK": pk, "SK": t["SK"]},
                UpdateExpression="SET today = :v",
                ExpressionAttributeValues={":v": new},
            )
    return {"selected": len(chosen), "minutes": total, "budget": budget,
            "arbeit": len(work), "deadline": len(deadline_tasks)}


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def lambda_handler(event, context):
    user_id = (event.get("pathParameters") or {}).get("userId")
    if user_id:
        result = collect_for_user(user_id, nightly=False)
        if result is None:
            return response(404, {"message": "User not found"})
        return response(202, result)

    profiles = table.scan(FilterExpression=Attr("SK").eq("PROFILE"))["Items"]
    results = {}
    for p in profiles:
        uid = p["PK"].removeprefix("USER#")
        results[uid] = collect_for_user(uid, nightly=True)
    print(json.dumps(results))
    return results
