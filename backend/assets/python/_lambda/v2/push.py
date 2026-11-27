"""Web Push ohne Zusatzbibliothek außer cryptography.

Verschlüsselung nach RFC 8291 (aes128gcm), Anmeldung beim Push-Dienst nach RFC 8292 (VAPID).
Die VAPID-Schlüssel liegen als SecureString in SSM, erzeugt mit `npx web-push generate-vapid-keys --json`.
"""
import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

import boto3
from boto3.dynamodb.conditions import Attr

from collect_today import query_all, table

VAPID_PARAM = os.environ.get("VAPID_PARAM", "/quarto/vapid")
VAPID_SUB = os.environ.get("VAPID_SUB", "mailto:d.taureck@gmail.com")
APP_URL = os.environ.get("APP_URL", "https://daviddimitrov.github.io/quarto/")

_vapid = None


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def vapid_keys():
    """{"publicKey": ..., "privateKey": ...} aus SSM, pro Lambda-Instanz gecacht."""
    global _vapid
    if _vapid is None:
        ssm = boto3.client("ssm")
        _vapid = json.loads(ssm.get_parameter(Name=VAPID_PARAM, WithDecryption=True)["Parameter"]["Value"])
    return _vapid


# ---------- Krypto ----------

def encrypt(p256dh, auth, payload):
    """Verschlüsselt payload für ein Abo (RFC 8291). Gibt den fertigen Request-Body zurück."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    as_private = ec.generate_private_key(ec.SECP256R1())
    as_public = as_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    shared = as_private.exchange(ec.ECDH(), ua_key)

    ikm = HKDF(hashes.SHA256(), 32, salt=auth_secret,
               info=b"WebPush: info\x00" + ua_public + as_public).derive(shared)
    salt = os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)

    header = salt + (4096).to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + ciphertext


def vapid_header(endpoint):
    """Authorization-Header mit signiertem JWT für den Push-Dienst des Endpoints."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    keys = vapid_keys()
    url = urllib.parse.urlparse(endpoint)
    claims = {"aud": f"{url.scheme}://{url.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": VAPID_SUB}
    signing_input = (b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode()) + "."
                     + b64u(json.dumps(claims).encode()))
    private = ec.derive_private_key(int.from_bytes(unb64u(keys["privateKey"]), "big"), ec.SECP256R1())
    r, s = decode_dss_signature(private.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    jwt = signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={jwt}, k={keys['publicKey']}"


def send(subscription, message):
    """Schickt eine Nachricht an ein Abo. Gibt den HTTP-Status zurück."""
    body = encrypt(subscription["keys"]["p256dh"], subscription["keys"]["auth"],
                   json.dumps(message).encode())
    request = urllib.request.Request(subscription["endpoint"], data=body, method="POST", headers={
        "Authorization": vapid_header(subscription["endpoint"]),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "43200",
        "Urgency": "normal",
    })
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as e:
        print(f"Push {e.code}: {e.read()[:200]!r}")
        return e.code


# ---------- Abos ----------

def sub_key(user_id, endpoint):
    return {"PK": f"USER#{user_id}", "SK": "PUSH#" + hashlib.sha256(endpoint.encode()).hexdigest()[:32]}


def save_subscription(user_id, subscription):
    table.put_item(Item={**sub_key(user_id, subscription["endpoint"]),
                         "endpoint": subscription["endpoint"],
                         "keys": {"p256dh": subscription["keys"]["p256dh"], "auth": subscription["keys"]["auth"]},
                         "created": datetime.now(ZoneInfo("Europe/Berlin")).isoformat()})


def delete_subscription(user_id, endpoint):
    table.delete_item(Key=sub_key(user_id, endpoint))


def send_to_user(user_id, message, items=None):
    """Schickt an alle Geräte des Nutzers. Abgelaufene Abos (404, 410) werden gelöscht."""
    items = items if items is not None else query_all(f"USER#{user_id}")
    sent = 0
    for sub in [i for i in items if i["SK"].startswith("PUSH#")]:
        status = send(sub, message)
        if status in (404, 410):
            delete_subscription(user_id, sub["endpoint"])
        elif 200 <= status < 300:
            sent += 1
    return sent


# ---------- Morgennachricht ----------

def morning_message(items, today):
    """ASAP-Aufgaben auf heute und Deadlines bis heute. None, wenn nichts ansteht."""
    tasks = [i for i in items if i["SK"].startswith("TASK#")]
    asap = [t["name"] for t in tasks
            if int(t.get("priority") or 0) == 1 and not t.get("long_term")
            and (t.get("today") == 1 or (t.get("due_date") and t["due_date"] <= today))]
    due = [t for t in tasks if t.get("long_term") and t.get("deadline") and t["deadline"] <= today]
    lines = []
    if asap:
        lines.append("ASAP: " + ", ".join(asap))
    if due:
        today_names = [t["name"] for t in due if t["deadline"] == today]
        late_names = [t["name"] for t in due if t["deadline"] < today]
        if today_names:
            lines.append("Deadline heute: " + ", ".join(today_names))
        if late_names:
            lines.append("Deadline verpasst: " + ", ".join(late_names))
    if not lines:
        return None
    # iOS hängt den App-Namen selbst an ("… from Quarto"), deshalb steht der wichtigste Punkt im Titel
    return {"title": lines[0], "body": "\n".join(lines[1:]), "url": APP_URL}


DEFAULT_NOTIFICATIONS = [
    {"time": "07:30", "days": "taeglich", "kind": "morgen"},
    {"time": "19:00", "days": "taeglich", "kind": "offen"},
]
DAYS = {"taeglich": range(7), "werktags": range(5), "wochenende": (5, 6)}
KINDS = ("morgen", "offen")


def notifications_of(profile):
    return profile.get("notifications") or DEFAULT_NOTIFICATIONS


def open_message(items):
    """Offene private Aufgaben von heute. None, wenn alles erledigt ist."""
    open_tasks = sorted([i for i in items if i["SK"].startswith("TASK#") and i.get("today") == 1
                         and i.get("kontext", "privat") == "privat"],
                        key=lambda t: (int(t.get("priority") or 99), t.get("ordnung", 0)))
    if not open_tasks:
        return None
    minutes = sum(int(t.get("duration") or 0) for t in open_tasks)
    count = "Noch eine Aufgabe" if len(open_tasks) == 1 else f"Noch {len(open_tasks)} Aufgaben"
    title = count + (f" · {minutes} min" if minutes else "")
    return {"title": title, "body": ", ".join(t["name"] for t in open_tasks), "url": APP_URL}


def build_message(kind, items, today):
    return open_message(items) if kind == "offen" else morning_message(items, today)


def lambda_handler(event, context):
    """Läuft alle 15 Minuten (EventBridge Scheduler, Europe/Berlin) und schickt,
    was ein Nutzer für dieses Viertelstunden-Fenster eingestellt hat."""
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    slot = f"{now.hour:02d}:{now.minute - now.minute % 15:02d}"
    today = now.date().isoformat()
    profiles = table.scan(FilterExpression=Attr("SK").eq("PROFILE"))["Items"]
    results = {}
    for profile in profiles:
        user_id = profile["PK"].removeprefix("USER#")
        due = [n for n in notifications_of(profile)
               if n.get("time") == slot and now.weekday() in DAYS.get(n.get("days"), ())]
        if not due:
            continue
        if profile.get("vacation_from") and profile.get("vacation_to") \
                and profile["vacation_from"] <= today <= profile["vacation_to"]:
            results[user_id] = "urlaub"
            continue
        items = query_all(profile["PK"])
        sent = []
        for n in due:
            message = build_message(n.get("kind"), items, today)
            sent.append(send_to_user(user_id, message, items) if message else "nichts")
        results[user_id] = sent
    print(json.dumps({"slot": slot, **results}))
    return results
