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
            # "Apple TV Amazon Channel" und Co. sind derselbe Dienst über Amazon, nur Rauschen
            if p.get("provider_name") and "Channel" not in p["provider_name"] and p["provider_name"] not in names:
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
    """Staffeln mit Startdatum. Läuft die Serie noch, kommt die nächste Staffel dazu, auch wenn TMDB
    sie noch nicht kennt. So lassen sich angekündigte Staffeln vormerken, die wöchentliche Prüfung
    trägt das Datum nach, sobald es bekannt ist."""
    data = tmdb(f"/tv/{tmdb_id}")
    seasons = [{"season": s["season_number"], "name": s.get("name"), "airDate": s.get("air_date"),
                "episodes": s.get("episode_count")}
               for s in data.get("seasons", []) if s.get("season_number", 0) > 0]
    if data.get("status") not in ("Ended", "Canceled"):
        nxt = (seasons[-1]["season"] if seasons else 0) + 1
        seasons.append({"season": nxt, "name": f"Staffel {nxt}", "airDate": None, "episodes": None, "announced": True})
    return seasons


# ---------- Release-Infos ----------

def movie_info(tmdb_id):
    """Kinostart und Streamingstart in Deutschland, dazu wo der Film gerade läuft."""
    data = tmdb(f"/movie/{tmdb_id}", append_to_response="release_dates,watch/providers")
    de = next((c for c in (data.get("release_dates") or {}).get("results", []) if c.get("iso_3166_1") == "DE"), None)
    dates = (de or {}).get("release_dates") or []
    # TMDB-Typen: 2 begrenzt im Kino, 3 Kino, 4 digital, 5 DVD/Blu-ray, 6 TV
    # Regulärer Kinostart zählt, begrenzte Starts (Previews, Festivals) nur, wenn es keinen regulären gibt
    cinema = min((d["release_date"][:10] for d in dates if d.get("type") == 3), default=None) \
        or min((d["release_date"][:10] for d in dates if d.get("type") == 2), default=None)
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
        # Kein deutsches Datum: Termin offen. Das weltweite Datum wäre irreführend, der Film läuft hier ja noch nicht
        info.update(releaseDate=None, where="kino", estimated=True)
    return info


def tv_info(tmdb_id, season=None):
    """Erscheinungsdatum einer Staffel und wo die Serie in Deutschland läuft.
    Ohne Staffelangabe die nächste kommende, sonst die neueste."""
    data = tmdb(f"/tv/{tmdb_id}", append_to_response="watch/providers")
    seasons = [s for s in data.get("seasons", []) if s.get("season_number", 0) > 0]
    now = today()
    chosen = None
    if season is not None:
        # Angekündigte Staffel, die TMDB noch nicht kennt: vormerken ohne Datum
        chosen = next((s for s in seasons if s["season_number"] == int(season)), None) \
            or {"season_number": int(season), "name": f"Staffel {int(season)}"}
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


# ---------- Vorschläge ----------

SUGGEST_SK = "MEDIA_SUGGEST"
MAX_SOURCES = 15       # so viele eigene Titel fließen höchstens ein, die neuesten zuerst
SUGGESTIONS = 10


def dismissed(items):
    return {i["SK"].removeprefix("MEDIA_NO#") for i in items if i["SK"].startswith("MEDIA_NO#")}


def candidate_from(r, kind=None):
    kind = kind or r.get("media_type")
    date = r.get("release_date") if kind == "movie" else r.get("first_air_date")
    return {"tmdbId": r["id"], "type": kind, "title": r.get("title") or r.get("name"),
            "year": (date or "")[:4] or None, "poster": poster(r.get("poster_path")),
            "genreIds": r.get("genre_ids") or []}


def compute_suggestions(user_id):
    """Empfehlungen zu den eigenen Titeln plus Trends und kommende Kinostarts, gefiltert auf das,
    was in Deutschland läuft oder ins Kino kommt.

    Punkte: jede Empfehlung zu einem eigenen Titel 1, zu einem geschauten 2, Trend der Woche 0,6,
    bald im Kino 0,5. Je Genre, das in weggeklickten Vorschlägen vorkam, gibt es Abzug.
    """
    from concurrent.futures import ThreadPoolExecutor

    items = query_all(f"USER#{user_id}")
    own = [i for i in items if i["SK"].startswith("MEDIA#")]
    have = {f"{i['kind']}-{int(i['tmdb_id'])}" for i in own}
    no = dismissed(items)
    no_genres = {}
    for i in items:
        if i["SK"].startswith("MEDIA_NO#"):
            for g in i.get("genre_ids") or []:
                no_genres[int(g)] = no_genres.get(int(g), 0) + 1

    sources = sorted(own, key=lambda i: i.get("added", ""), reverse=True)[:MAX_SOURCES]
    scores, reasons, cands = {}, {}, {}

    def add(c, points, reason):
        key = f"{c['type']}-{c['tmdbId']}"
        if key in have or key in no or not c.get("title"):
            return
        cands.setdefault(key, c)
        scores[key] = scores.get(key, 0) + points
        reasons.setdefault(key, [])
        if reason not in reasons[key]:
            reasons[key].append(reason)

    def recs(i):
        try:
            return i, tmdb(f"/{i['kind']}/{int(i['tmdb_id'])}/recommendations").get("results", [])[:10]
        except Exception as e:
            print(f"Empfehlungen {i['SK']}: {e}")
            return i, []

    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, results in pool.map(recs, sources):
            for r in results:
                add(candidate_from(r, i["kind"]), 2 if i.get("watched") else 1, i["title"])
        try:
            for r in tmdb("/trending/all/week").get("results", [])[:20]:
                if r.get("media_type") in ("movie", "tv"):
                    add(candidate_from(r), 0.6, "Trend")
        except Exception as e:
            print(f"Trends: {e}")
        try:
            for r in tmdb("/movie/upcoming", region="DE").get("results", [])[:15]:
                add(candidate_from(r, "movie"), 0.5, "Kino")
        except Exception as e:
            print(f"Kinostarts: {e}")

        for key, c in cands.items():
            penalty = sum(no_genres.get(int(g), 0) for g in c["genreIds"]) * 0.3
            scores[key] -= penalty

        ranked = sorted(cands, key=lambda k: -scores[k])[:SUGGESTIONS * 3]

        def details(key):
            c = cands[key]
            try:
                return key, fetch_info(c["type"], c["tmdbId"])
            except Exception as e:
                print(f"Details {key}: {e}")
                return key, None

        result = []
        for key, info in pool.map(details, ranked):
            if info is None:
                continue
            # Nur was in Deutschland läuft oder einen deutschen Kinostart hat
            if not info.get("providers") and not (info.get("where") == "kino" and info.get("releaseDate")):
                continue
            c = cands[key]
            own_reasons = [r for r in reasons[key] if r not in ("Trend", "Kino")]
            if own_reasons:
                why = "Weil du " + " und ".join(own_reasons[:2]) + " auf der Liste hast"
            elif "Kino" in reasons[key]:
                why = "Bald im Kino"
            else:
                why = "Diese Woche im Trend"
            result.append({**c, "poster": info.get("poster") or c["poster"], "providers": info.get("providers") or [],
                           "releaseDate": info.get("releaseDate"), "where": info.get("where"),
                           "estimated": bool(info.get("estimated")), "season": info.get("season"),
                           "reason": why})
            if len(result) >= SUGGESTIONS:
                break

    table.put_item(Item={"PK": f"USER#{user_id}", "SK": SUGGEST_SK, "computed": today(),
                         "items": json.dumps(result)})
    return result


