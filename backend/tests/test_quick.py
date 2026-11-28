import json

import api
import collect_today
from conftest import USER, add_task, call


def quick(text, key):
    event = {"routeKey": "POST /quick", "headers": {"X-Quarto-Key": key}, "body": json.dumps({"text": text})}
    resp = api.lambda_handler(event, None)
    return resp["statusCode"], resp["body"]


def make_key(profile):
    return call("POST /user/{userId}/quick-key")[1]["key"]


def all_tasks():
    return [i for i in collect_today.query_all(f"USER#{USER}") if i["SK"].startswith("TASK#")]


def test_falscher_schluessel(profile):
    assert quick("Was steht an?", "falsch")[0] == 403


def test_leer_und_nur_arbeit(profile):
    key = make_key(profile)
    assert quick("", key)[0] == 400
    assert quick("Arbeit", key)[0] == 400


def test_was_steht_an(profile, db):
    key = make_key(profile)
    assert "alles erledigt" in quick("Was steht heute an?", key)[1]
    add_task(db, "k", name="Küche", today=1)
    assert "Küche" in quick("Was steht heute an?", key)[1]


def test_abhaken_eindeutig_mehrdeutig_unbekannt(profile, db):
    key = make_key(profile)
    add_task(db, "k", name="Küche saugen", today=1)
    add_task(db, "a", name="Auto waschen", today=1)
    assert "finde ich nichts" in quick("Steuer erledigt", key)[1]
    status, text = quick("Küche saugen erledigt", key)
    assert status == 200
    assert "ist erledigt" in text
    assert api.get_item(USER, "k") is None
    add_task(db, "b1", name="Bad oben", today=1)
    add_task(db, "b2", name="Bad unten", today=1)
    assert "Meinst du" in quick("Bad erledigt", key)[1]


def test_evergreen_auf_heute(profile, db):
    key = make_key(profile)
    add_task(db, "e", name="Einkaufen", evergreen=True)
    assert quick("Einkaufen", key) == (201, "Einkaufen steht jetzt auf heute.")
    assert "schon auf heute" in quick("Einkaufen heute", key)[1]


def test_einmalig_mit_frist_und_arbeit(profile):
    key = make_key(profile)
    status, text = quick("steuer bis 31.7.", key)
    assert status == 201
    assert text == "Steuer steht unter Einmalig, bis 31.7."
    status, text = quick("Arbeit: Bericht schreiben", key)
    assert "Arbeit" in text
    kontexte = {t["name"]: t["kontext"] for t in all_tasks()}
    assert kontexte == {"Steuer": "privat", "Bericht schreiben": "arbeit"}


def test_kaputter_body_und_fehler(profile, monkeypatch):
    key = make_key(profile)
    event = {"routeKey": "POST /quick", "headers": {"x-quarto-key": key}, "body": "kein json"}
    assert api.lambda_handler(event, None)["statusCode"] == 201

    def boom(e):
        raise RuntimeError

    monkeypatch.setattr(api, "quick_add", boom)
    assert api.lambda_handler(event, None)["statusCode"] == 500


def test_arbeit_nur_als_eigenes_wort(profile):
    key = make_key(profile)
    assert "Einmalig" in quick("Arbeitsvertrag lesen", key)[1]
    assert "Arbeit" in quick("arbeit, Folien bauen", key)[1]
