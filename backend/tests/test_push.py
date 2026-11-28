import json
import urllib.error
from datetime import datetime

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

import push
from conftest import USER, add_task

REAL_SEND = push.send


def keypair():
    private = ec.generate_private_key(ec.SECP256R1())
    fmt = serialization.PublicFormat.UncompressedPoint
    public = private.public_key().public_bytes(serialization.Encoding.X962, fmt)
    raw_private = private.private_numbers().private_value.to_bytes(32, "big")
    return push.b64u(raw_private), push.b64u(public)


@pytest.fixture
def vapid(monkeypatch):
    private, public = keypair()
    monkeypatch.setattr(push, "vapid_keys", lambda: {"privateKey": private, "publicKey": public})
    return public


def test_base64url_rundreise():
    assert push.unb64u(push.b64u(b"\x00\xffquarto")) == b"\x00\xffquarto"


def test_verschluesseln_liefert_aes128gcm_kopf():
    _, client_public = keypair()
    body = push.encrypt(client_public, push.b64u(b"0123456789abcdef"), b"hallo")
    assert len(body) > 16 + 4 + 1 + 65
    assert body[16:20] == (4096).to_bytes(4, "big")


def test_vapid_header(vapid):
    header = push.vapid_header("https://web.push.apple.com/abc")
    assert header.startswith("vapid t=")
    assert header.endswith(f"k={vapid}")


class FakeResponse:
    status = 201

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_send_erfolg_fehler_und_nur_https(vapid, monkeypatch):
    _, client_public = keypair()
    sub = {"endpoint": "https://push.example/x", "keys": {"p256dh": client_public, "auth": push.b64u(b"a" * 16)}}
    monkeypatch.setattr(push.urllib.request, "urlopen", lambda req, timeout: FakeResponse())
    assert REAL_SEND(sub, {"title": "t"}, "high") == 201

    def gone(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 410, "Gone", {}, None)

    monkeypatch.setattr(push.urllib.request, "urlopen", gone)
    assert REAL_SEND(sub, {"title": "t"}) == 410
    with pytest.raises(ValueError, match="https"):
        REAL_SEND({**sub, "endpoint": "file:///etc/passwd"}, {})


def test_abo_speichern_und_abgelaufene_loeschen(profile, db, monkeypatch):
    push.save_subscription(USER, {"endpoint": "https://a", "keys": {"p256dh": "k", "auth": "a"}})
    push.save_subscription(USER, {"endpoint": "https://b", "keys": {"p256dh": "k", "auth": "a"}})
    monkeypatch.setattr(push, "send", lambda sub, msg, urgency: 410 if sub["endpoint"] == "https://a" else 201)
    assert push.send_to_user(USER, {"title": "x"}) == 1
    assert push.send_to_user(USER, {"title": "x"}, exclude_device=push.device_id("https://b")) == 0
    remaining = [i["endpoint"] for i in push.query_all(f"USER#{USER}") if i["SK"].startswith("PUSH#")]
    assert remaining == ["https://b"]


def test_nachrichten(profile, db):
    today = "2026-11-28"
    items = [
        add_task(db, "a", name="Ofen", priority=1, today=1, duration=10),
        add_task(db, "d", name="Steuer", long_term=True, deadline=today),
        add_task(db, "v", name="Brief", long_term=True, deadline="2026-11-01"),
        add_task(db, "w", name="Bericht", today=1, kontext="arbeit"),
    ]
    morning = push.morning_message(items, today)
    assert morning["title"] == "ASAP: Ofen"
    assert "Deadline heute: Steuer" in morning["body"]
    assert "Deadline verpasst: Brief" in morning["body"]
    assert push.open_message(items)["title"] == "Noch eine Aufgabe · 10 min"
    assert push.effort_message(items)["title"] == "Heute 10 min"
    assert push.build_message("offen", [], today) is None
    assert push.build_message("aufwand", [], today) is None
    assert push.build_message("morgen", [], today) is None
    assert push.open_today_count(items) == 1
    assert push.notifications_of({}) == push.DEFAULT_NOTIFICATIONS


def test_notify_status(profile, db, no_network):
    push.save_subscription(USER, {"endpoint": "https://a", "keys": {"p256dh": "k", "auth": "a"}})
    assert push.notify_status(USER) == 1
    assert no_network[-1]["title"] == "Heute alles erledigt"


class Saturday730(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 11, 28, 7, 35, tzinfo=tz)


def test_lambda_handler_schickt_zur_eingestellten_zeit(profile, db, no_network, monkeypatch):
    monkeypatch.setattr(push, "datetime", Saturday730)
    push.save_subscription(USER, {"endpoint": "https://a", "keys": {"p256dh": "k", "auth": "a"}})
    add_task(db, "a", name="Ofen", priority=1, today=1)
    out = push.lambda_handler({}, None)
    assert json.dumps(out)
    assert no_network
    assert no_network[-1]["title"] == "ASAP: Ofen"


def test_lambda_handler_im_urlaub_still(profile, db, no_network, monkeypatch):
    monkeypatch.setattr(push, "datetime", Saturday730)
    db.update_item(
        Key={"PK": f"USER#{USER}", "SK": "PROFILE"},
        UpdateExpression="SET vacation_from = :f, vacation_to = :t",
        ExpressionAttributeValues={":f": "2026-11-27", ":t": "2026-11-30"},
    )
    push.save_subscription(USER, {"endpoint": "https://a", "keys": {"p256dh": "k", "auth": "a"}})
    add_task(db, "a", name="Ofen", priority=1, today=1)
    push.lambda_handler({}, None)
    assert not no_network
