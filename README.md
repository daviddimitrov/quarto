# Quarto

Quarto ist meine persönliche To-do-App und der einzige Ort für alle Aufgaben: Haushalt, Arbeit, Einmaliges und Kleinigkeiten, die immer wieder anfallen. Sie ersetzt Telegram-Bot, Microsoft To-Do und die alte Postgres-Version von Quarto.

Die Leitidee kommt vom Vorgänger „Eleven Minutes“: Jeden Tag stellt Quarto eine kleine Liste privater Aufgaben zusammen, die in ein festes Zeitbudget passt. Wer jeden Tag ein paar Minuten investiert, hält den Haushalt sauber, ohne jemals einen Putzmarathon zu brauchen. Dazu kommen die Arbeitsaufgaben, Evergreens, die man mit einem Tipp auf den Tag holt, und eine Liste einmaliger Aufgaben mit optionaler Deadline.

Anforderungen, an denen sich alle Entscheidungen messen:

- **Schnelle Eingabe:** Einmalige To-dos sind mit einer Zeile Text angelegt, Evergreens mit einem Tipp, ohne Dialog.
- **Schnell in der Bedienung:** Optimistic UI, die App reagiert sofort und synchronisiert im Hintergrund.
- **Läuft auf iPhone und Mac:** als PWA auf dem Homescreen und als Dock-App.
- **Kostet unter 1 € im Monat:** komplett serverless, alles im AWS Free Tier oder Cent-Bereich.
- **Ein Nutzer:** Mehrbenutzerfähigkeit ist technisch vorhanden, aber kein Ziel.

## Inhalt

