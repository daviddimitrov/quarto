import base64
import io
import json
import time
import urllib.error
import urllib.request

import pytest

import planta
from conftest import USER, add_task, call

REAL_REQUEST = planta.request


def jwt(exp):
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


PLANTS = [
    {
        "id": "p1",
        "names": {"custom": "Monstera"},
        "site": {"name": "Wohnzimmer"},
        "actions": {
            "watering": {"next": {"date": "2000-01-01T00:00:00Z"}},
            "fertilizing": {"next": {"date": "2999-01-01"}},
            "misting": {"next": {"date": "2000-01-01"}},
        },
    },
    {"id": "p2", "names": {"localizedName": "Ficus"}, "actions": {"watering": None}},
]


@pytest.fixture
def api_calls(monkeypatch):
    calls = []

    def fake(method, path, body=None, token=None):
        calls.append((method, path, body))
        if path == "/auth/authorize":
            if body["code"] == "falsch":
                raise planta.PlantaError(400, "invalid")
            return {"data": {"accessToken": jwt(time.time() + 3600), "refreshToken": "r", "tokenType": "Bearer"}}
        if path == "/auth/refreshToken":
            return {"data": {"accessToken": jwt(time.time() + 3600), "refreshToken": "r2"}}
        if path == "/addedPlants":
            return {"data": PLANTS[:1], "pagination": {"nextPage": "c2"}}
        if path == "/addedPlants?cursor=c2":
            return {"data": PLANTS[1:]}
        return {}

    monkeypatch.setattr(planta, "request", fake)
    return calls


def tasks(db):
    return [i for i in planta.query_all(f"USER#{USER}") if i["SK"].startswith("TASK#")]


def test_token_ablauf():
    assert planta.expires_soon(jwt(time.time() + 10))
    assert not planta.expires_soon(jwt(time.time() + 3600))
    assert planta.expires_soon("kaputt")


def test_verbinden_abgleichen_trennen(profile, db, api_calls):
    assert call("POST /user/{userId}/planta", {"code": ""})[0] == 400
    assert call("POST /user/{userId}/planta", {"code": "falsch"})[0] == 400
    status, body = call("POST /user/{userId}/planta", {"code": " abc "})
    assert status == 200
    assert body == {"faellig": 1, "neu": 1, "aktualisiert": 0, "entfernt": 0}
    (task,) = tasks(db)
    assert task["name"] == "Monstera gießen · Wohnzimmer"
    assert task["priority"] == 1
    assert task["duration"] == 0
    assert call("GET /user/{userId}/profile")[1]["plantaConnected"] is True
    assert call("DELETE /user/{userId}/planta")[0] == 200
    assert call("POST /user/{userId}/planta/sync")[0] == 404


def test_verschobene_kommt_zurueck_erledigte_verschwindet(profile, db, api_calls):
    planta.connect(USER, "abc")
    planta.sync_user(USER)
    (task,) = tasks(db)
    db.update_item(
        Key={"PK": task["PK"], "SK": task["SK"]},
        UpdateExpression="SET today = :z, due_date = :d",
        ExpressionAttributeValues={":z": 0, ":d": "2999-01-01"},
    )
    assert call("POST /user/{userId}/planta/sync")[1]["aktualisiert"] == 1
    (task,) = tasks(db)
    assert task["today"] == 1
    assert "due_date" not in task
    add_task(db, "alt", planta_key="weg:watering", today=1)
    assert planta.sync_user(USER)["entfernt"] == 1


def test_abhaken_meldet_an_planta(profile, db, api_calls):
    planta.connect(USER, "abc")
    planta.sync_user(USER)
    (task,) = tasks(db)
    assert call("PATCH /user/{userId}/task/{taskId}/done", path={"taskId": task["id"]})[0] == 202
    assert api_calls[-1] == ("POST", "/addedPlants/p1/actions/complete", {"actionType": "watering"})
    assert tasks(db) == []


def test_abhaken_ohne_planta_loescht_trotzdem(profile, db, monkeypatch):
    def down(*a, **k):
        raise planta.PlantaError(503, "down")

    monkeypatch.setattr(planta, "request", down)
    add_task(db, "p", planta_key="p1:watering", planta_plant="p1", planta_action="watering", today=1)
    planta.save_tokens(USER, {"accessToken": jwt(time.time() + 3600), "refreshToken": "r"})
    assert call("PATCH /user/{userId}/task/{taskId}/done", path={"taskId": "p"})[0] == 202
    assert tasks(db) == []
    assert call("POST /user/{userId}/planta/sync")[0] == 502


def test_token_wird_erneuert(profile, db, api_calls):
    planta.save_tokens(USER, {"accessToken": jwt(time.time() - 10), "refreshToken": "r"})
    assert planta.authorization(USER).startswith("Bearer ")
    assert ("POST", "/auth/refreshToken", {"refreshToken": "r"}) in api_calls
    assert planta.complete("niemand", {}) is False


def test_sync_all_faengt_fehler(profile, db, monkeypatch):
    planta.save_tokens(USER, {"accessToken": "x", "refreshToken": "r"})

    def down(*a, **k):
        raise planta.PlantaError(500, "x")

    monkeypatch.setattr(planta, "request", down)
    assert planta.sync_all() == {USER: "fehler"}


def test_request_baut_anfrage_und_fehler(monkeypatch):
    class Resp:
        def __init__(self, raw):
            self.raw = raw

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return self.raw

    seen = []

    def ok(req, timeout):
        seen.append((req.full_url, req.get_method(), req.get_header("Authorization")))
        return Resp(b'{"ok": true}' if "Plants" in req.full_url else b"")

    monkeypatch.setattr(urllib.request, "urlopen", ok)
    assert REAL_REQUEST("GET", "/addedPlants", token="Bearer t") == {"ok": True}
    assert REAL_REQUEST("POST", "/x", {"a": 1}) == {}
    assert seen[0] == ("https://public.planta-api.com/v1/addedPlants", "GET", "Bearer t")

    def fail(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b'{"message": "abgelaufen"}'))

    monkeypatch.setattr(urllib.request, "urlopen", fail)
    with pytest.raises(planta.PlantaError, match="abgelaufen") as err:
        REAL_REQUEST("GET", "/addedPlants")
    assert err.value.status == 401
