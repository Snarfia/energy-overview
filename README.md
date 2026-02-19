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

## Landscape / widget mode (infoscherm)

Gebruik URL-parameters:

- `?landscape=1` forceert landscape-weergave.
- `?widget=1` toont compacte kioskweergave en wisselt elke 30s tussen pagina's.
- `?page=electricity` of `?page=gas` kiest de startpagina.

Voorbeeld:

`https://jouwdomein.nl/?landscape=1&widget=1&page=electricity`

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

De deploy-workflow staat vast op `energydashboard.snarfia.nl/` als doelmap.

## npm scripts

- `npm start`: lokale server met `/api/overview` en static files.
- `npm run update:overview`: genereert `static/overview.json` voor statische hosting.
