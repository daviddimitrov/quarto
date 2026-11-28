"""Planta: fällige Pflanzenaufgaben (Gießen, Düngen) als ASAP-Aufgaben auf heute.

Öffentliche Planta-API, braucht Planta Premium. Verbunden wird einmalig mit einem Code von
getplanta.com/apps/manage, danach hält ein Refresh-Token den Zugang offen. Besprühen, Reinigen,
Umtopfen und Rückschnitt werden bewusst ignoriert.
"""

import base64
import json
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from boto3.dynamodb.conditions import Attr

from collect_today import query_all, table

API = "https://public.planta-api.com/v1"
AUTH_SK = "PLANTA"
ACTIONS = {"watering": "gießen", "fertilizing": "düngen"}


class PlantaError(Exception):
    def __init__(self, status, message):
        super().__init__(f"Planta {status}: {message}")
        self.status = status


def today():
    return datetime.now(ZoneInfo("Europe/Berlin")).date().isoformat()


def request(method, path, body=None, token=None):
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=headers)  # noqa: S310 - feste https-URL
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - feste https-URL
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            message = json.loads(e.read()).get("message", "")
        except Exception:
            message = ""
        raise PlantaError(e.code, message or e.reason) from e


# ---------- Zugang ----------


def auth_key(user_id):
    return {"PK": f"USER#{user_id}", "SK": AUTH_SK}


def save_tokens(user_id, tokens):
    table.put_item(Item={**auth_key(user_id), "tokens": json.dumps(tokens), "connected": today()})


def connect(user_id, code):
    tokens = request("POST", "/auth/authorize", {"code": code.strip()})["data"]
    save_tokens(user_id, tokens)


def disconnect(user_id):
    table.delete_item(Key=auth_key(user_id))


def is_connected(user_id):
    return "Item" in table.get_item(Key=auth_key(user_id))


def expires_soon(access_token):
    try:
        payload = access_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))["exp"] < time.time() + 60
    except Exception:
        return True


def authorization(user_id):
    item = table.get_item(Key=auth_key(user_id)).get("Item")
    if not item:
        return None
    tokens = json.loads(item["tokens"])
    if expires_soon(tokens["accessToken"]):
        tokens = request("POST", "/auth/refreshToken", {"refreshToken": tokens["refreshToken"]})["data"]
        save_tokens(user_id, tokens)
    return f"{tokens.get('tokenType', 'Bearer')} {tokens['accessToken']}"


# ---------- Abgleich ----------


def plants(auth):
    result, cursor = [], None
    while True:
        page = request("GET", "/addedPlants" + (f"?cursor={cursor}" if cursor else ""), token=auth)
        result += page.get("data", [])
        cursor = (page.get("pagination") or {}).get("nextPage")
        if not cursor:
            return result


def due_actions(plant_list, day):
    """(Schlüssel, Aufgabenname, Pflanzen-ID, Aktion) für alles, was bis heute zu gießen oder düngen ist."""
    for p in plant_list:
        names = p.get("names") or {}
        name = names.get("custom") or names.get("localizedName") or "Pflanze"
        site = (p.get("site") or {}).get("name")
        for action, verb in ACTIONS.items():
            details = (p.get("actions") or {}).get(action)
            date = ((details or {}).get("next") or {}).get("date") if isinstance(details, dict) else None
            if date and date[:10] <= day:
                label = f"{name} {verb}" + (f" · {site}" if site else "")
                yield f"{p['id']}:{action}", label, p["id"], action


def sync_user(user_id):
    """Legt fällige Pflanzenaufgaben an, holt liegengebliebene auf heute und löscht,
    was in Planta nicht mehr fällig ist. None, wenn Planta nicht verbunden ist."""
    auth = authorization(user_id)
    if auth is None:
        return None
    wanted = {k: (label, pid, action) for k, label, pid, action in due_actions(plants(auth), today())}
    tasks = [i for i in query_all(f"USER#{user_id}") if i["SK"].startswith("TASK#")]
    existing = {t["planta_key"]: t for t in tasks if t.get("planta_key")}
    max_order = max((int(t.get("ordnung", 0)) for t in tasks), default=0)
    created = refreshed = removed = 0
    for k, (label, pid, action) in wanted.items():
        t = existing.get(k)
        if t is None:
            max_order += 1000
            task_id = uuid.uuid4().hex
            table.put_item(
                Item={
                    "PK": f"USER#{user_id}",
                    "SK": f"TASK#{task_id}",
                    "id": task_id,
                    "name": label,
                    "kontext": "privat",
                    "priority": 1,
                    "duration": 0,
                    "today": 1,
                    "spontan": False,
                    "long_term": False,
                    "ordnung": max_order,
                    "planta_key": k,
                    "planta_plant": pid,
                    "planta_action": action,
                }
            )
            created += 1
        elif int(t.get("today", 0)) != 1 or t.get("due_date") or t.get("name") != label:
            # Immer auf heute, auch wenn sie gestern verschoben wurde
            table.update_item(
                Key={"PK": t["PK"], "SK": t["SK"]},
                UpdateExpression="SET today = :o, #n = :n REMOVE due_date",
                ExpressionAttributeNames={"#n": "name"},
                ExpressionAttributeValues={":o": 1, ":n": label},
            )
            refreshed += 1
    for k, t in existing.items():
        if k not in wanted:
            table.delete_item(Key={"PK": t["PK"], "SK": t["SK"]})
            removed += 1
    return {"faellig": len(wanted), "neu": created, "aktualisiert": refreshed, "entfernt": removed}


def complete(user_id, item):
    """Hakt die Aktion auch in Planta ab, Planta plant dann den nächsten Termin."""
    auth = authorization(user_id)
    if auth is None:
        return False
    request(
        "POST",
        f"/addedPlants/{item['planta_plant']}/actions/complete",
        {"actionType": item["planta_action"]},
        token=auth,
    )
    return True


def sync_all():
    users = table.scan(FilterExpression=Attr("SK").eq(AUTH_SK))["Items"]
    results = {}
    for u in users:
        uid = u["PK"].removeprefix("USER#")
        try:
            results[uid] = sync_user(uid)
        except Exception as e:
            print(f"Planta-Abgleich {uid} fehlgeschlagen: {e}")
            results[uid] = "fehler"
    return results