1. [Überblick](#überblick)
2. [Repository](#repository)
3. [Infrastruktur](#infrastruktur)
4. [Authentifizierung](#authentifizierung)
5. [Datenbank](#datenbank)
6. [API](#api)
7. [Fachlogik](#fachlogik)
8. [Collector](#collector)
9. [Frontend](#frontend)
10. [Bedienung](#bedienung)
11. [Entwicklung und Deployment](#entwicklung-und-deployment)
12. [Kosten](#kosten)
13. [Bekannte Grenzen und Ideen](#bekannte-grenzen-und-ideen)

## Überblick

```
iPhone (PWA) / Mac (Dock-App)
        │
        │  HTTPS, statische Dateien
        ▼
GitHub Pages ── frontend/ (HTML, CSS, jQuery)
        │
        │  fetch mit Cognito-ID-Token
        ▼
API Gateway HTTP API ── JWT-Authorizer (Cognito)
        │
        ▼
Lambda ApiFn (api.py) ────────────► DynamoDB Tabelle „quarto“
                                          ▲
EventBridge, täglich 03:00 UTC            │
        │                                 │
        ▼                                 │
Lambda CollectFn (collect_today.py) ──────┤
                                          │
EventBridge Scheduler, alle 15 min       │
        │                                 │
        ▼                                 │
Lambda PushFn (push.py) ──────────────────┘
        │
        ▼
Apple / Google Push-Dienst ──► Service Worker (sw.js) ──► Mitteilung
```

- **Frontend:** statische Seite auf GitHub Pages, ohne Build-Schritt.
- **Backend:** AWS CDK Stack in eu-central-1 mit HTTP API, zwei Python-Lambdas, einer DynamoDB-Tabelle und einem Cognito User Pool.
- **Nachtlauf:** Der Collector stellt jede Nacht die Heute-Liste neu zusammen, berechnet das Budget und räumt die per Evergreen angelegten To-dos auf.
- **Benachrichtigungen:** `push.py` schickt zu den eingestellten Uhrzeiten per Web Push eine Mitteilung, morgens etwa mit ASAP-Aufgaben und Deadlines, abends mit dem, was noch offen ist.

## Repository

```
quarto/
├── README.md                     diese Datei
├── .github/workflows/pages.yml   Deployment des Frontends auf GitHub Pages
├── frontend/
│   ├── index.html                die App
│   ├── login.html                Login-Seite
│   ├── js/main.js                gesamte Frontend-Logik
│   ├── css/main.css              Design „Dicht & dunkel“
│   ├── assets/images/            Favicon, Logo, Apple-Touch-Icon
│   └── bump.sh                   setzt die Cache-Version in den HTML-Dateien
└── backend/
    ├── bin/eleven-minutes.ts     CDK-App, instanziiert den Stack
    ├── lib/eleven-minutes-stack.ts  gesamte Infrastruktur
    ├── assets/python/_lambda/v2/
    │   ├── api.py                REST-API
    │   └── collect_today.py      Collector (Nachtlauf und manuell)
    ├── cdk.json, package.json, tsconfig.json
    └── .venv/                    lokale Python-Umgebung mit boto3 (nicht im Git)
```

Das Backend stammt aus dem früheren Repo `eleven-minutes`. Es wurde per Subtree nach `backend/` übernommen, das alte Repo ist auf GitHub archiviert. Daher heißen Stack und CDK-Dateien noch `ElevenMinutesStack` bzw. `eleven-minutes-*`. Ein Umbenennen würde den Stack in CloudFormation neu anlegen und lohnt sich nicht.

## Infrastruktur

Alles steht in `backend/lib/eleven-minutes-stack.ts`. Der Stack läuft in eu-central-1 (Frankfurt).

### DynamoDB

- Tabelle `quarto`, `TableV2`
- Partition Key `PK` (String), Sort Key `SK` (String)
- On-Demand-Abrechnung, also keine Kosten ohne Zugriffe
- `RemovalPolicy.RETAIN`: Die Tabelle bleibt erhalten, auch wenn der Stack gelöscht wird

### Lambdas

Beide Funktionen nutzen denselben Code-Ordner `assets/python/_lambda/v2`, Python 3.13 auf ARM64 (Graviton, günstiger als x86). Die Umgebungsvariable `TABLE_NAME` zeigt auf die Tabelle.

| Funktion | Handler | Speicher | Timeout | Zweck |
|---|---|---|---|---|
| ApiFn | `api.lambda_handler` | 512 MB | 10 s | alle API-Routen |
| CollectFn | `collect_today.lambda_handler` | 256 MB | 60 s | Nachtlauf |
| PushFn | `push.lambda_handler` | 256 MB | 60 s | Benachrichtigungen |
| MediaFn | `media.scheduled_handler` | 256 MB | 5 min | Kino & TV: tägliche Starts, freitags TMDB-Abgleich |

Alle drei bekommen den Layer `CryptoLayer` mit der Bibliothek `cryptography` für Web Push (`assets/python/layer/requirements.txt`). CDK baut ihn beim Deploy lokal per `python3 -m pip install --platform manylinux2014_aarch64 --only-binary=:all:`, Docker ist dafür nicht nötig. Nur wenn das lokale pip scheitert, fällt CDK auf Docker zurück.

`api.py` importiert `collect_for_user` aus `collect_today.py`, damit die API den Collector auch manuell auslösen kann.

### API Gateway

- HTTP API (v2), günstiger und schneller als REST API
- CORS erlaubt `https://daviddimitrov.github.io` und `http://localhost:8000` für lokale Tests, Methoden `ANY`, Header `Content-Type` und `Authorization`
- Jede Route hängt am `HttpJwtAuthorizer`, ohne gültiges Cognito-Token kommt nichts durch
- Alle Routen zeigen auf dieselbe Lambda-Integration, `api.py` verteilt anhand von `event.routeKey`

### EventBridge

Regel `NightlyCollect` mit `cron(0 3 * * ? *)`, also täglich 03:00 UTC. Das ist 04:00 Uhr deutscher Winterzeit und 05:00 Uhr Sommerzeit. Ziel ist `CollectFn` ohne Pfadparameter, also für alle Nutzer und im Nachtmodus.

### EventBridge Scheduler

Schedule `MorningPush` (der Name stammt noch aus der Zeit mit nur einer Uhrzeit) mit `cron(0/15 * * * ? *)` in der Zeitzone `Europe/Berlin`. `push.py` prüft bei jedem Lauf, welche Nutzer für diese Viertelstunde eine Benachrichtigung eingestellt haben. Die Uhrzeiten gelten also immer in deutscher Zeit, auch über die Zeitumstellung hinweg. Ziel ist `PushFn`, der Scheduler ruft sie über die Rolle `MorningPushRole` auf.

Schedule `MediaDaily` mit `cron(0 9 * * ? *)` in `Europe/Berlin` ruft täglich um 9 Uhr `MediaFn` auf, über dieselbe Rolle.

### SSM Parameter Store

`/quarto/vapid` ist ein SecureString mit den VAPID-Schlüsseln für Web Push als JSON `{"publicKey", "privateKey"}`. Er wird nicht von CDK angelegt, sondern einmalig von Hand, damit der private Schlüssel nie im Repo oder im CloudFormation-Template landet:

```sh
aws ssm put-parameter --name /quarto/vapid --type SecureString --region eu-central-1 \
  --value "$(npx -y web-push generate-vapid-keys --json)"
```

`ApiFn` und `PushFn` dürfen ihn lesen. Ein neuer Schlüssel macht alle bestehenden Abos ungültig, dann muss jedes Gerät Push neu aktivieren.

### TMDB

Kino & TV braucht den API-Lesezugriffs-Token von themoviedb.org (Einstellungen → API → „API Read Access Token“). Er liegt als Secret `TMDB_TOKEN` in GitHub (Settings → Secrets and variables → Actions). Der Backend-Workflow gibt ihn beim Deploy als Umgebungsvariable `TMDB_TOKEN` an `ApiFn` und `PushFn` weiter.

Der Token steht damit im Klartext in der Lambda-Konfiguration und im CloudFormation-Template, sichtbar für jeden mit Zugriff auf das AWS-Konto. Für einen kostenlosen, rein lesenden Token ist das vertretbar, für die VAPID-Schlüssel wäre es das nicht.

Wichtig beim lokalen Deploy: vorher `export TMDB_TOKEN=…` setzen, sonst wird die Variable leer deployt. Dann fällt `media.py` auf den SecureString `/quarto/tmdb` in SSM zurück, falls es ihn gibt, und ohne ihn funktioniert die Suche nicht. Der saubere Weg ist, nur noch über den Workflow zu deployen.

### Cognito

- User Pool `quarto`, Selbstregistrierung aus, Login nur per Benutzername, Groß- und Kleinschreibung egal
- Passwort mindestens 10 Zeichen, keine Wiederherstellung per Mail oder SMS
- App-Client `QuartoWeb` ohne Secret, Flow `USER_PASSWORD_AUTH`
- ID- und Access-Token gelten 1 Stunde, Refresh-Token 365 Tage
- `RETAIN`, der Pool überlebt ein Löschen des Stacks

### Outputs

Nach `cdk deploy` gibt der Stack `ApiUrl`, `UserPoolId` und `UserPoolClientId` aus. Die Werte landen in `cdk-outputs.json` (nicht im Git). API-URL und Client-ID stehen fest im Frontend (`apiPrefix` und `COGNITO_CLIENT_ID` in `main.js`).

## Authentifizierung

### Login

1. `login.html` schickt Name und Passwort direkt an Cognito (`InitiateAuth` mit `USER_PASSWORD_AUTH`). Ein eigenes Backend für den Login gibt es nicht.
2. Cognito liefert ID-Token, Ablaufzeit und Refresh-Token. Die landen im `localStorage` unter `quarto_id_token`, `quarto_token_exp` und `quarto_refresh_token`.
3. Danach fragt das Frontend `GET /user?user_name=…` ab und speichert die interne Nutzer-ID im Cookie `user_id` (365 Tage).

### Token im Alltag

- Jeder Aufruf an die eigene API bekommt `Authorization: Bearer <ID-Token>` (`$.ajaxSetup`). Aufrufe an Cognito selbst bekommen den Header nicht.
- Läuft das Token in weniger als 5 Minuten ab, erneuert die App es beim Start und wenn sie aus dem Hintergrund zurückkommt (`REFRESH_TOKEN_AUTH`).
- Antwortet die API mit 401, wird einmal erneuert und neu geladen, höchstens einmal pro Minute, damit keine Schleife entsteht.
- Lehnt Cognito den Refresh-Token ab (HTTP 400), wird ausgeloggt. Bei Netzfehlern nicht, damit ein Funkloch niemanden rauswirft.
- Gleichzeitige Erneuerungen teilen sich ein Promise, es gibt nie zwei parallele Refresh-Aufrufe.

### Prüfung im Backend

- Der JWT-Authorizer im API Gateway prüft Signatur, Aussteller und Audience (Client-ID).
- `api.py` liest `cognito:username` aus den Claims und sucht das Profil mit diesem Namen (Groß- und Kleinschreibung egal). Die Zuordnung wird pro Lambda-Instanz gecacht.
- Steht in der URL eine andere `userId` als die des Tokens, gibt es 403. Im Body wird `user_id` immer mit der ID aus dem Token überschrieben. So kann niemand fremde Daten lesen oder schreiben, selbst mit gültigem Token.

### Neuen Nutzer anlegen

Selbstregistrierung ist aus. Ein Nutzer braucht zwei Dinge: einen Cognito-User (Konsole oder `aws cognito-idp admin-create-user` und `admin-set-user-password --permanent`) und ein Profil in DynamoDB mit `PK = USER#<id>`, `SK = PROFILE` und `name` gleich dem Cognito-Benutzernamen.

## Datenbank

Single-Table-Design: Alle Daten eines Nutzers liegen unter einem Partition Key, eine Query holt alles. Bei einer Handvoll bis wenigen hundert Aufgaben ist das schneller und billiger als jeder Index.

### Profil

`PK = USER#<id>`, `SK = PROFILE`

| Attribut | Typ | Bedeutung |
|---|---|---|
| `name` | String | Login-Name, muss zum Cognito-User passen |
| `default_duration` | Zahl | tägliches Zeitlimit in Minuten (Konto: „Tägliches Zeitlimit“) |
| `max_duration` | Zahl | Obergrenze inklusive Übertrag (Konto: „Maximal mit Übertrag“) |
| `budget` | Zahl | heutiges Budget, vom Collector jede Nacht berechnet |
| `done_minutes` | Zahl | heute erledigte private Minuten |
| `done_date` | String | Datum, zu dem `done_minutes` gehört, ISO `YYYY-MM-DD` |
| `vacation_from`, `vacation_to` | String | geplanter Urlaub, beide Tage inklusive |
| `notifications` | Liste | `[{time, days, kind}]`, siehe [Benachrichtigungen](#benachrichtigungen). Fehlt sie, gelten 7:30 ASAP und Deadlines und 19:00 Was noch offen ist |
| `quick_key_hash` | String | SHA-256 des Schlüssels für den Siri-Kurzbefehl |

### Aufgabe

`PK = USER#<id>`, `SK = TASK#<uuid>`

| Attribut | Typ | Bedeutung |
|---|---|---|
| `id` | String | UUID ohne Bindestriche, identisch mit dem Teil hinter `TASK#` |
| `name` | String | Titel |
| `kontext` | String | `privat` (Standard) oder `arbeit` |
| `duration` | Zahl | Dauer in Minuten, nur privat |
| `priority` | Zahl | 1 ASAP, 2 Hoch, 3 Mittel, 4 Niedrig, nur privat |
| `due_date` | String | nächste Fälligkeit, ISO |
| `rhythm` | Zahl | Intervall in Tagen, wenn der Rhythmus eine Zahl ist |
| `regel` | String | Kalenderregel statt Intervall, siehe unten |
| `today` | Zahl | 1 = steht auf der Heute- bzw. Arbeit-Liste |
| `ordnung` | Zahl | Sortierschlüssel für Drag & Drop |
| `spontan` | Bool | To-do nur für heute, entsteht aus einem Evergreen |
| `long_term` | Bool | einmalige Aufgabe (in der Oberfläche „Einmalig“, technisch weiter `long_term`) |
| `deadline` | String | Deadline einmaliger Aufgaben, ISO |
| `notiz` | String | Freitext, Links werden im Frontend klickbar |
| `subtasks` | Liste | `[{id, name, done}]` |
| `evergreen` | Bool | Vorlage für immer wieder anfallende Kleinigkeiten |

### Kino & TV

`PK = USER#<id>`, `SK = MEDIA#<movie|tv>-<tmdb-id>[-s<staffel>]`

| Attribut | Typ | Bedeutung |
|---|---|---|
| `tmdb_id`, `kind` | Zahl, String | Titel bei TMDB, `movie` oder `tv` |
| `title`, `poster`, `genres` | | Anzeige, Poster-URL von TMDB, Genres für spätere Vorschläge |
| `season`, `season_name` | | bei Serien die gewählte Staffel |
| `release_date` | String | Kino- oder Streamingstart in Deutschland, bei Staffeln das Startdatum |
| `where` | String | `kino` oder `stream` |
| `providers` | Liste | Streamingdienste in Deutschland (Abo, kostenlos, mit Werbung), bei Serien ohne Daten der Sender |
| `estimated` | Bool | Datum unsicher, etwa weltweiter Start statt deutscher |
| `watched` | Bool | geschaut |
| `added`, `checked` | String | hinzugefügt am, zuletzt bei TMDB abgefragt |

Dazu `SK = MEDIA_NO#<movie|tv>-<tmdb-id>` für weggeklickte Vorschläge mit ihren `genre_ids` und `SK = MEDIA_SUGGEST#v3` mit den zuletzt berechneten Vorschlägen als JSON und dem Datum `computed`.

### Push-Abo

`PK = USER#<id>`, `SK = PUSH#<erste 32 Zeichen des SHA-256 vom Endpoint>`

| Attribut | Typ | Bedeutung |
|---|---|---|
| `endpoint` | String | URL beim Push-Dienst des Geräts (Apple, Google, Mozilla) |
| `keys` | Map | `p256dh` und `auth` des Browsers für die Verschlüsselung |
| `created` | String | Zeitpunkt des Abos |

Ein Eintrag pro Gerät. Antwortet der Push-Dienst mit 404 oder 410, ist das Abo abgelaufen und wird gelöscht.

Leere Werte werden nicht gespeichert, das Attribut fehlt dann einfach.

### Rhythmus und Regeln

Der Rhythmus wird als Text eingegeben und in `rhythm` oder `regel` übersetzt (`parse_rhythm`). In der API kommt er als Text zurück (`rhythm_label`).

| Eingabe | gespeichert | nächste Fälligkeit nach Erledigung |
|---|---|---|
| `7` | `rhythm = 7` | heute + 7 Tage |
| `do` (mo, di, mi, do, fr, sa, so) | `regel = woche:3` | nächster Donnerstag |
| `15.` | `regel = monatstag:15` | nächster 15., in kurzen Monaten der letzte Tag |
| `eom` (auch `monatsende`, `ende`, `letzter`) | `regel = monat:letzter` | nächster Monatsletzter |
| `0` oder leer | nichts | einmalig, wird beim Erledigen gelöscht |

Bei Zahlen zählt das Intervall ab dem Tag des Erledigens, eine verspätet erledigte Aufgabe verschiebt also den Takt. Bei Regeln zählt der Kalender: Ausgangspunkt ist der spätere von heute und dem bisherigen Fälligkeitstag.

### Ordnung

`ordnung` ist ein Gleitkommaschlüssel (Fractional Indexing). Wird eine Aufgabe zwischen zwei andere gezogen, bekommt sie den Mittelwert der Nachbarn, am Rand Nachbar ± 1000. Es muss also immer nur die verschobene Aufgabe gespeichert werden. Neue Aufgaben landen mit höchster Ordnung + 1000 am Ende.

## API

Basis-URL: `https://vs7ubni3p3.execute-api.eu-central-1.amazonaws.com/`. Alle Routen brauchen das ID-Token, Antworten sind JSON.

| Methode und Pfad | Funktion | Beschreibung |
|---|---|---|
| `GET /user?user_name=` | `list_users` | Profil zum Namen, liefert die Nutzer-ID |
| `GET /user/{userId}/profile` | `get_profile_route` | Limits, heutiges Budget, heute erledigte Minuten |
| `PUT /user/{userId}/profile` | `put_profile_route` | Limits und Urlaub setzen |
| `POST /user/{userId}/quick-key` | `create_quick_key` | neuen Schlüssel für den Siri-Kurzbefehl erzeugen |
| `POST /quick` | `quick_add` | Siri-Kurzbefehl, ohne Cognito, siehe unten |
| `GET /media/search?q=` | `media_search` | Filme und Serien bei TMDB suchen |
| `GET /media/tv/{tmdbId}/seasons` | `media_seasons` | Staffeln einer Serie mit Startdatum |
| `GET /user/{userId}/media` | `media_list` | eigene Liste Kino & TV |
| `POST /user/{userId}/media` | `media_add` | hinzufügen, Body `{type, tmdbId, season?}` |
| `PATCH /user/{userId}/media/{mediaId}/watched` | `media_watched` | geschaut umschalten |
| `DELETE /user/{userId}/media/{mediaId}` | `media_delete` | entfernen |
| `POST /user/{userId}/media/refresh` | `media_refresh` | alle ungeschauten Einträge neu bei TMDB abfragen |
| `GET /user/{userId}/media/suggestions` | `media_suggestions` | Vorschläge, höchstens eine Woche alt, mit `?neu=1` frisch berechnet |
| `POST /user/{userId}/media/dismiss` | `media_dismiss` | Vorschlag wegklicken, Body `{type, tmdbId, genreIds}` |
| `GET /push/key` | `push_key` | öffentlicher VAPID-Schlüssel für das Abo im Browser |
| `POST /user/{userId}/push` | `push_subscribe` | Push-Abo speichern, Body `{"subscription": …}` |
| `DELETE /user/{userId}/push` | `push_unsubscribe` | Push-Abo löschen, Body `{"endpoint": …}` |
| `POST /user/{userId}/push/test` | `push_test` | sofort an alle Geräte senden: Morgennachricht oder ein Testtext |
| `POST /user/{userId}/redistribute` | `redistribute` | überfällige private Aufgaben auf die kommenden Tage verteilen |
| `PUT /user/{userId}/notifications` | `put_notifications` | Benachrichtigungen speichern, Body `{"notifications": [...]}` |
| `GET /user/{userId}/tasks?kontext=` | `list_tasks` | alle nicht langfristigen Aufgaben, nach Fälligkeit |
| `GET /user/{userId}/tasks/today?kontext=` | `list_tasks` | Aufgaben mit `today = 1`, nach Ordnung |
| `GET /user/{userId}/tasks/long?kontext=` | `list_tasks` | langfristige ohne `today`, nach Ordnung |
| `PATCH /user/{userId}/tasks/today` | `collect` | Collector sofort laufen lassen (ohne Nachtmodus) |
| `POST /task` | `create_task` | Aufgabe anlegen |
| `GET /user/{userId}/task/{taskId}` | `get_task` | eine Aufgabe |
| `PUT /user/{userId}/task/{taskId}` | `update_task` | Felder ändern, nur die mitgeschickten |
| `DELETE /user/{userId}/task/{taskId}` | `delete_task` | löschen |
| `PATCH /user/{userId}/task/{taskId}/done` | `set_done` | erledigt, siehe Fachlogik |
| `PATCH /user/{userId}/task/{taskId}/today` | `toggle_today` | Heute-Markierung umschalten |
| `PATCH /user/{userId}/task/{taskId}/tomorrow` | `shift(1)` | fällig morgen, runter von heute |
| `PATCH /user/{userId}/task/{taskId}/next-week` | `shift(7)` | fällig in 7 Tagen, runter von heute |

`kontext` ist `privat` (Standard) oder `arbeit`.

### Format einer Aufgabe

```json
{
  "id": "3f2a…",
  "name": "Küche putzen",
  "priorityLevel": { "id": 4, "name": "LOW" },
  "duration": 15,
  "dueDate": "2026-11-27",
  "rhythm": "21",
  "today": 1,
  "ordnung": 3000,
  "spontan": false,
  "longTerm": false,
  "kontext": "privat",
  "deadline": null,
  "notiz": null,
  "subtasks": [{ "id": "a1b2c3d4", "name": "Herd", "done": false }],
  "userId": { "id": "…", "name": "david", "default_duration": 15 }
}
```

### Eingaben

`parse` nimmt camelCase und snake_case an (`dueDate` oder `due_date`, `longTerm` oder `long_term`, `priorityLevel.id` oder `priority_level_id`). Leere Strings werden zu „nicht gesetzt“, Zahlen als Text werden umgewandelt. Unteraufgaben dürfen als Liste von Strings oder als Objekte kommen. Fehlende IDs werden ergänzt, leere Namen fallen weg.

Ein PUT ändert nur die mitgeschickten Felder. Das Frontend schickt beim Abhaken einer Unteraufgabe also nur `{ "subtasks": [...] }`, beim Verschieben nur `{ "ordnung": …, "today": … }`.

### Profil

```json
{ "name": "david", "dailyLimit": 15, "maxLimit": 30, "budgetToday": 18, "doneToday": 4,
  "vacationFrom": "2026-12-20", "vacationTo": "2027-01-03" }
```

`PUT` prüft: beide Limits zwischen 1 und 240, Maximum mindestens so groß wie das Tageslimit. Urlaub braucht beide Daten oder keins, das Ende darf nicht vor dem Start liegen; ohne Daten wird ein bestehender Urlaub entfernt. Sonst gibt es 400 mit deutscher Fehlermeldung.

### Siri-Kurzbefehl

`POST /quick` ist die einzige Route ohne JWT-Authorizer, weil ein Kurzbefehl kein Cognito-Token erneuern kann. Stattdessen prüft `api.py` den Header `X-Quarto-Key`:

- Auf der Konto-Seite erzeugt „Schlüssel erzeugen“ einen zufälligen Schlüssel (`secrets.token_urlsafe`). Gespeichert wird nur sein SHA-256-Hash im Profil, der Schlüssel selbst wird genau einmal angezeigt. Ein neuer Schlüssel macht den alten ungültig.
- Der Kurzbefehl schickt `{"text": "…"}`. `quick_add` erkennt an festen Wörtern, was gemeint ist, und prüft in dieser Reihenfolge:

| Gesagt | Erkannt an | Wirkung | Antwort |
|---|---|---|---|
| „Was steht heute an?“, „Was ist noch offen?“ | Fragewort am Anfang, „steht an“, „noch offen“, „noch zu tun“ | nichts | offene private Aufgaben von heute, ASAP zuerst |
| „Küche erledigt“, „Hake Flur saugen ab“, „Toilette fertig“ | „erledigt“, „fertig“, „gemacht“, „abhaken“, „hake … ab“ | hakt die passende Aufgabe ab | „Küche saugen ist erledigt. Noch 2: …“ |
| „Einkaufen“, „Wäsche heute“, „Müll auf heute“ | Name eines Evergreens, allein oder mit „heute“, „auf heute“, „dazu“, „hinzufügen“ | Evergreen kommt als spontanes To-do auf heute | „Einkaufen steht jetzt auf heute.“ |
| alles andere, „Arbeit …“ für Arbeit | | einmalige Aufgabe, optional mit `bis …` | „Steuer steht unter Einmalig, bis 31.7.“ |

- **Abhaken:** Gesucht wird unter den offenen privaten Aufgaben von heute, danach unter den einmaligen. Verglichen wird ohne Groß- und Kleinschreibung, Umlaute und Füllwörter. Ein Teilwort reicht, „Küche“ findet „Küche saugen“. Passen zwei Aufgaben gleich gut („Saugen erledigt“), fragt Siri nach, statt zu raten. Abgehakt wird wie in der App, mit nächster Fälligkeit und gezählten Minuten, aber ohne Rückgängig.
- **Deadlines:** wie im Einmalig-Feld `bis …`, zusätzlich Diktatformen wie „bis zum 3. Dezember“ und „bis 15. März 2027“. Satzzeichen, die Siri anhängt, werden entfernt.
- **Antwort:** immer reiner Text mit Status 200, den der Kurzbefehl anzeigt bzw. Siri vorliest. So klappt die Bedienung auch nur mit Kopfhörern.

Einrichtung in der Kurzbefehle-App: Kurzbefehl „Quarto“ mit den Aktionen *Nach Eingabe fragen* (Text), *Inhalte von URL abrufen* (POST auf `<ApiUrl>/quick`, Header `X-Quarto-Key`, JSON-Feld `text` = *Bereitgestellte Eingabe*) und *Ergebnis anzeigen*. Die Konto-Seite zeigt die Schritte samt URL beim Erzeugen des Schlüssels.

### Web Push

`push.py` kommt ohne Push-Bibliothek aus, nur mit `cryptography`:

- **Verschlüsselung (RFC 8291, aes128gcm):** pro Nachricht ein neues P-256-Schlüsselpaar, ECDH mit dem Schlüssel des Browsers, HKDF mit dessen `auth`-Secret, AES-128-GCM. Der Body besteht aus Salt, Record-Größe, eigenem öffentlichem Schlüssel und Ciphertext.
- **Anmeldung (RFC 8292, VAPID):** ein mit ES256 signiertes JWT mit `aud` = Origin des Push-Dienstes, `exp` = 12 Stunden, `sub` = Kontakt-Mail. Dazu der öffentliche Schlüssel im Header `Authorization: vapid t=…, k=…`.
- **Versand** per `urllib` mit `TTL` 12 Stunden und `Urgency: high`, damit Apple sofort zustellt. Mit `normal` darf der Push-Dienst Nachrichten bündeln und um Minuten verzögern. Ein ausgeschaltetes Handy bekommt die Nachricht also noch bis zum Abend.

### Fehler

404 bei unbekannter Route, Aufgabe oder Profil, 403 bei fremder Nutzer-ID, 500 mit Fehlertext bei Ausnahmen. Die Ausnahme landet zusätzlich in CloudWatch Logs.

## Fachlogik

### Vier Arten von Aufgaben

**Wiederkehrend:** der Normalfall im Haushalt. Hat Fälligkeit, Rhythmus, Dauer und Priorität. Der Collector holt sie auf die Heute-Liste, wenn sie fällig sind und ins Budget passen.

**Spontan:** Entsteht nur noch per Tipp auf einen Evergreen-Chip, ein eigenes Eingabefeld gibt es nicht mehr. Steht sofort auf heute (`today = 1`), hat keine Dauer und keinen Rhythmus und verfällt nachts, ob erledigt oder nicht. Ältere spontane Aufgaben auf Arbeit bleiben, bis sie erledigt sind.

**Einmalig:** Wird über das Einmalig-Feld angelegt, optional mit Deadline. Im Code und in der Datenbank heißt das weiterhin `long_term` bzw. „langfristig“. Steht in der eigenen Liste unter Heute und hat keine Fälligkeit. Per Drag & Drop wandert sie auf heute und zurück. Zwei Tage vor der Deadline holt der Collector sie automatisch auf heute.

**Evergreen:** Vorlage für Dinge ohne Termin, die immer wieder anfallen: Einkaufen, Wäsche, Gießen, Müll, Duschen. Evergreens werden in Alle (Privat) in einer eigenen Sektion gepflegt. Auf der Heute-Seite stehen sie als Chips ganz unten, unter Heute und Einmalig. Ein Tipp legt ein spontanes To-do mit demselben Namen an, ohne Dauer. Wie jedes private spontane To-do verfällt es nachts, die Vorlage bleibt. Der Chip ist grau, solange ein To-do mit diesem Namen auf heute steht. Der Collector ignoriert Evergreens.

### Priorität

ASAP, Hoch, Mittel und Niedrig steuern die Reihenfolge im Collector. ASAP ist für Dinge wie „Kontaktlinsen wechseln“, die am Fälligkeitstag auf jeden Fall drankommen sollen: Sie stehen in der Sortierung vor allem anderen und bekommen ihre Minuten zuerst.

### Privat und Arbeit

Jede Aufgabe hat einen Kontext.

- **Privat:** mit Dauer, Priorität und Zeitbudget, an allen sieben Tagen.
- **Arbeit:** ohne Dauer, Priorität und Budget. An Werktagen (Mo–Fr) kommt alles Fällige auf die Arbeit-Liste, am Wochenende nichts. Beispiele: Outlook aufräumen alle 7 Tage, Snapshot alle 30 Tage, Staffit und Core Weekly.

Die Listen sind komplett getrennt: Heute zeigt nur Privates, Arbeit nur Arbeit, Alle hat einen Umschalter.

### Erledigen

`set_done`:

1. Ist die Aufgabe privat, nicht langfristig und hat eine Dauer, werden ihre Minuten auf `done_minutes` des Profils addiert. Ist `done_date` nicht heute, beginnt der Zähler bei null.
2. Spontane Aufgaben und solche ohne nächste Fälligkeit (einmalig, langfristig) werden gelöscht.
3. Wiederkehrende bekommen die nächste Fälligkeit, `today = 0` und alle Unteraufgaben wieder auf offen.

Unteraufgaben werden nie automatisch erledigt, auch wenn alle abgehakt sind. Die Hauptaufgabe hakt man selbst ab.

### Nicht heute, morgen, nächste Woche

- **Nicht heute:** schaltet nur `today` um, die Fälligkeit bleibt. Die Aufgabe kann also morgen wieder auftauchen.
- **Morgen / Nächste Woche:** setzt die Fälligkeit auf heute + 1 bzw. + 7 und `today = 0`.

### Budget und Übertrag

- **Tägliches Zeitlimit** (`default_duration`): so viele private Minuten plant der Collector pro Tag ein.
- **Übertrag:** Bleiben abends geplante private Minuten offen, kommen sie auf das Budget des nächsten Tages: `budget = min(Maximum, Tageslimit + offene Minuten)`. So rutscht ein schlechter Tag nicht einfach weg, kann sich aber auch nicht endlos aufstauen.
- **Maximum** (`max_duration`): Deckel für das Budget mit Übertrag.

Spontane und langfristige Aufgaben zählen weder zum Budget noch zum Übertrag.

### Rückstand neu verteilen

Liegt mehr überfällig, als der Puffer zwischen Bedarf und Limit in absehbarer Zeit abbaut, zeigt die Konto-Seite unter dem Bedarf die Anzahl überfälliger Aufgaben und ihre Minuten, dazu den Knopf „Neu verteilen“. `redistribute`:

- nimmt alle überfälligen privaten wiederkehrenden Aufgaben, die nicht schon heute auf der Liste stehen
- sortiert sie nach relativem Rückstand, also überfälligen Tagen geteilt durch Rhythmus
- verteilt sie ab morgen auf die folgenden Tage: Pro Tag kommt höchstens so viel dazu, wie das Tageslimit über dem Bedarf frei lässt, mindestens 5 Minuten. Eine größere Aufgabe bekommt einen Tag für sich.
- setzt dafür nur `due_date`. Ab dem neuen Tag ist die Aufgabe normal fällig und läuft durch den Collector.

Nichts gilt als erledigt, nur die Fälligkeiten rücken. Bei Wochentags- und Monatsregeln stimmt der Tag dadurch einmal nicht, nach dem nächsten Erledigen wieder. Der Knopf lässt sich jederzeit erneut drücken, zum Beispiel nach Krankheit.

### Urlaub

Auf der Konto-Seite trägt man Urlaub von–bis ein. Er gilt für Privat und Arbeit.

- **Während des Urlaubs** setzt der Collector jede Nacht alle Aufgaben auf `today = 0`. Heute und Arbeit bleiben leer, Deadlines werden nicht hochgeholt, es gibt keinen Übertrag. Heute und Arbeit zeigen einen Hinweis mit dem Enddatum, schon vor dem Urlaub einen mit dem Zeitraum.
- **In der ersten Nacht danach** rückt `shift_after_vacation` alles nach hinten, was bis zum letzten Urlaubstag fällig war. Intervall-Aufgaben rücken um die Urlaubstage, Wochentagsregeln um volle Wochen, damit der Wochentag stimmt. Monatsregeln bleiben und stehen danach höchstens einmal überfällig da. Deadlines einmaliger Aufgaben bleiben, das sind echte Termine. Danach wird der Urlaub aus dem Profil gelöscht.
- **Früher zurück:** Enddatum auf gestern setzen, dann wird in der nächsten Nacht um die tatsächlichen Tage verschoben. Wird der Urlaub ganz gelöscht, wird nichts verschoben.

### Benachrichtigungen

Auf der Konto-Seite stellt man bis zu zehn Benachrichtigungen ein. Jede hat:

- **Uhrzeit** in 15-Minuten-Schritten. Andere Minuten rundet die API ab.
- **Tage:** `taeglich`, `werktags` (Mo–Fr) oder `wochenende` (Sa–So)
- **Inhalt:**
  - `morgen` („ASAP und Deadlines“): private ASAP-Aufgaben, die heute auf der Liste stehen oder fällig sind, einmalige Aufgaben mit Deadline heute und solche mit verpasster Deadline
  - `offen` („Was noch offen ist“): alle offenen privaten Aufgaben von heute, ASAP zuerst, mit Summe der Minuten, etwa „Noch 3 Aufgaben · 12 min“
  - `aufwand` („Aufwand heute“): nur die Summe der Minuten der offenen privaten Aufgaben von heute, etwa „Heute 95 min“

Die Einstellungen gelten für alle Geräte, Push selbst wird pro Gerät aktiviert. Es kommt nur eine Mitteilung, wenn es etwas zu sagen gibt, und im Urlaub nie. Die erste Zeile ist der Titel, der Rest der Text. iOS zeigt den App-Namen selbst an („… from Quarto“), deshalb steht im Titel nicht noch einmal „Quarto“. Ein Tipp auf die Mitteilung öffnet Quarto.

### Kino & TV

Eigene Seite für Filme und Serien, die man sehen will. Sie ist bewusst getrennt von den Aufgaben: kein Budget, kein Collector.

- **Hinzufügen:** Oben suchen, TMDB liefert Treffer mit Jahr und Typ. Ein Film wird direkt hinzugefügt. Bei einer Serie wählt man die Staffel, die nächste kommende ist vorausgewählt. Läuft die Serie noch, gibt es zusätzlich die nächste Staffel als „angekündigt“, auch wenn TMDB sie noch nicht kennt. Sie steht dann unter Termin offen, bis die Prüfung ein Datum findet.
- **Release-Infos** (`media.py`): Bei Filmen zählen die deutschen Einträge von TMDB: regulärer Kinostart (Typ 3, nur ohne ihn der begrenzte Start Typ 2 wie Previews) und digitaler Start (Typ 4). Gibt es keinen deutschen Eintrag, ist der Termin offen. Das weltweite Datum wird bewusst nicht genommen, weil der Film hier dann noch gar nicht läuft. Läuft der Film schon bei einem Streamingdienst, steht der Dienst da, sonst „Kino ab …“. Bei Staffeln das Startdatum der Staffel und die Dienste der Serie in Deutschland. Das Datum ist meist der weltweite Start, deshalb steht bei kommenden Staffeln „voraussichtlich“. Die Streaming-Infos stammen bei TMDB von JustWatch und umfassen auch die Mediatheken von ARD, ZDF und Arte. Kauf und Leihe zählen nicht, „with Ads“-Varianten werden mit dem Dienst zusammengefasst, Amazon-Channels wie „Apple TV Amazon Channel“ auch nicht, weil sie nur denselben Dienst über Amazon anbieten. Die Dienste werden sortiert: erst die eigenen Abos (HBO Max, Netflix, Prime Video, Disney+, Apple TV+, Paramount+, Mediatheken), WOW/Sky zuletzt. Laufende HBO-Serien wie House of the Dragon oder The Last of Us gibt es seit dem HBO-Max-Start im Januar 2026 oft bei beiden. Angezeigt werden bis zu drei Dienste.
- **Gruppen:** Jetzt verfügbar (erschienen, aber noch nicht geschaut), Demnächst (nach Datum), Termin offen, Geschaut (eingeklappt).
- **Abhaken** markiert als geschaut, ein zweiter Tipp nimmt das zurück. Das x entfernt den Eintrag.
- **Daten aktualisieren** fragt alle ungeschauten Einträge neu bei TMDB ab und zeigt, was sich geändert hat.
- **Vorschläge** unten auf der Seite (`compute_suggestions`): nur was **diesen oder nächsten Monat** in Deutschland startet, sortiert nach dem, was zur eigenen Liste passt.
  - Kandidaten: TMDB-Empfehlungen zu den 15 zuletzt hinzugefügten eigenen Titeln, deutsche Kinostarts und Streamingstarts im Zeitraum (`/discover`, je zwei Seiten), Serien mit Folgen im Zeitraum bei einem deutschen Dienst, dazu die Trends der Woche.
  - Behalten wird, was im Zeitraum in Deutschland ins Kino kommt oder bei einem Dienst startet. Bei Serien muss eine Staffel im Zeitraum beginnen und die Serie bei einem deutschen Dienst laufen. Alte Serien wie Game of Thrones fallen damit raus, ebenso Serien, die nur bei einem US-Sender laufen.
  - Punkte: Empfehlung zu einem eigenen Titel 1, zu einem geschauten 2, je Genre, das auf der eigenen Liste vorkommt, 0,2 (höchstens 0,6), Trend 0,4, Beliebtheit im Zeitraum bis 0,5. Je Genre aus weggeklickten Vorschlägen 0,3 Abzug. Was schon auf der Liste steht oder weggeklickt wurde, fällt raus.
  - Jede Karte nennt den Grund („Weil du House of the Dragon auf der Liste hast“, „Neu im Dezember“). „Hinzufügen“ übernimmt den Titel, bei Serien mit Staffelauswahl. „Nicht interessiert“ blendet ihn für immer aus.
  - Berechnet wird höchstens einmal pro Woche und freitags automatisch, das Ergebnis liegt unter `MEDIA_SUGGEST#v3`. Der Pfeil neben der Überschrift rechnet sofort neu. Geprüft werden zuerst die deutschen Starts aus Discover, dann die übrigen Kandidaten nach Punkten, in Runden zu 16 und höchstens 96, bis zehn Vorschläge zusammen sind. Empfohlene Filme, die weltweit vor über einem Jahr gestartet sind, fallen schon vorher raus. Ohne diese Reihenfolge verdrängen die vielen älteren Empfehlungen zu eigenen Titeln die neuen Starts, und die Liste bleibt leer. Die TMDB-Abfragen laufen parallel, `ApiFn` hat dafür 25 Sekunden Zeit.
- **Automatische Prüfung** (`scheduled_handler`, täglich 9 Uhr):
  - Jeden Tag kommt eine Mitteilung für alles Ungeschaute, das heute erscheint, etwa „Heute neu: Severance Staffel 3 bei Apple TV“.
  - Freitags werden zusätzlich alle ungeschauten Einträge neu bei TMDB abgefragt. Hat sich ein Termin verschoben, ist ein angekündigter Termin dazugekommen oder läuft etwas jetzt bei einem Dienst, steht das mit in der Mitteilung („Neuer Termin: House of the Dragon Staffel 4 ab 14.6.“, „Jetzt verfügbar: … bei Netflix“). Danach werden die Vorschläge neu berechnet.
  - Gibt es nichts zu melden, kommt nichts. Ein Tipp auf die Mitteilung öffnet Kino & TV.

### Fortschritt

Der Balken auf der Heute-Seite zeigt das Budget minus die noch offenen Minuten, zum Beispiel `1 / 18 min · +3 Übertrag`. Was der Collector nicht verplanen konnte, zählt also von Anfang an als geschafft: Morgens steht der Balken schon leicht gefüllt, mit jedem Haken wächst er, und sind alle Aufgaben mit Dauer erledigt, ist er voll. Berechnet wird er im Frontend aus der Heute-Liste, er stimmt deshalb auf allen Geräten nach dem nächsten Sync. Liegen mehr offene Minuten als Budget auf heute, etwa durch eine hochgezogene Aufgabe, beginnt er bei 0.

`done_minutes` im Profil zählt weiterhin die erledigten privaten Minuten pro Tag, wird für den Balken aber nicht mehr gebraucht.

### Bedarf

Die Konto-Seite rechnet aus, wie viele Minuten pro Tag die wiederkehrenden privaten Aufgaben im Schnitt brauchen: Summe aus Dauer geteilt durch Rhythmus in Tagen. Wochentage zählen als 7 Tage, Monatsregeln als 30,44. Spontane, langfristige und einmalige Aufgaben zählen nicht mit.

Liegt der Bedarf über dem Tageslimit, wächst der Rückstand zwangsläufig. Dann wird die Zahl orange, und ein Link setzt das Limit auf den aufgerundeten Bedarf. Darunter stehen die acht teuersten Aufgaben, bei denen ein längerer Rhythmus am meisten bringt. Die Berechnung läuft komplett im Frontend auf Basis von `GET /tasks`.

## Collector

`collect_today.py`, Funktion `collect_for_user(user_id, nightly)`. Er läuft nachts für alle Nutzer (`nightly = True`) und auf Anfrage über `PATCH /tasks/today` für einen Nutzer (`nightly = False`).

### Ablauf

1. **Budget:** Nachts werden die offenen privaten Minuten von gestern gezählt: `today = 1`, nicht spontan, nicht langfristig. Daraus wird das neue Budget berechnet und gespeichert. Tagsüber wird das gespeicherte Budget nur gelesen.
2. **Aufräumen:** Nachts werden alle privaten spontanen To-dos gelöscht. Ist ein Urlaub vorbei, werden die Fälligkeiten verschoben, siehe [Urlaub](#urlaub).
3. **Fällige private Aufgaben:** nicht spontan, nicht langfristig, mit `due_date <= heute`.
4. **Auswahl privat**, in zwei Durchgängen:
   - **Festhängende zuerst:** Eine Aufgabe hängt fest, wenn sie um ihren eigenen Rhythmus überfällig ist, höchstens aber 7 Tage. Bei „alle 2 Tage“ reichen also 2 Tage, bei „alle 21 Tage“ 7 Tage. Sie werden nach relativem Rückstand sortiert (überfällige Tage geteilt durch Rhythmus). Die erste kommt immer rein, auch wenn sie allein das Budget füllt, die weiteren nur, wenn sie noch passen. Ohne diesen Durchgang kämen große Aufgaben mit niedriger Priorität nie dran, weil kleinere oder wichtigere fast immer vorher das Budget belegen.
   - **Dauer 0:** Fällige Aufgaben mit Dauer 0 kommen immer auf Heute, auch wenn das Budget schon voll ist. Das ist für Dinge gedacht, die am Fälligkeitstag auf jeden Fall dran sein sollen, aber keine Zeit im Budget brauchen.
   - **Dann der Rest:** sortiert nach Priorität, Fälligkeit und Rhythmus (kurzer Rhythmus zuerst). Jede Aufgabe, die noch ins Budget passt, kommt rein. Danach wird weitergesucht, sodass kleine Aufgaben übrige Minuten auffüllen.
5. **Urlaub:** Läuft ein Urlaub, bleibt die Auswahl für Privat, Arbeit und Deadlines leer.
6. **Arbeit:** an Werktagen alle fälligen Arbeitsaufgaben, ohne Budget.
7. **Deadlines:** langfristige Aufgaben mit Deadline in höchstens zwei Tagen. Private immer, Arbeit nur an Werktagen, beide ohne Budget.
8. **Schreiben:** Für jede nicht spontane Aufgabe wird `today` auf 1 oder 0 gesetzt, aber nur wenn sich der Wert ändert. Spontane behalten ihr `today`.

Rückgabe: Anzahl ausgewählter Aufgaben, verplante Minuten, Budget, Anzahl Arbeit und Deadline.

### Was der Collector bewusst nicht tut

- Er verschiebt keine Fälligkeiten. Eine überfällige Aufgabe bleibt überfällig, bis sie erledigt oder verschoben ist. Rückstand soll sichtbar bleiben.
- Er rührt manuelle Änderungen bis zur nächsten Nacht nicht an, solange niemand `PATCH /tasks/today` aufruft. Wer tagsüber eine Aufgabe auf heute zieht, behält sie.

## Frontend

Vanilla JavaScript mit jQuery 3.6, jQuery Cookie und SortableJS 1.15.6, alles vom CDN. Icons sind Bootstrap Icons, Schrift Geist und Geist Mono von Google Fonts. Es gibt kein Framework, keinen Build-Schritt und kein npm. Die drei Dateien `index.html`, `main.js` und `main.css` sind die ganze App.

### Design „Dicht & dunkel“

Inspiriert von Linear und Raycast: dunkler Hintergrund, dichte Zeilen, Zahlen in Monospace, Farbe nur als Signal.

| Rolle | Farbe |
|---|---|
| Hintergrund | `#0D0E10` |
| Seitenleiste | `#0A0B0C` |
| Flächen | `#15161A`, `#17181B` |
| Rahmen | `#24262A` |
| Text | `#E7E8EB` |
| gedämpft | `#9A9DA5`, `#6E717A` |
| Akzent, erledigt, Fortschritt | `#4ADE80` |
| überfällig, Deadline bald | `#F08C5A` |

Alle Werte stehen als CSS-Variablen in `:root`.

### Layout

- **iPhone (unter 900 px):** oben eine Umschaltleiste Heute / Arbeit / Alle und ein Konto-Knopf, darunter Budgetzeile, die Liste, die einklappbare Einmalig-Liste und ganz unten die Evergreen-Chips (nur Heute). Zeilen sind 44 px hoch, Eingabefelder nutzen 16 px Schrift, damit Safari nicht zoomt. Safe-Area-Abstände für Notch und Home-Indicator sind eingerechnet.
- **Mac (ab 900 px):** links eine Seitenleiste mit Navigation, Zählern, Budget und Konto. Rechts Heute und Einmalig nebeneinander, Einmalig als eigenes Panel. Zeilen sind 40 px hoch, „⋯“ und Griff erscheinen beim Überfahren, Unteraufgaben stehen in zwei Spalten.

### Ansichten

- **Heute:** private Aufgaben mit `today = 1`, darunter bzw. daneben Einmalig, ganz unten die Evergreen-Chips.
- **Arbeit:** Arbeitsaufgaben mit `today = 1`, darunter bzw. daneben die einmaligen Arbeitsaufgaben.
- **Alle:** alle nicht langfristigen Aufgaben eines Kontexts mit Fälligkeit, Rhythmus, Dauer und Prioritätspunkt. Der Umschalter Privat/Arbeit wird gemerkt. Bei Privat folgt darunter die Sektion Evergreens mit eigenem Eingabefeld. Menü: Heute, Umbenennen, Löschen; ein Tipp auf den Namen benennt um.
- **Konto:** Limits, heutiges Budget und Bedarf, dazu Logout.

Die Ansicht steht im URL-Hash (`#heute`, `#arbeit`, `#alle`, `#konto`), ein Reload bleibt also auf derselben Seite.

### Optimistic UI und Cache

Jede Liste liegt im `localStorage` unter `quarto_<ansicht>_<kontext>_<userId>`, das Profil unter `quarto_profile_<userId>`.

1. Beim Öffnen einer Ansicht wird sofort der Cache gezeichnet.
2. Parallel kommt der aktuelle Stand vom Server. Weicht er ab, wird neu gezeichnet und der Cache ersetzt.
3. Jede Aktion ändert zuerst Cache und Oberfläche: Die Zeile verschwindet, die Minuten zählen zum Fortschritt, die Reihenfolge ändert sich. Erst dann geht der Request raus. Nach Abschluss wird neu geladen, bei Fehlern gibt es einen Hinweis.
4. Neue To-dos aus den Schnellfeldern bekommen eine temporäre ID `tmp-…` und erscheinen sofort. Bis der Server antwortet, lassen sie sich nicht abhaken.

### Sync zwischen Geräten

Es gibt keine Push-Verbindung, stattdessen wird neu geladen:

- wenn die App aus dem Hintergrund zurückkommt (`visibilitychange`) oder das Fenster den Fokus bekommt
- alle 60 Sekunden, solange die App sichtbar ist

`safeRefresh` überspringt das Neuladen, solange ein Menü oder Dialog offen ist, gerade gezogen wird oder in einem Schnellfeld Text steht. So zerreißt der Sync nie eine laufende Eingabe.

### Zeilen

Jede Aufgabe ist eine Zeile mit Kästchen, Name, Infos rechts und „⋯“-Menü.

- **Kästchen:** Ein Tipp hakt sofort ab, das Kästchen wird grün und die Zeile gleitet raus. Spontane Aufgaben haben ein gestricheltes Kästchen.
- **Rechts:** Überfälligkeit in Tagen (orange, `-4d`), Deadline-Chip (orange ab zwei Tagen vorher), Dauer (`3m`). In Alle zusätzlich Fälligkeit, Rhythmus und Prioritätspunkt.
- **Neben dem Namen:** Fortschritt der Unteraufgaben (`2/9`) und ein Symbol, wenn es eine Notiz gibt.
- **Name:** Hat die Aufgabe Unteraufgaben oder Notiz, klappt ein Tipp sie auf: Fortschrittslinie, abhakbare Unteraufgaben, Notiz mit klickbaren Links. Aufgeklappte bleiben über Neuladen hinweg offen. Ohne Details öffnet ein Tipp den Details-Dialog (Heute, Arbeit) bzw. den Bearbeiten-Dialog (Alle).
- **„⋯“-Menü:**
  - Heute und Arbeit: Nicht heute, Morgen, Nächste Woche, Details
  - Einmalig: Heute, Details, Löschen
  - Alle: Bearbeiten, Morgen, Nächste Woche, Löschen
  - Evergreens: Heute, Umbenennen, Löschen

### Auf heute aus Alle

Im Menü einer Aufgabe in Alle steht „Auf heute“, bei Aufgaben, die schon auf heute stehen, „Nicht heute“. Das schaltet nur `today` um, die Fälligkeit bleibt. Wie die anderen Aktionen mit 5 Sekunden Rückgängig.

### Rückgängig

Erledigt, Nicht heute, Morgen, Nächste Woche und Auf heute wirken sofort in der Oberfläche, gehen aber erst nach 5 Sekunden an den Server. So lange zeigt ein Hinweis unten die Aktion mit „Rückgängig“ und einem ablaufenden Balken, auf dem Mac geht auch `⌘Z`. Rückgängig stellt den gespeicherten Stand von Listen und Profil wieder her, ohne dass der Server je etwas davon mitbekommt.

- Eine neue Aktion schickt eine noch offene sofort ab, es gibt immer nur eine Aktion zum Zurücknehmen.
- Wechselt die Ansicht oder geht die App in den Hintergrund, wird die offene Aktion sofort gesendet. Beim Schließen läuft das über `fetch` mit `keepalive`, damit der Request das Schließen überlebt.
- Solange eine Aktion offen ist, pausiert der Sync, sonst käme die Aufgabe vom Server kurz zurück.
- Löschen hat schon eine Rückfrage und geht sofort raus.

### Ersatz statt verschobener Aufgabe

Wird in Heute eine einzelne Aufgabe auf Nicht heute, Morgen oder Nächste Woche gesetzt, zeigt der Hinweis darunter bis zu fünf Aufgaben unter „Stattdessen:“, und der Balken läuft dann 10 statt 5 Sekunden. Ein Tipp schickt die Verschiebung ab und holt die gewählte Aufgabe auf heute. Danach bleibt der Hinweis stehen und zeigt „Noch X min frei“, weitere Aufgaben lassen sich dazunehmen, solange sie mit 5 Minuten Spielraum in die übrige Zeit passen. Was nicht mehr passt, wird blass, ein Tipp darauf wackelt und sagt „Passt nicht mehr“. Bei einer verschobenen Aufgabe ohne Dauer gilt das Tageslimit als frei. Gedacht für Tage, an denen etwas gerade nicht geht, etwa eine Aufgabe draußen.

`GET /user/{userId}/tasks/replacements?minutes=<frei>&exclude=<id>` sucht unter den privaten Aufgaben, die nicht auf heute stehen, ohne Einmalige, Evergreens und Spontane. Passen muss die Dauer in die frei gewordenen Minuten plus 5, bei einer Aufgabe ohne Dauer zählt die Standarddauer. Fällige zuerst, nach Priorität und Datum, danach was demnächst ansteht, frühestes zuerst.

### Drag & Drop

SortableJS auf beiden Listen derselben Gruppe. Auf dem iPhone startet das Ziehen nach 220 ms Gedrückthalten, auf dem Mac sofort. Kästchen, Menü, Unteraufgaben und Links starten kein Ziehen.

- **Innerhalb einer Liste:** neue Ordnung aus den Nachbarn, siehe [Ordnung](#ordnung).
- **Von Einmalig nach Heute:** `today = 1`.
- **Von Heute nach Einmalig:** nur bei einmaligen Aufgaben erlaubt, `today = 0`.

In Alle ist Ziehen aus, dort wird nach Fälligkeit sortiert.

### Schnelleingabe

- **Evergreen-Chips:** ein Tipp setzt den Evergreen als spontanes To-do auf heute.
- **Einmalig-Feld:** Text eingeben, Enter. Mehrere To-dos mit Komma trennen, optional mit Deadline nach `bis`:
  - `bis heute`, `bis morgen`, `bis übermorgen`
  - `bis fr` oder `bis freitag`: nächster Freitag, heute zählt mit
  - `bis 3.12.`: der nächste 3.12., liegt er in der Vergangenheit, im nächsten Jahr
  - `bis 3.12.27` oder `bis 3.12.2027`
- Ein Info-Knopf am Feld erklärt die Syntax.

### Dialoge

Native `<dialog>`-Elemente, ein Klick auf den Hintergrund schließt sie.

- **Neue Aufgabe / Bearbeiten:** Name, Fälligkeit, Rhythmus (mit Info zur Syntax), Priorität, Dauer, Unteraufgaben (eine pro Zeile), Notiz. Bei Arbeit sind Priorität und Dauer ausgeblendet.
- **Details:** nur Unteraufgaben und Notiz, für Heute, Arbeit und Einmalig.
- **Löschen:** Rückfrage mit Namen.

Beim Bearbeiten der Unteraufgaben als Text behalten unveränderte Zeilen ihr Häkchen.

### Tastenkürzel (Mac)

| Taste | Wirkung |
|---|---|
| `N` oder `L` | in Heute/Arbeit ins Einmalig-Feld, in Alle (nur `N`) neue Aufgabe |
| `⌘Z` | letzte Aktion rückgängig, solange der Hinweis sichtbar ist |
| `Esc` | Menü und Popover schließen, Feld verlassen |

Auf Touch-Geräten sind die Tastenhinweise ausgeblendet.

### Service Worker und Manifest

`manifest.json` macht Quarto zur installierbaren Web-App (`display: standalone`). Auf dem iPhone ist das Voraussetzung für Push: Mitteilungen gibt es nur für Apps auf dem Homescreen, nicht in Safari.

`sw.js` ist nur für Push da und cacht nichts. Er zeigt eingehende Nachrichten als Mitteilung an und öffnet bei Tipp die App bzw. holt sie nach vorn.

Auf der Konto-Seite schaltet der Bereich „Benachrichtigungen“ Push pro Gerät ein und aus. Aktivieren fragt die Erlaubnis ab, registriert den Service Worker, abonniert beim Push-Dienst mit dem öffentlichen VAPID-Schlüssel und speichert das Abo. „Test senden“ schickt sofort an alle Geräte.

### Zahl am App-Icon

Das Icon auf dem Homescreen bzw. im Dock zeigt die Zahl offener Aufgaben von Heute, wie bei Mails. iOS erlaubt das für Web-Apps nur, wenn Mitteilungen erlaubt sind.

- **App offen:** Bei jeder Änderung der Heute-Liste setzt `updateBadge` die Zahl per `navigator.setAppBadge`, bei 0 verschwindet sie.
- **App zu:** Jede Push-Nachricht enthält `badge` mit der aktuellen Zahl, der Service Worker setzt sie beim Empfang. iOS erlaubt Web-Apps keine stillen Updates, deshalb geht das nur zusammen mit einer sichtbaren Mitteilung.
- **Änderung von außen:** Ändert eine Aktion die Zahl offener Aufgaben von Heute, etwa Abhaken am Mac oder per Siri, schickt die API eine Mitteilung mit dem neuen Stand („Noch 2 Aufgaben · 5 min“ bzw. „Heute alles erledigt“) an alle anderen Geräte. Jede neue ersetzt die vorige (`tag: quarto-status`). Das Gerät, von dem die Änderung kam, schickt seine Kennung im Header `X-Quarto-Device` mit (die ersten 32 Zeichen des SHA-256 seines Push-Endpoints, wie im SK des Abos) und bekommt nichts, dort ist die App ja offen. Siri schickt keine Kennung, also kommt die Mitteilung auf allen Geräten an.
- Nach dem Nachtlauf stimmt die Zahl erst mit der ersten Benachrichtigung oder beim Öffnen der App.

### Cache-Busting

`main.js` und `main.css` werden mit `?v=<commit>` eingebunden. Der Pages-Workflow setzt den Wert bei jedem Deployment auf den Commit-Hash, sodass Browser und PWA die neuen Dateien laden statt alter Kopien.

### PWA und Dock-App

- **iPhone:** Safari, Teilen, „Zum Home-Bildschirm“. Die Meta-Tags sorgen für Vollbild, dunkle Statusleiste und das Apple-Touch-Icon.
- **Mac:** Safari, Ablage, „Zum Dock hinzufügen“.

Die Statusleiste ist mit der Hintergrundfarbe abgedeckt (`.app::before` mit `env(safe-area-inset-top)`), damit beim Scrollen nichts unter Uhrzeit und Akku läuft.

Homescreen- und Dock-Apps haben eigenen Speicher, getrennt von Safari. Nach dem Hinzufügen muss man sich dort einmal neu einloggen.

Ein Widget gibt es bewusst nicht: Ohne Interaktion wäre es nutzlos.

## Bedienung

Typischer Tag:

1. Morgens die App öffnen. Die Heute-Liste ist schon gefüllt, der Balken steht bei 0.
2. Aufgaben abhaken, der Balken wächst.
3. Kleinigkeiten wie Einkaufen oder Wäsche per Evergreen-Chip auf heute holen. Sie verschwinden über Nacht von selbst.
4. Passt eine Aufgabe heute nicht: „⋯“, Morgen oder Nächste Woche.
5. Alles Einmalige ins Einmalig-Feld, bei Bedarf mit `bis …`, oder unterwegs per „Hey Siri, Quarto“. Wenn Zeit ist, auf Heute ziehen.
6. Beim Haushalt mit Kopfhörern: „Hey Siri, Quarto“ und dann „Was steht heute an?“, „Küche erledigt“ oder „Einkaufen“.

Neue wiederkehrende Aufgaben legt man in Alle an, Rhythmus und Dauer ehrlich schätzen. Die Konto-Seite zeigt danach, ob das Limit noch reicht.

## Entwicklung und Deployment

### Voraussetzungen

- Node.js und npm für CDK
- AWS CLI mit Zugriff auf das Konto, Region eu-central-1
- Python 3 (lokaler Testserver, optional `backend/.venv` mit boto3 für Skripte)
- Git mit Push-Rechten auf `daviddimitrov/quarto`

### Frontend lokal testen

```sh
cd frontend && python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen. Localhost hat eigene Cookies und eigenen `localStorage`, man loggt sich dort einmal separat ein. Der lokale Server spricht mit der echten API, Änderungen an Daten sind also echt.

### Frontend deployen

Ein Push auf `main` mit Änderungen in `frontend/` oder am Workflow startet `.github/workflows/pages.yml`. Der Job `build` setzt im ausgelieferten HTML die Cache-Version (`?v=`) von `main.js` und `main.css` auf den Commit-Hash und lädt `frontend/` als Pages-Artefakt hoch, `deploy` veröffentlicht es. `concurrency` bricht ältere Läufe ab. Nach ein bis zwei Minuten ist die neue Version live.

`bump.sh` setzt die Version lokal und ist nur noch für Tests auf localhost interessant.

### Backend deployen

Ein Push auf `main` mit Änderungen in `backend/` oder am Workflow startet `.github/workflows/backend.yml`. Der Workflow meldet sich per OIDC bei AWS an, ohne gespeicherte Schlüssel, installiert die Abhängigkeiten und führt `npx cdk deploy --require-approval never` aus. Den `CryptoLayer` baut CDK dabei mit dem Python des Runners. Über „Run workflow“ in GitHub lässt er sich auch von Hand starten.

Weil der Workflow nicht nachfragt, gehen auch IAM-Änderungen ohne Bestätigung raus. Wer Backend-Änderungen merged, deployt sie also.

Einmalige Einrichtung in AWS, lokal mit Admin-Zugang:

```sh
sh backend/scripts/setup-github-deploy.sh
```

Das Skript legt den OIDC-Provider für GitHub an, falls es ihn im Konto noch nicht gibt, und die Rolle `quarto-github-deploy`. Annehmen kann sie nur ein Workflow aus `main` von `daviddimitrov/quarto`, und sie darf nichts außer die Rollen übernehmen, die `cdk bootstrap` angelegt hat. Das Skript lässt sich gefahrlos mehrfach ausführen.

Lokal deployen geht weiterhin:

```sh
cd backend && JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 npx cdk deploy
```

Bei IAM-Änderungen fragt CDK lokal mit `y/n` nach. Die Ausgabe dabei nicht durch `grep` filtern, sonst sieht man die Frage nicht. Ein `cdk diff` zeigt manchmal Änderungen an der Lambda, nur weil `__pycache__` entstanden ist. Das ist harmlos.

### Collector manuell auslösen

Für alle Nutzer im Nachtmodus:

```sh
aws lambda invoke --function-name <CollectFn-Name> --region eu-central-1 /dev/stdout
```

Für den eigenen Nutzer ohne Nachtmodus geht `PATCH /user/{userId}/tasks/today` mit gültigem Token.

### Logs

CloudWatch Logs, je eine Log-Gruppe pro Lambda. Der Nachtlauf schreibt sein Ergebnis pro Nutzer als JSON ins Log.

### Hinweise für zsh

- URLs mit `;` oder `?` in Variablen oder Strings packen, sonst maskiert url-quote-magic die Zeichen.
- `!` in doppelten Anführungszeichen löst History-Expansion aus. Für JMESPath-Abfragen einfache Anführungszeichen und Backticks nehmen.
- Globs wie `--include=*.py` in Anführungszeichen setzen.

## Kosten

Bei einem Nutzer praktisch null:

| Dienst | Nutzung | Kosten |
|---|---|---|
| DynamoDB On-Demand | einige tausend Zugriffe pro Monat | Cent-Bereich, Speicher im Free Tier |
| Lambda ARM64 | wenige tausend Aufrufe | Free Tier |
| API Gateway HTTP API | Polling alle 60 s bei geöffneter App | rund 1 $ pro Million Aufrufe, im Monat Cents |
| Cognito | 1 aktiver Nutzer | Free Tier |
| EventBridge und Scheduler | rund 3.000 Aufrufe im Monat | kostenlos |
| SSM Parameter Store | ein Standard-Parameter | kostenlos |
| Web Push | Apple und Google stellen kostenlos zu | kostenlos |
| GitHub Pages | statische Dateien | kostenlos |

Das Budget von unter 1 € im Monat wird deutlich unterschritten.

## Bekannte Grenzen und Ideen

- **Kein Offline-Modus:** Ohne Netz zeigt die App den Cache, aber Aktionen schlagen fehl. Ein Service Worker mit Warteschlange wäre die Lösung.
- **Fortschritt nur privat:** Arbeit hat kein Budget und daher keinen Balken.
- **Zeitzone fest:** Backend und Collector rechnen in Europe/Berlin, der Nachtlauf in UTC. Die Uhrzeit verschiebt sich daher mit der Sommerzeit um eine Stunde.
- **Polling statt Push:** genügt für einen Nutzer mit zwei Geräten. WebSockets würden mehr kosten als sie bringen.
- **Stack-Name:** `ElevenMinutesStack` bleibt aus historischen Gründen.
