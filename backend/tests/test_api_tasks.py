from datetime import timedelta

import api
from conftest import USER, add_task, call


def iso(days=0):
    return (api.today() + timedelta(days=days)).isoformat()


def test_ohne_login_oder_fremder_nutzer_verboten(profile):
    assert call("GET /user/{userId}/tasks", login="")[0] == 403
    assert call("GET /user/{userId}/tasks", path={"userId": "fremd"})[0] == 403


def test_unbekannte_route():
    assert call("GET /nichts")[0] == 404


def test_users(profile):
    status, body = call("GET /user")
    assert status == 200
    assert body["name"] == "David"


def test_anlegen_lesen_aendern_loeschen(profile, db):
    status, body = call("POST /task", {"name": "Bad", "duration": 10, "dueDate": iso()})
    assert status == 201
    tid = body["task"]["id"]
    assert call("GET /user/{userId}/task/{taskId}", path={"taskId": tid})[1]["name"] == "Bad"
    status, body = call("PUT /user/{userId}/task/{taskId}", {"name": "Bad putzen"}, path={"taskId": tid})
    assert body["name"] == "Bad putzen"
    assert call("DELETE /user/{userId}/task/{taskId}", path={"taskId": tid})[0] == 200
    assert call("GET /user/{userId}/task/{taskId}", path={"taskId": tid})[0] == 404


def test_anlegen_ohne_name(profile):
    assert call("POST /task", {"duration": 5})[0] == 400


def test_listen_heute_alle_einmalig_arbeit(profile, db):
    add_task(db, "a", today=1, ordnung=2)
    add_task(db, "b", today=1, ordnung=1)
    add_task(db, "c", due_date=iso(3))
    add_task(db, "l", long_term=True)
    add_task(db, "w", today=1, kontext="arbeit")
    assert [t["id"] for t in call("GET /user/{userId}/tasks/today")[1]] == ["b", "a"]
    assert {t["id"] for t in call("GET /user/{userId}/tasks")[1]} == {"a", "b", "c"}
    assert [t["id"] for t in call("GET /user/{userId}/tasks/long")[1]] == ["l"]
    arbeit = call("GET /user/{userId}/tasks/today", query={"kontext": "arbeit"})[1]
    assert [t["id"] for t in arbeit] == ["w"]


def test_erledigen_einmalig_und_wiederkehrend(profile, db):
    add_task(db, "once", today=1, duration=5)
    sub = [{"id": "s", "name": "x", "done": True}]
    add_task(db, "rep", today=1, duration=10, rhythm=7, due_date=iso(), subtasks=sub)
    assert call("PATCH /user/{userId}/task/{taskId}/done", path={"taskId": "once"})[0] == 202
    assert api.get_item(USER, "once") is None
    call("PATCH /user/{userId}/task/{taskId}/done", path={"taskId": "rep"})
    rep = api.get_item(USER, "rep")
    assert rep["due_date"] == iso(7)
    assert rep["today"] == 0
    assert rep["subtasks"][0]["done"] is False
    assert call("GET /user/{userId}/profile")[1]["doneToday"] == 15
    assert call("PATCH /user/{userId}/task/{taskId}/done", path={"taskId": "weg"})[0] == 404


def test_heute_umschalten_und_verschieben(profile, db):
    add_task(db, "t", today=0)
    call("PATCH /user/{userId}/task/{taskId}/today", path={"taskId": "t"})
    assert api.get_item(USER, "t")["today"] == 1
    call("PATCH /user/{userId}/task/{taskId}/tomorrow", path={"taskId": "t"})
    assert api.get_item(USER, "t")["due_date"] == iso(1)
    call("PATCH /user/{userId}/task/{taskId}/next-week", path={"taskId": "t"})
    assert api.get_item(USER, "t")["due_date"] == iso(7)
    assert call("PATCH /user/{userId}/task/{taskId}/today", path={"taskId": "x"})[0] == 404
    assert call("PATCH /user/{userId}/task/{taskId}/tomorrow", path={"taskId": "x"})[0] == 404


