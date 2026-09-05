# CLAUDE.md

Guidance for working in this repository.

## What this is

**Patrik's weather daily** — a bilingual (English / Croatian) weather dashboard.
The entire app is a **single self-contained file**: [weather-dashboard.html](weather-dashboard.html)
(HTML + CSS + vanilla JS, ~3,420 lines). Current version: **v3.15** (also in the
`APPV` JS constant, used for the dynamic `document.title` — bump all three together,
plus add a `CHANGELOG` entry).

As of v3.08 it's a **six-view SPA in one file**: a tab bar + hash router (`#weather`/`#bbq`/
`#hike`/`#swim`/`#map`/`#info`; `#radar` redirects to `#map`) over a `VIEWS` registry.
The `#map` view is a **full-screen weather map** (`renderMapFull`/`drawRadarMap`, Leaflet map
`radarMapL`): keyless **OpenStreetMap** basemap (`mapBaseUrl`; an optional `CARTOKEY` restores
CARTO Positron) with its own light/dark switch (`MAPTHEME`/`mapThemeToggle`, independent of app
theme) — dark mode is a CSS invert on the base tiles (`.mapdark .basetiles`) — zoom to 19 (radar
tiles stretched via `maxNativeZoom:7` — RainViewer's free tiles END at z7; requesting deeper
native tiles returns "Zoom Level Not Supported" error tiles), toggleable layers in
`MLAYERS`/`mlyToggle` — RainViewer
radar frames with timeline (at most **two frames stay attached** at a time, current + preloaded
next, so panning doesn't refetch every frame), Blitzortung live lightning (reconnects with
exponential backoff), and an Open-Meteo **point grid** (`gridRefresh`/`gridDraw`: a temperature
IDW heatmap with a legend, wind arrows, 48h rainfall, cloud cover; cache keyed to a zoom-scaled
cell so high-zoom pans stay accurate), plus the next-2h rain strip and click-to-forecast
(`onMapClick`/`pickPoint`), and (as of v3.15) a **📍 my-location** Leaflet control (`locateOnMap`,
above the zoom buttons) that geolocates and recentres/pins the map; wind labels show gusts in
parentheses when they clear speed+5. Launched from the Map tab or the 🗺️ card at
the end of the RIGHT NOW cards; ✕ returns to `#weather`. One shared data fetch (`D`) feeds all views;
`showView(name)` toggles `#view-*` sections, `destroyAllCharts()`, then dispatches the active
view's render via `setTimeout(0)` (NOT rAF — throttled in background tabs). The four global
hooks (`applyTheme`/`setLang`/`toggleFont`/`applyResponsive`, plus `toggleMP`) call
`renderActive()` so only the visible view re-renders. The Weather view is the OG dashboard
(`render()`) wrapped unchanged. BBQ grill score is a toggleable compound (`grillCompound`/
`BBQCRIT`, time/temp/rain/wind/humid/storm). Swimming auto-detects coastal (`D.sea`) vs inland
(Overpass pools/spas within 50 km, lazy + cached). New per-view drawers follow the same
destroy-guard + summary-above/legend-below conventions. As of v3.14, boot is instant and
stale-while-revalidate: `initLoc()` fires `loadData()` for the current location immediately
(GPS/Nominatim resolve in parallel and only trigger a refetch if they land >2 km away), the
last direct-mode forecast is cached to `localStorage` (`wd_last`) and rendered right away while
a background refetch runs, async climo/marine/air arrivals are coalesced through
`scheduleRender()` (150 ms debounce), and forecast/marine/air caches carry short TTLs (15 min /
30 min) with a refetch on tab visibility and a bilingual "updated X min ago" footer chip. As of
v3.15, the direct hourly/daily fetch also pulls `visibility`, `freezing_level_height`,
`wind_gusts_10m`, `snowfall` and `wind_gusts_10m_max` — today's hourly values land in `D.hx`
and today's gust max in `D.gustMax`, feeding the Hiking view's visibility/snow-line/gust
cards (falling back to the old estimates when the AI feed's reduced object lacks them) and the
map's gust-aware wind labels. The air-quality fetch adds `pm10`/`nitrogen_dioxide`/`ozone`/`dust`
for the RIGHT NOW AQI card's pollutant breakdown. BIOMETEO gained a 72 h pressure-trend chart
(`drawPressure`/`presCh`, backed by `D.presH`). Every data source now reports its own health via
`FEEDS[name]={t,ok,err}` (written by `feedMark()` for forecast/ai/marine/air/climo/radar/lightning),
rendered live on the Info tab (`renderFeeds`/`#infoFeeds`).

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

- **Open-Meteo forecast** — `api.open-meteo.com` (hourly + daily + `minutely_15`
  precipitation for the Radar view's next-2h rain strip, `D.rain15`; hourly also carries
  `pressure_msl` (72 h pressure trend, `D.presH`) and, as of v3.15, `visibility`,
  `freezing_level_height`, `wind_gusts_10m`, `snowfall` (today's values in `D.hx`) plus daily
  `wind_gusts_10m_max` (`D.gustMax`) for the Hiking view and the map's gust-aware wind labels)
  and `geocoding-api.open-meteo.com` for city → lat/lon.
- **Open-Meteo Marine** — `marine-api.open-meteo.com` (sea surface temperature, tides).
- **Open-Meteo Air Quality** — `air-quality-api.open-meteo.com` (pollen + `european_aqi`
  with a past day and 3-day hourly forecast → RIGHT NOW AQI card + AIR QUALITY chart; as of
  v3.15 also `pm10`/`nitrogen_dioxide`/`ozone`/`dust` for the AQI card's pollutant breakdown).
- **Blitzortung.org** — live lightning strikes over websocket (`ws1/ws7/ws8.blitzortung.org`,
  LZW-decoded JSON) as a ⚡ toggle layer on the Radar map. Live-only (accumulates while the
  view is open), suspended when leaving the tab, attribution required, non-commercial use.
- **OpenStreetMap tiles** (`tile.openstreetmap.org`) — keyless base map for the Map view;
  the map's dark mode is a CSS invert on the base tiles (`.mapdark .basetiles`).
  CARTO Positron (`basemaps.cartocdn.com`) was dropped in v3.13 when CARTO made its
  basemaps key-only (tiles come back watermarked "API KEY REQUIRED"); setting the
  `CARTOKEY` constant to a free key from carto.com/basemaps/apikey restores it.
- **Open-Meteo Archive** — `archive-api.open-meteo.com` (1991–2020 climatology / anomalies).
- **AI feed (optional secondary)** — a Claude + web-search "interesting fact" / outlook feed.
  The dashboard degrades gracefully when this is unavailable.
- **Nominatim** (`nominatim.openstreetmap.org`) — reverse geocoding for map clicks / GPS.
- **Overpass** (`overpass-api.de`) — nearby pools & spas for the inland Swimming view
  (lazy, cached in `poolCache`; errors are surfaced, not cached).
- **RainViewer** (`api.rainviewer.com` + `tilecache.rainviewer.com`) — rain-radar tile
  frames for the Radar view: past ~2 h plus nowcast frames when the public API provides
  them (lazy; frame list cached ~5 min; requires "© RainViewer" attribution).

All requests go through `tfetch(url, ms)`, a `fetch` wrapper with a timeout.

## Third-party libraries (CDN only — keep it that way)

- **Chart.js 4.4.1** — `cdnjs.cloudflare.com/.../Chart.js/4.4.1/chart.umd.js` (loaded eagerly).
- **Leaflet 1.9.4** — `cdnjs.cloudflare.com/.../leaflet/1.9.4/...` (lazy-loaded via `loadLeaflet()`
  only when the map section is shown). Map tiles © OpenStreetMap.

Pin exact versions from **cdnjs**. Do not add npm dependencies or a build pipeline.

## Conventions — ALWAYS follow these

These are the non-negotiable house rules for any change:

1. **Bilingual everywhere (EN / HR).** Two accepted patterns: (a) shared/static strings
   live in the `T` translation object (`T.en` / `T.hr`), looked up via `LBL`; static markup
   uses `data-i="key"`; (b) **view-local strings** (v3 pages: BBQ/Hiking/Swim cards, phases,
   grades) may be inline `hrv?'…hr…':'…en…'` ternaries inside their render function, since
   those re-run on `setLang`. Either way, EVERY user-visible string must exist in both
   languages — never EN-only. Exception: Monty-Python (`MP`) easter-egg lines are
   intentionally English in both languages.
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
  Weather view: (severe-weather alert banner, when active) · RIGHT NOW · NEXT 24 HOURS ·
  SEA TEMPERATURE · OUTLOOK · WEEKEND PLANS · GRILLING · BIOMETEO (comfort card +, as of v3.15,
  a 72 h PRESSURE TREND chart — `drawPressure`/`presCh`, summary above/legend below like every
  other chart) · MOON & TIDE · INTERESTING FACT. The MAP (full-screen, layered — see above) and
  INFO (about + a `#infoFeeds` data-sources status panel, see below + `CHANGELOG` array,
  bilingual version history) are their own views/tabs; shared footer sits outside the sections.
  The RIGHT NOW cards include a TOMORROW card (range/icon, vs today / vs normal / vs last year
  via `climo.ly.tomMax`, plus — as of v3.15 — rain % and wind) and end with the 🗺️ map card.
  Severe-weather alerts (`buildAlerts`/`D.alerts`) are derived client-side from Open-Meteo
  (storm code / strong wind / heavy rain / big swing / extreme UV / dangerous heat / dangerous
  cold, the last three added in v3.15) — official DHMZ/Meteoalarm feeds are
  CORS-blocked from the browser, so they'd need a Worker proxy. WEEKEND PLANS rates this & next
  weekend for hiking/biking/running using a forced 14-day lookahead (`D.daysFull`).
  The MAP section is click-to-forecast: tapping any point reverse-geocodes it (Nominatim) and
  loads that point's forecast via `onMapClick`/`pickPoint`. (The old fixed DHMZ-station list was
  removed in v2.29.) The Hiking view (`renderHike`) scores on real hourly data (visibility/
  freezing-level/gusts/snowfall from `D.hx`/`D.gustMax`) when the direct feed provides it —
  fog/snow-line/gust cards and a 5th trail-score component — falling back to its older estimates
  for the reduced AI-feed object. The `#infoFeeds` panel (`renderFeeds()`, called from
  `renderInfo()` and every 60 s while the Info tab is open) lists one row per entry in `FEEDS`
  (forecast/marine/air/climo/radar/lightning/ai): a coloured dot, live/failed/not-used-yet
  status, last-update time and age, and any error text.
- `<script>` — organized by `/* ---------- ... ---------- */` banners:
  state/helpers (incl. `FEEDS`/`feedMark()`, per-source health for the Info status panel) ·
  `T` translations · data sources (forecast / marine / air / climatology / AI) ·
  orchestration (`loadData`, `fetchFor`, …) · recents/selection · rendering (`render`, `card`, …) ·
  chart drawers (`drawHourly`, `drawSea`, `drawWeek`, `drawBio`, `drawPressure`, `drawGrill`,
  `drawMT`, `drawBbqTimeline`, `drawBbqGrill`, `drawHikeComfort`, `drawHikeWeek`, `drawSwimChart`) ·
  maps (`loadLeaflet` weather map incl. the `locateOnMap` 📍 my-location control, `drawSwimMap`
  inland pools) · view router (`ROUTES`/`VIEWS`/`showView`/`renderActive`) · Info panel
  (`renderInfo`, `renderFeeds`, `CHANGELOG`).

Notable globals: `lang`, `theme`, `fontbig`, `RANGE`, comparison state (location A vs B),
and feature toggles (`CONF`, `MOON`, `TIDE`, `PRES`, `BBQ`, `MP`). `MP` is a "Monty Python"
easter-egg label set. User prefs (recents) persist via `localStorage` (`wd_recents`).

## Making changes

- Edit `weather-dashboard.html` directly; keep the section-banner organization.
- When touching a chart: update its summary, legend, and `aria-label` together, and make sure
  it redraws correctly across theme switch, large-font toggle, and language switch.
- Bump the version (`<title>` + footer) on user-visible changes.
- Verify by eye in a browser in both themes, both languages, and large-font mode before committing.
