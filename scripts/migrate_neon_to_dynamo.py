import os
import boto3
import psycopg2
from boto3.dynamodb.conditions import Key

url = os.environ["DATABASE_URL"].replace("postgresql+psycopg2://", "postgresql://", 1)
table = boto3.resource("dynamodb", region_name="eu-central-1").Table("quarto")

with psycopg2.connect(url) as conn, conn.cursor() as cur:
    cur.execute("select id, name, default_duration from users")
    users = cur.fetchall()
    cur.execute("""select id, user_id, priority_level_id, name, duration,
                          due_date, rhythm, today
                   from tasks order by user_id, id""")
    tasks = cur.fetchall()

def clean(item):
    return {k: v for k, v in item.items() if v is not None}

with table.batch_writer() as batch:
    for uid, name, default_duration in users:
        batch.put_item(Item=clean({
            "PK": f"USER#{uid}", "SK": "PROFILE",
            "name": name, "default_duration": default_duration,
        }))
    rank = {}
    for tid, uid, prio, name, duration, due_date, rhythm, today in tasks:
        rank[uid] = rank.get(uid, 0) + 1000
        batch.put_item(Item=clean({
            "PK": f"USER#{uid}", "SK": f"TASK#{tid}",
            "id": str(tid), "name": name, "duration": duration,
            "due_date": due_date.isoformat() if due_date else None,
            "rhythm": rhythm, "priority": prio, "today": today or 0,
            "ordnung": rank[uid], "spontan": False, "long_term": False,
        }))

for uid, name, _ in users:
    items = table.query(KeyConditionExpression=Key("PK").eq(f"USER#{uid}"))["Items"]
    n_tasks = sum(1 for i in items if i["SK"].startswith("TASK#"))
    print(f"{name}: {n_tasks} Tasks in DynamoDB")
print(f"Neon gesamt: {len(tasks)} Tasks")
