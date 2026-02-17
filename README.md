# Energy Market Overview (statische hosting)

De website in `static/` is nu geschikt voor standaard hosting (shared hosting), zonder Python of Node runtime op je hosting.

## Hoe het werkt

- De frontend leest data uit `static/overview.json`.
- GitHub Actions ververst `overview.json` elke 15 minuten.
- GitHub Actions uploadt daarna `static/` naar je hosting via FTP.

## Lokaal testen

Als je Node hebt:

```bash
npm run update:overview
npm start
```

Open daarna `http://localhost:8000`.

## GitHub Actions die in de repo staan

- `.github/workflows/update-overview.yml`
  - Draait elke 15 minuten.
  - Maakt een nieuwe `static/overview.json`.
  - Commit de update naar je repo.
- `.github/workflows/deploy-static.yml`
  - Deployt `static/` naar je hosting via FTP bij elke push op `main`.
  - Ook handmatig te starten via `workflow_dispatch`.

## Vereiste GitHub Secrets

Datasecrets (voor API calls):

- `ENTSOE_API_TOKEN`
- `NED_API_TOKEN`
- `TENNET_API_KEY`

Hostingsecrets (voor FTP deploy):

- `FTP_SERVER`
- `FTP_USERNAME`
- `FTP_PASSWORD`
- `FTP_PORT` (meestal `21`)
- `FTP_REMOTE_DIR` (bijv. `/public_html/`)

## npm scripts

- `npm start`: lokale server met `/api/overview` en static files.
- `npm run update:overview`: genereert `static/overview.json` voor statische hosting.
