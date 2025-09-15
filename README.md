# REST API (Express) – Adaptacja Twoich plików

Ten folder zawiera zmodyfikowany `server.js` (Express) i nowe trasy REST w `routes/api.js`.
Wykorzystuje Twoje: `db.js`, `settings.js`, `utils.js`, `eventHandler.js`, `auth.js`.

## Endpoints
- POST `/hooks/janus` – odbiór eventów Janusa (używa `eventHandler.js`)
- GET  `/api/health`
- GET  `/api/sessions`
- GET  `/api/handles?session=...`
- GET  `/api/stats/series?session=...&handle=...&from=ISO&to=ISO&bucket=1m`
- GET  `/api/events/recent?session=...&handle=...&limit=50`

## Uruchomienie
```bash
npm i
node server.js
```

Host i port pobierane z `settings.js` (`http.host`, `http.port`). Limit body z `limits.bodyBytes` (fallback 1mb).

## Migracje / indeksy
W pliku `migrations/2025-09-09_add_slowlinks_and_indexes.sql` znajdziesz indeksy i tabelę `slowlinks`.
