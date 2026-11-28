from datetime import date
from decimal import Decimal

import api


def test_parse_rhythm_varianten():
    assert api.parse_rhythm("7") == (7, None)
    assert api.parse_rhythm("") == (None, None)
    assert api.parse_rhythm(None) == (None, None)
    assert api.parse_rhythm("do")[1] is not None
    assert api.parse_rhythm("eom")[1] is not None


def test_next_due_tage_wochentag_monatsende():
    today = date(2026, 11, 28)  # Samstag
    assert api.next_due({"rhythm": 7}, today) == date(2026, 12, 5)
    r, regel = api.parse_rhythm("do")
    assert api.next_due({"rhythm": r, "regel": regel}, today).weekday() == 3
    r, regel = api.parse_rhythm("eom")
    assert api.next_due({"rhythm": r, "regel": regel}, today) == date(2026, 11, 30)
    assert api.next_due({"rhythm": r, "regel": regel}, date(2026, 11, 30)) == date(2026, 12, 31)
    assert api.next_due({}, today) is None


def test_last_day():
    assert api.last_day(2028, 2) == date(2028, 2, 29)
    assert api.last_day(2026, 12) == date(2026, 12, 31)


def test_normalize_subtasks():
    out = api.normalize_subtasks(["  a  ", {"name": "b", "done": True, "id": "x"}, {"name": ""}])
    assert [s["name"] for s in out] == ["a", "b"]
    assert out[1] == {"id": "x", "name": "b", "done": True}
    assert api.normalize_subtasks([]) is None


def test_parse_felder():
    data = api.parse({"name": "Bad", "duration": "10", "dueDate": "", "priorityLevel": {"id": 1}, "x": 1, "f": 1.5})
    assert data["name"] == "Bad"
    assert data["duration"] == 10
    assert data["due_date"] is None
    assert data["priority"] == 1
    assert "x" not in data
    assert api.parse({"ordnung": 1.5})["ordnung"] == Decimal("1.5")


def test_rhythm_label_und_to_json():
    assert api.rhythm_label({"rhythm": 7})
    assert api.to_json(Decimal(3)) == 3
    assert api.to_json(Decimal("1.5")) == 1.5


def test_parse_deadline():
    today = date(2026, 11, 28)
    assert api.parse_deadline("Steuer bis 31.7.", today)[1] == date(2027, 7, 31)
    name, due = api.parse_deadline("Nur ein Name", today)
    assert name == "Nur ein Name"
    assert due is None


def test_best_match_und_join_names():
    tasks = [{"name": "Küche saugen"}, {"name": "Bad putzen"}]
    match, other = api.best_match("kueche", tasks)
    assert match["name"] == "Küche saugen"
    assert other is None
    assert api.join_names(["a", "b", "c"]) == "a, b und c"
    assert api.normalize("Küche!") == "kueche"
