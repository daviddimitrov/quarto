import json
import os
from datetime import datetime
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


def collect_for_user(user_id, nightly):
    pk = f"USER#{user_id}"
    items = query_all(pk)
    profile = next((i for i in items if i["SK"] == "PROFILE"), None)
    if profile is None:
        return None
    budget = int(profile.get("default_duration", 15))
    today = datetime.now(ZoneInfo("Europe/Berlin")).date().isoformat()
    tasks = [i for i in items if i["SK"].startswith("TASK#")]

    if nightly:
        with table.batch_writer() as batch:
            for t in tasks:
                if t.get("spontan"):
                    batch.delete_item(Key={"PK": pk, "SK": t["SK"]})
        tasks = [t for t in tasks if not t.get("spontan")]

    candidates = [
        t for t in tasks
        if not t.get("spontan") and not t.get("long_term")
        and t.get("due_date") and t["due_date"] <= today
    ]
    candidates.sort(key=lambda t: (
        int(t.get("priority") or NO_VALUE),
        t["due_date"],
        int(t.get("rhythm") or NO_VALUE),
    ))

    chosen, total = set(), 0
    for t in candidates:
        d = int(t.get("duration") or 0)
        if total + d <= budget:
            total += d
            chosen.add(t["SK"])

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
    return {"selected": len(chosen), "minutes": total, "budget": budget}


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
