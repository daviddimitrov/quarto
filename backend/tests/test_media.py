from datetime import date, timedelta

import pytest

import media
from conftest import USER, call


def iso(days=0):
    return (date.fromisoformat(media.today()) + timedelta(days=days)).isoformat()


def providers(*names):
    return {"watch/providers": {"results": {"DE": {"flatrate": [{"provider_name": n} for n in names]}}}}


def fake_tmdb(path, **params):
    if path == "/search/multi":
        return {
            "results": [
                {"id": 1, "media_type": "tv", "name": "Serie", "first_air_date": "2020-01-01"},
                {"id": 2, "media_type": "movie", "title": "Film", "release_date": "2026-12-01"},
                {"id": 3, "media_type": "person", "name": "Jemand"},
            ]
        }
    if path == "/tv/1":
        return {
            "name": "Serie",
            "status": "Returning Series",
            "genres": [{"id": 18, "name": "Drama"}],
            "seasons": [
                {"season_number": 0, "name": "Specials"},
                {"season_number": 1, "name": "Staffel 1", "air_date": "2020-01-01"},
                {"season_number": 2, "name": "Staffel 2", "air_date": iso(10)},
            ],
            "networks": [{"name": "HBO"}],
            **providers("WOW", "Max"),
        }
    if path == "/movie/2":
        return {
            "title": "Film",
            "genres": [{"id": 18, "name": "Drama"}],
            "release_dates": {
                "results": [
                    {
                        "iso_3166_1": "DE",
                        "release_dates": [
                            {"type": 2, "release_date": iso(1) + "T00:00:00Z"},
                            {"type": 3, "release_date": iso(5) + "T00:00:00Z"},
                        ],
                    }
                ]
            },
        }
    if path == "/movie/4":
        return {"title": "Ohne DE", "release_dates": {"results": []}}
    if path.endswith("/recommendations") or path.startswith(("/discover", "/trending")):
        kind = "movie" if "movie" in path else "tv"
        return {"results": [{"id": 2, "title": "Film", "release_date": iso(5), "genre_ids": [18], "media_type": kind}]}
    if path.startswith("/genre"):
        return {"genres": [{"id": 18, "name": "Drama"}]}
    raise AssertionError(path)


@pytest.fixture(autouse=True)
def tmdb(monkeypatch):
    monkeypatch.setattr(media, "tmdb", fake_tmdb)


def test_anbieter_sortiert_und_vereinheitlicht():
    names = media.providers_de(providers("WOW", "Max", "Netflix Standard with Ads", "Foo Channel"))
    assert names == ["HBO Max", "Netflix", "WOW"]
    assert media.provider_rank("Unbekannt") == 50


def test_suche_und_staffeln():
    assert [r["type"] for r in media.search("x")] == ["tv", "movie"]
    seasons = media.tv_seasons(1)
    assert [s["season"] for s in seasons] == [1, 2, 3]
    assert seasons[-1]["announced"] is True


def test_film_kinostart_regulaer_vor_preview():
    info = media.movie_info(2)
    assert info["releaseDate"] == iso(5)
    assert info["where"] == "kino"
    assert media.movie_info(4)["releaseDate"] is None


def test_serie_naechste_staffel_und_angekuendigte():
    info = media.tv_info(1)
    assert info["season"] == 2
    assert info["providers"][0] == "HBO Max"
    assert media.tv_info(1, season=3)["releaseDate"] is None


def test_routen_anlegen_liste_geschaut_loeschen(profile):
    assert len(call("GET /media/search", query={"q": "Serie"})[1]) == 2
    assert call("GET /media/search", query={"q": "x"})[1] == []
    assert call("GET /media/tv/{tmdbId}/seasons", path={"tmdbId": "1"})[0] == 200
    assert call("POST /user/{userId}/media", {"type": "buch", "tmdbId": 1})[0] == 400
    status, item = call("POST /user/{userId}/media", {"type": "movie", "tmdbId": 2})
    assert status == 201
    assert call("GET /user/{userId}/media")[1][0]["title"] == "Film"
    status, item = call("PATCH /user/{userId}/media/{mediaId}/watched", path={"mediaId": item["id"]})
    assert item["watched"] is True
    assert call("PATCH /user/{userId}/media/{mediaId}/watched", path={"mediaId": "x"})[0] == 404
    assert call("DELETE /user/{userId}/media/{mediaId}", path={"mediaId": item["id"]})[0] == 204


def test_refresh_meldet_aenderungen(profile, db):
    media.store(USER, "tv", 1, {"title": "Serie", "season": 2, "releaseDate": iso(30), "providers": []})
    status, body = call("POST /user/{userId}/media/refresh")
    assert status == 200
    assert body["changes"][0]["after"] == iso(10)


def test_vorschlaege_und_wegklicken(profile, db):
    media.store(USER, "tv", 1, {"title": "Serie", "season": 2, "releaseDate": iso(10), "genres": ["Drama"]})
    status, sugg = call("GET /user/{userId}/media/suggestions", query={"neu": "1"})
    assert status == 200
    assert [s["tmdbId"] for s in sugg] == [2]
    assert call("GET /user/{userId}/media/suggestions")[1] == sugg
    assert call("POST /user/{userId}/media/dismiss", {"type": "x"})[0] == 400
    assert call("POST /user/{userId}/media/dismiss", {"type": "movie", "tmdbId": 2, "genreIds": [18]})[0] == 201
    assert call("GET /user/{userId}/media/suggestions")[1] == []


def test_texte():
    item = {"title": "Serie", "kind": "tv", "season": 2, "providers": ["HBO Max"]}
    assert media.label(item) == "Serie Staffel 2"
    assert media.where_short(item) == " bei HBO Max"
    assert media.where_short({"where": "kino"}) == " im Kino"
    assert media.short_date("2026-12-03") == "3.12."


def test_taeglicher_lauf_meldet_heutige_starts(profile, db, no_network):
    media.store(USER, "movie", 9, {"title": "Heute", "releaseDate": media.today(), "where": "kino"})
    media.store(USER, "tv", 1, {"title": "Serie", "season": 2, "releaseDate": iso(30)})
    import push

    push.save_subscription(USER, {"endpoint": "https://a", "keys": {"p256dh": "k", "auth": "a"}})
    media.scheduled_handler({"weekly": True}, None)
    titles = [m["title"] for m in no_network]
    assert titles == ["Heute neu: Heute im Kino"]
    assert "Neuer Termin: Serie Staffel 2" in no_network[0]["body"]