def test_ersatz_vorschlaege(profile, db):
    add_task(db, "faellig", due_date=iso(-1), duration=5, priority=2)
    add_task(db, "spaeter", due_date=iso(2), duration=5)
    add_task(db, "zu_lang", due_date=iso(-1), duration=60)
    add_task(db, "heute", due_date=iso(), duration=5, today=1)
    add_task(db, "ever", due_date=iso(-3), duration=5, evergreen=True)
    status, body = call("GET /user/{userId}/tasks/replacements", query={"minutes": "10", "exclude": "x"})
    assert status == 200
    assert [t["id"] for t in body] == ["faellig", "spaeter"]
    assert call("GET /user/{userId}/tasks/replacements", query={"minutes": "abc"})[0] == 200


def test_neu_verteilen(profile, db):
    add_task(db, "alt1", due_date=iso(-10), duration=10, rhythm=7)
    add_task(db, "alt2", due_date=iso(-3), duration=10, rhythm=7)
    status, body = call("POST /user/{userId}/redistribute")
    assert status == 200
    assert body["moved"] == 2
    assert all(api.get_item(USER, t)["due_date"] > iso() for t in ("alt1", "alt2"))


def test_collect_manuell(profile, db):
    add_task(db, "f", due_date=iso(-1), duration=5, rhythm=7)
    status, _ = call("PATCH /user/{userId}/tasks/today")
    assert status == 202
    assert api.get_item(USER, "f")["today"] == 1


def test_profil_lesen_und_schreiben(profile):
    status, body = call("GET /user/{userId}/profile")
    assert body["dailyLimit"] == 15
    assert body["plantaConnected"] is False
    ok = {"dailyLimit": 20, "maxLimit": 40, "vacationFrom": iso(1), "vacationTo": iso(3)}
    status, body = call("PUT /user/{userId}/profile", ok)
    assert status == 200
    assert body["vacationTo"] == iso(3)
    assert call("PUT /user/{userId}/profile", {"dailyLimit": "x", "maxLimit": 1})[0] == 400
    assert call("PUT /user/{userId}/profile", {"dailyLimit": 50, "maxLimit": 40})[0] == 400
    assert call("PUT /user/{userId}/profile", {**ok, "vacationTo": None})[0] == 400
    assert call("PUT /user/{userId}/profile", {**ok, "vacationTo": iso(-5)})[0] == 400
    assert call("PUT /user/{userId}/profile", {**ok, "vacationTo": "kaputt"})[0] == 400
    assert call("PUT /user/{userId}/profile", {"dailyLimit": 20, "maxLimit": 40})[1]["vacationFrom"] is None


def test_benachrichtigungen_speichern(profile):
    good = [{"time": "7:37", "days": "taeglich", "kind": "aufwand"}]
    status, body = call("PUT /user/{userId}/notifications", {"notifications": good})
    assert status == 200
    assert body["notifications"][0]["time"] == "07:30"
    assert call("PUT /user/{userId}/notifications", {"notifications": "x"})[0] == 400
    bad_time = [{"time": "25:00", "days": "taeglich", "kind": "morgen"}]
    assert call("PUT /user/{userId}/notifications", {"notifications": bad_time})[0] == 400
    bad_kind = [{"time": "07:00", "days": "taeglich", "kind": "nix"}]
    assert call("PUT /user/{userId}/notifications", {"notifications": bad_kind})[0] == 400


def test_push_abo_und_test(profile, no_network, db):
    sub = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "k", "auth": "a"}}
    assert call("POST /user/{userId}/push", {"subscription": sub})[0] == 201
    assert call("POST /user/{userId}/push", {"subscription": {"endpoint": "http://x"}})[0] == 400
    assert call("POST /user/{userId}/push/test")[0] == 200
    assert no_network
    assert call("DELETE /user/{userId}/push", {"endpoint": sub["endpoint"]})[0] == 200


def test_aenderung_schickt_status_an_andere_geraete(profile, no_network, db):
    sub = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "k", "auth": "a"}}
    call("POST /user/{userId}/push", {"subscription": sub})
    no_network.clear()
    call("POST /task", {"name": "Neu", "today": 1, "duration": 5})
    assert no_network


def test_fehler_im_handler_wird_500(profile, monkeypatch):
    def boom(p, b):
        raise RuntimeError("kaputt")

    monkeypatch.setitem(api.ROUTES, "GET /user/{userId}/tasks", boom)
    assert call("GET /user/{userId}/tasks")[0] == 500
