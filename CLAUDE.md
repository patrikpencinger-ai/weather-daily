# CLAUDE.md

Guidance for working in this repository.

## What this is

**Patrik's weather daily** — a bilingual (English / Croatian) weather dashboard.
The entire app is a **single self-contained file**: [weather-dashboard.html](weather-dashboard.html)
(HTML + CSS + vanilla JS, ~1,500 lines). Current version: **v2.30**.

There is no build step, no bundler, no package manager, and no backend. It is
opened directly in a browser or served as a static file. Keep it that way.

`index.html` is **not** the app — it's a tiny redirect stub so the bare domain
(e.g. `weather-daily.pages.dev/`) forwards to `weather-dashboard.html`. All real
work happens in `weather-dashboard.html`.

## Running it

Just open `weather-dashboard.html` in a browser, or serve the folder statically:

```powershell
python -m http.server 8000   # then visit http://localhost:8000/weather-dashboard.html
```

A few features need a `https://`/`http://` origin rather than `file://`
(browser geolocation, some fetches), so prefer the local server when testing those.

**iOS caveat:** iPhone/iPad Safari blocks **all** network requests on `file://` pages, so
opening the raw `.html` directly on iOS leaves it stuck/erroring with no data — it must be
served over `http(s)` (GitHub Pages, Netlify, or a LAN web server) to work on a phone.
The error screen now explains this, and the AI-feed fallback (`fetchAI` → `tfetchP`) has a
timeout so a failed load shows the error rather than hanging forever.

## Data sources (all keyless, all client-side)

- **Open-Meteo forecast** — `api.open-meteo.com` (hourly + daily) and
  `geocoding-api.open-meteo.com` for city → lat/lon.
- **Open-Meteo Marine** — `marine-api.open-meteo.com` (sea surface temperature, tides).
- **Open-Meteo Air Quality** — `air-quality-api.open-meteo.com` (pollen).
- **Open-Meteo Archive** — `archive-api.open-meteo.com` (1991–2020 climatology / anomalies).
- **AI feed (optional secondary)** — a Claude + web-search "interesting fact" / outlook feed.
  The dashboard degrades gracefully when this is unavailable.
- **DHMZ stations** — nearest Croatian met stations shown on a map.

All requests go through `tfetch(url, ms)`, a `fetch` wrapper with a timeout.

## Third-party libraries (CDN only — keep it that way)

- **Chart.js 4.4.1** — `cdnjs.cloudflare.com/.../Chart.js/4.4.1/chart.umd.js` (loaded eagerly).
- **Leaflet 1.9.4** — `cdnjs.cloudflare.com/.../leaflet/1.9.4/...` (lazy-loaded via `loadLeaflet()`
  only when the map section is shown). Map tiles © OpenStreetMap.

Pin exact versions from **cdnjs**. Do not add npm dependencies or a build pipeline.

## Conventions — ALWAYS follow these

These are the non-negotiable house rules for any change:

1. **Bilingual everywhere (EN / HR).** Every user-facing string lives in the `T`
   translation object (`T.en` / `T.hr`), keyed and looked up via `LBL`. Never hardcode
   a visible string in markup or JS — add both `en` and `hr` entries. `setLang('en'|'hr')`
   switches language; static markup strings use `data-i="key"`.
2. **Light & dark themes.** Colors come from CSS variables and the `calc()` palette
   (`BG`, `txt`, `strong`, `grid`, …). `applyTheme('light'|'dark')` toggles; charts must
   re-read theme colors on redraw. Never hardcode a raw color that breaks in either theme.
3. **Large-font mode.** `toggleFont()` adds `.big` to `#wrap` (a `zoom`-based scale).
   Charts are resized/updated on toggle. New UI must remain legible and not overflow in big mode.
4. **Summaries above charts, legends below.** Each chart section follows the order:
   heading → one-line summary paragraph (`…Sum`) → canvas → legend (`…Leg`). Match this
   layout for any new chart. Legends are custom DOM (`display:flex;flex-wrap`), not Chart.js's
   built-in legend (Chart.js `legend:{display:false}` throughout).
5. **Versioned footer.** Footer reads `Weather Dashboard vX.YY · by Patrik Pencinger`.
   Bump the version in **both** the `<title>` and the footer when shipping a change.
6. **Static & deployable.** No backend, no build, no secrets, no bundler. Everything must
   work from a plain static host (and reasonably from `file://`).
7. **Accessibility.** Canvases carry `role="img"` + `aria-label`; controls carry `aria-label`.
   Keep these in sync when changing a chart's meaning.

## Code layout within the single file

Roughly top-to-bottom:

- `<head>` / CSS — theme variables, `.big` large-font rule, layout.
- `<body>` markup — header controls (lang / theme / font / toggles), then `#dash` sections:
  (severe-weather alert banner, when active) · RIGHT NOW · NEXT 24 HOURS · SEA TEMPERATURE ·
  OUTLOOK · WEEKEND PLANS · GRILLING · BIOMETEO · MOON & TIDE · INTERESTING FACT ·
  MAP (pick a point) · footer.
  Severe-weather alerts (`buildAlerts`/`D.alerts`) are derived client-side from Open-Meteo
  (storm code / strong wind / heavy rain / big swing) — official DHMZ/Meteoalarm feeds are
  CORS-blocked from the browser, so they'd need a Worker proxy. WEEKEND PLANS rates this & next
  weekend for hiking/biking/running using a forced 14-day lookahead (`D.daysFull`).
  The MAP section is click-to-forecast: tapping any point reverse-geocodes it (Nominatim) and
  loads that point's forecast via `onMapClick`/`pickPoint`. (The old fixed DHMZ-station list was
  removed in v2.29.)
- `<script>` — organized by `/* ---------- ... ---------- */` banners:
  state/helpers · `T` translations · data sources (forecast / marine / air / climatology / AI) ·
  orchestration (`loadData`, `fetchFor`, …) · recents/selection · rendering (`render`, `card`, …) ·
  chart drawers (`drawHourly`, `drawSea`, `drawWeek`, `drawBio`, `drawMT`) · map (`loadLeaflet`).

Notable globals: `lang`, `theme`, `fontbig`, `RANGE`, comparison state (location A vs B),
and feature toggles (`CONF`, `MOON`, `TIDE`, `PRES`, `BBQ`, `MP`). `MP` is a "Monty Python"
easter-egg label set. User prefs (recents) persist via `localStorage` (`wd_recents`).

## Making changes

- Edit `weather-dashboard.html` directly; keep the section-banner organization.
- When touching a chart: update its summary, legend, and `aria-label` together, and make sure
  it redraws correctly across theme switch, large-font toggle, and language switch.
- Bump the version (`<title>` + footer) on user-visible changes.
- Verify by eye in a browser in both themes, both languages, and large-font mode before committing.
