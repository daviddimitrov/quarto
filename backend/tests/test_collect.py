from datetime import timedelta

import api
import collect_today
from conftest import USER, add_task


def iso(days=0):
    return (api.today() + timedelta(days=days)).isoformat()


def get(db, tid):
    return db.get_item(Key={"PK": f"USER#{USER}", "SK": f"TASK#{tid}"}).get("Item")


def test_hilfsfunktionen():
    assert collect_today.kontext({}) == "privat"
    assert collect_today.interval_days({"rhythm": 3}) == 3
    assert collect_today.interval_days({}) is None
    today = api.today()
    assert collect_today.overdue_days({"due_date": iso(-4)}, today) == 4
    assert collect_today.is_starving({"due_date": iso(-30), "rhythm": 7}, today)
    assert not collect_today.is_starving({"due_date": iso(), "rhythm": 7}, today)


def test_unbekannter_nutzer():
    assert collect_today.collect_for_user("nix", nightly=True) is None


def test_nacht_sammelt_faelliges_und_raeumt_auf(profile, db):
    add_task(db, "faellig", due_date=iso(-1), duration=5, rhythm=7)
    add_task(db, "zukunft", due_date=iso(5), duration=5, rhythm=7)
    add_task(db, "null", due_date=iso(), duration=0, rhythm=7)
    add_task(db, "spontan", spontan=True, today=1)
    add_task(db, "ever", evergreen=True)
    add_task(db, "pflanze", planta_key="p:watering", today=1, duration=0)
    collect_today.collect_for_user(USER, nightly=True)
    assert get(db, "faellig")["today"] == 1
    assert get(db, "zukunft")["today"] == 0
    assert get(db, "null")["today"] == 1
    assert get(db, "spontan") is None
    assert get(db, "pflanze")["today"] == 1


def test_urlaub_haelt_listen_leer_und_verschiebt_danach(profile, db):
    db.update_item(
        Key={"PK": f"USER#{USER}", "SK": "PROFILE"},
        UpdateExpression="SET vacation_from = :f, vacation_to = :t",
        ExpressionAttributeValues={":f": iso(-5), ":t": iso(-1)},
    )
    add_task(db, "t", due_date=iso(-3), duration=5, rhythm=7)
    result = collect_today.collect_for_user(USER, nightly=True)
    assert result["verschoben"] == 1
    assert get(db, "t")["due_date"] == iso(2)


def test_lambda_handler_nacht_und_manuell(profile, db, monkeypatch):
    import planta

    monkeypatch.setattr(planta, "sync_all", lambda: {})
    add_task(db, "f", due_date=iso(-1), duration=5, rhythm=7)
    out = collect_today.lambda_handler({}, None)
    assert USER in out
    resp = collect_today.lambda_handler({"pathParameters": {"userId": USER}}, None)
    assert resp["statusCode"] == 202
    assert collect_today.lambda_handler({"pathParameters": {"userId": "nix"}}, None)["statusCode"] == 404