def suggestions(user_id, force=False):
    """Vorschläge aus dem Speicher, höchstens eine Woche alt, sonst neu berechnet."""
    cached = table.get_item(Key={"PK": f"USER#{user_id}", "SK": SUGGEST_SK}).get("Item")
    if cached and not force:
        age = (datetime.fromisoformat(today()) - datetime.fromisoformat(cached["computed"])).days
        if age < 7:
            items = query_all(f"USER#{user_id}")
            have = {i["SK"].removeprefix("MEDIA#") for i in items if i["SK"].startswith("MEDIA#")}
            no = dismissed(items)
            # Inzwischen Hinzugefügtes oder Weggeklicktes fällt raus
            return [s for s in json.loads(cached["items"])
                    if f"{s['type']}-{s['tmdbId']}" not in no
                    and not any(h == f"{s['type']}-{s['tmdbId']}" or h.startswith(f"{s['type']}-{s['tmdbId']}-")
                                for h in have)]
    return compute_suggestions(user_id)


def dismiss(user_id, kind, tmdb_id, genre_ids):
    table.put_item(Item={"PK": f"USER#{user_id}", "SK": f"MEDIA_NO#{kind}-{int(tmdb_id)}",
                         "genre_ids": [int(g) for g in genre_ids or []], "added": today()})


# ---------- Tägliche und wöchentliche Prüfung ----------

def label(item):
    season = item.get("season")
    return item["title"] + (f" Staffel {int(season)}" if item.get("kind") == "tv" and season is not None else "")


def where_short(item):
    providers = list(item.get("providers") or [])[:2]
    if providers:
        return " bei " + ", ".join(providers)
    return " im Kino" if item.get("where") == "kino" else ""


def short_date(iso):
    y, m, d = (int(x) for x in iso.split("-"))
    return f"{d}.{m}."


def scheduled_handler(event, context):
    """Täglich 9 Uhr deutscher Zeit (EventBridge Scheduler).

    Jeden Tag: Mitteilung für alles Ungeschaute, das heute erscheint.
    Freitags zusätzlich: alle ungeschauten Einträge neu bei TMDB abfragen, über geänderte Termine
    oder neue Dienste informieren und die Vorschläge neu berechnen.
    """
    import push
    from boto3.dynamodb.conditions import Attr

    weekly = bool((event or {}).get("weekly")) or datetime.now(ZoneInfo("Europe/Berlin")).weekday() == 4
    now = today()
    results = {}
    for profile in table.scan(FilterExpression=Attr("SK").eq("PROFILE"))["Items"]:
        user_id = profile["PK"].removeprefix("USER#")
        lines = []
        if weekly:
            for c in refresh_user(user_id):
                name = c["title"] + (f" Staffel {int(c['season'])}" if c.get("season") is not None else "")
                if c["after"] and c["after"] != c["before"] and c["after"] > now:
                    lines.append(f"Neuer Termin: {name} ab {short_date(c['after'])}")
                elif c["providers"] and (not c["after"] or c["after"] <= now):
                    lines.append(f"Jetzt verfügbar: {name} bei {', '.join(c['providers'][:2])}")
            try:
                compute_suggestions(user_id)
            except Exception as e:
                print(f"Vorschläge {user_id}: {e}")
        items = query_all(f"USER#{user_id}")
        for item in items:
            if item["SK"].startswith("MEDIA#") and not item.get("watched") and item.get("release_date") == now:
                line = f"Heute neu: {label(item)}{where_short(item)}"
                if line not in lines:
                    lines.insert(0, line)
        if lines:
            message = {"title": lines[0], "body": "\n".join(lines[1:]), "url": push.APP_URL + "#kino",
                       "tag": "quarto-kino"}
            results[user_id] = push.send_to_user(user_id, message, items)
        else:
            results[user_id] = "nichts"
    print(json.dumps({"weekly": weekly, **results}))
    return results
