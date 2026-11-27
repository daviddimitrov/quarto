"""Kino & TV: Filme und Serienstaffeln mit Release-Datum und Streamingdienst in Deutschland.

Die Daten kommen von TMDB (themoviedb.org), die Streaming-Infos dort stammen von JustWatch.
Den API-Lesezugriffs-Token setzt der Deploy-Workflow aus dem GitHub-Secret TMDB_TOKEN als
Umgebungsvariable. Fehlt sie, wird der SecureString /quarto/tmdb aus SSM gelesen.
"""
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

import boto3

from collect_today import query_all, table

TMDB_PARAM = os.environ.get("TMDB_PARAM", "/quarto/tmdb")
API = "https://api.themoviedb.org/3"
IMAGES = "https://image.tmdb.org/t/p/w185"

_token = None


def token():
    global _token
    if _token is None and os.environ.get("TMDB_TOKEN"):
        _token = os.environ["TMDB_TOKEN"].strip()
    if _token is None:
        ssm = boto3.client("ssm")
        _token = ssm.get_parameter(Name=TMDB_PARAM, WithDecryption=True)["Parameter"]["Value"].strip()
    return _token


def tmdb(path, **params):
    query = urllib.parse.urlencode({"language": "de-DE", **params})
    request = urllib.request.Request(f"{API}{path}?{query}", headers={
        "Authorization": f"Bearer {token()}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read())


def today():
    return datetime.now(ZoneInfo("Europe/Berlin")).date().isoformat()


def poster(path):
    return f"{IMAGES}{path}" if path else None


def providers_de(data):
    """Streamingdienste in Deutschland: Abo, kostenlos (Mediatheken) und mit Werbung, ohne Kauf und Leihe."""
    de = (data.get("watch/providers") or {}).get("results", {}).get("DE") or {}
    names = []
    for kind in ("flatrate", "free", "ads"):
        for p in de.get(kind) or []:
            if p.get("provider_name") and p["provider_name"] not in names:
                names.append(p["provider_name"])
    return names


# ---------- Suche ----------

def search(query):
    data = tmdb("/search/multi", query=query, include_adult="false", region="DE")
    results = []
    for r in data.get("results", []):
        if r.get("media_type") not in ("movie", "tv"):
            continue
        date = r.get("release_date") if r["media_type"] == "movie" else r.get("first_air_date")
        results.append({
            "tmdbId": r["id"],
            "type": r["media_type"],
            "title": r.get("title") or r.get("name"),
            "year": (date or "")[:4] or None,
            "poster": poster(r.get("poster_path")),
        })
    return results[:10]


def tv_seasons(tmdb_id):
    data = tmdb(f"/tv/{tmdb_id}")
    return [{"season": s["season_number"], "name": s.get("name"), "airDate": s.get("air_date"),
             "episodes": s.get("episode_count")}
            for s in data.get("seasons", []) if s.get("season_number", 0) > 0]


# ---------- Release-Infos ----------

def movie_info(tmdb_id):
    """Kinostart und Streamingstart in Deutschland, dazu wo der Film gerade läuft."""
    data = tmdb(f"/movie/{tmdb_id}", append_to_response="release_dates,watch/providers")
    de = next((c for c in (data.get("release_dates") or {}).get("results", []) if c.get("iso_3166_1") == "DE"), None)
    dates = (de or {}).get("release_dates") or []
    # TMDB-Typen: 2 begrenzt im Kino, 3 Kino, 4 digital, 5 DVD/Blu-ray, 6 TV
    cinema = min((d["release_date"][:10] for d in dates if d.get("type") in (2, 3)), default=None)
    digital = min((d["release_date"][:10] for d in dates if d.get("type") == 4), default=None)
    providers = providers_de(data)
    info = {
        "title": data.get("title"),
        "poster": poster(data.get("poster_path")),
        "genres": [g["name"] for g in data.get("genres", [])],
        "providers": providers,
        "cinemaDate": cinema,
        "streamDate": digital,
    }
    now = today()
    if providers:
        info.update(releaseDate=digital or cinema or data.get("release_date"), where="stream", estimated=False)
    elif cinema and (not digital or digital > now):
        # Im Kino oder bald im Kino
        info.update(releaseDate=cinema, where="kino", estimated=False)
    elif digital:
        info.update(releaseDate=digital, where="stream", estimated=False)
    else:
        # Kein deutsches Datum bekannt: weltweites Datum als Schätzung
        info.update(releaseDate=data.get("release_date") or None, where="kino", estimated=True)
    return info


def tv_info(tmdb_id, season=None):
    """Erscheinungsdatum einer Staffel und wo die Serie in Deutschland läuft.
    Ohne Staffelangabe die nächste kommende, sonst die neueste."""
    data = tmdb(f"/tv/{tmdb_id}", append_to_response="watch/providers")
    seasons = [s for s in data.get("seasons", []) if s.get("season_number", 0) > 0]
    now = today()
    chosen = None
    if season is not None:
        chosen = next((s for s in seasons if s["season_number"] == int(season)), None)
    if chosen is None:
        upcoming = [s for s in seasons if not s.get("air_date") or s["air_date"] > now]
        chosen = upcoming[0] if upcoming else (seasons[-1] if seasons else None)
    air = (chosen or {}).get("air_date")
    nxt = data.get("next_episode_to_air") or {}
    if chosen and not air and nxt.get("season_number") == chosen["season_number"]:
        air = nxt.get("air_date")
    providers = providers_de(data)
    network = [n["name"] for n in data.get("networks", [])]
    return {
        "title": data.get("name"),
        "poster": poster((chosen or {}).get("poster_path") or data.get("poster_path")),
        "genres": [g["name"] for g in data.get("genres", [])],
        "season": (chosen or {}).get("season_number"),
        "seasonName": (chosen or {}).get("name"),
        "providers": providers or network,
        "releaseDate": air,
        "where": "stream",
        # Das Datum ist meist der weltweite Start, ob Deutschland am selben Tag dran ist, steht erst fest, wenn es läuft
        "estimated": bool(air and air > now) or not providers,
    }


def fetch_info(kind, tmdb_id, season=None):
    return movie_info(tmdb_id) if kind == "movie" else tv_info(tmdb_id, season)


# ---------- Speichern ----------

def media_key(user_id, kind, tmdb_id, season=None):
    suffix = f"-s{season}" if kind == "tv" and season is not None else ""
    return {"PK": f"USER#{user_id}", "SK": f"MEDIA#{kind}-{tmdb_id}{suffix}"}


def store(user_id, kind, tmdb_id, info, watched=False, added=None):
    item = {
        **media_key(user_id, kind, tmdb_id, info.get("season")),
        "tmdb_id": int(tmdb_id),
        "kind": kind,
        "title": info.get("title") or "?",
        "poster": info.get("poster"),
        "genres": info.get("genres") or [],
        "season": info.get("season"),
        "season_name": info.get("seasonName"),
        "providers": info.get("providers") or [],
        "release_date": info.get("releaseDate"),
        "where": info.get("where"),
        "estimated": bool(info.get("estimated")),
        "watched": watched,
        "added": added or today(),
        "checked": datetime.now(ZoneInfo("Europe/Berlin")).isoformat(timespec="minutes"),
    }
    table.put_item(Item={k: v for k, v in item.items() if v is not None})
    return item


def to_dto(item):
    now = today()
    release = item.get("release_date")
    return {
        "id": item["SK"].removeprefix("MEDIA#"),
        "tmdbId": int(item["tmdb_id"]),
        "type": item["kind"],
        "title": item["title"],
        "poster": item.get("poster"),
        "season": int(item["season"]) if item.get("season") is not None else None,
        "seasonName": item.get("season_name"),
        "providers": item.get("providers") or [],
        "releaseDate": release,
        "where": item.get("where"),
        "estimated": bool(item.get("estimated")),
        "watched": bool(item.get("watched")),
        "available": bool(release and release <= now) and not item.get("watched"),
        "added": item.get("added"),
    }


def list_media(user_id):
    return [to_dto(i) for i in query_all(f"USER#{user_id}") if i["SK"].startswith("MEDIA#")]


def refresh_user(user_id):
    """Holt für alle ungeschauten Einträge die aktuellen Daten. Gibt zurück, was sich geändert hat."""
    changes = []
    for item in [i for i in query_all(f"USER#{user_id}") if i["SK"].startswith("MEDIA#") and not i.get("watched")]:
        try:
            info = fetch_info(item["kind"], item["tmdb_id"], item.get("season"))
        except Exception as e:
            print(f"TMDB {item['SK']}: {e}")
            continue
        before = (item.get("release_date"), tuple(item.get("providers") or []))
        stored = store(user_id, item["kind"], item["tmdb_id"], {**info, "season": item.get("season")},
                       added=item.get("added"))
        after = (stored.get("release_date"), tuple(stored.get("providers") or []))
        if before != after:
            changes.append({"title": stored["title"], "season": stored.get("season"),
                            "before": before[0], "after": after[0], "providers": list(after[1])})
    return changes
