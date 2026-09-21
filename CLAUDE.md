# CLAUDE.md

Guidance for working in this repository.

## What this is

**Patrik's weather daily** — a bilingual (English / Croatian) weather dashboard.
The entire app is a **single self-contained file**: [weather-dashboard.html](weather-dashboard.html)
(HTML + CSS + vanilla JS, ~3,600 lines). Current version: **v3.17** (also in the
`APPV` JS constant, used for the dynamic `document.title` — bump all three together,
plus add a `CHANGELOG` entry).

### PWA support files

As of v3.16 the app is installable (Android/Chrome "Install app", iOS "Add to Home Screen",
standalone display) with an offline app shell. This is the **one deliberate exception** to
"single self-contained file": `manifest.json`, `sw.js`, the `icons/` PNGs, and the
`tools/make-icons.js` script that generates them are the only other files this project ships.
None of them touch app data or behaviour — `sw.js` precaches only the HTML shell (this file,
`index.html`, `manifest.json`, the icons) and the two pinned CDN library files/styles
(Chart.js, Leaflet JS+CSS); it never intercepts or caches an API or map-tile request — those
always go straight to the network, untouched, exactly as if the service worker did not exist.
`tools/make-icons.js` is a dependency-free node script (hand-rolled PNG encoder: raw RGBA
scanlines → `zlib.deflateSync` → PNG chunks with a hand-rolled CRC32) that regenerates the three
icon PNGs; it's excluded from the deployed site via `.assetsignore` (`tools/`). **Bump `CACHE`
in `sw.js`** (currently `wd-shell-v3.17`) whenever the shell's precache list or pinned CDN
versions change — the old cache is dropped on activate. The SW registers only on `https:` (never
on `file://`, and it's a no-op if registration fails — the page works identically without it);
its status is reported through the same `FEEDS`/`feedMark('pwa', …)` mechanism as every other
data source and shown as a `pwa` row on the Info page (linked from the footer, see below).
When a new SW takes over an already-open tab (`controllerchange`), the app does **not**
auto-reload — it appends a bilingual "new version ready — reload" / "nova verzija spremna —
osvježi" note to the footer chip instead.

As of v3.17 it's a **five-view SPA in one file**: a tab bar + hash router (`#weather`/`#bbq`/
`#hike`/`#map`/`#info`; `#swim` redirects to `#weather`, `#radar` redirects to `#map`) over a
`VIEWS`/`ROUTES` registry. Info has no tab in the nav bar any more — it's reached only via the
footer's "Info & changelog" link (`#info`), with a "← Back" link inside the view; the route
still works directly. The `#map` view is a **full-screen weather map** (`renderMapFull`/`drawRadarMap`, Leaflet map
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
parentheses when they clear speed+5. As of v3.16, the grid fetch also carries 24 h of hourly
temperature/wind/gusts/cloud/precip per point, and a **⏱ time-scrub slider** in the bottom panel
(0 = now … +24 h) redraws the heatmap, labels and rain/cloud blobs for the chosen hour straight
from that cached response — no refetch while scrubbing; the legend shows the selected hour, and
the next-2h rain strip's pill re-labels to match. Launched from the Map tab or the 🗺️ card at
the end of the top card grid (`#nowCards`, no heading as of v3.17 — see the Weather view section
list below); ✕ returns to `#weather`. One shared data fetch (`D`) feeds all views;
`showView(name)` toggles `#view-*` sections, `destroyAllCharts()`, then dispatches the active
view's render via `setTimeout(0)` (NOT rAF — throttled in background tabs). Three global
hooks (`applyTheme`/`setLang`/`applyResponsive`, plus `toggleMP`) call
`renderActive()` so only the visible view re-renders. The Weather view is the OG dashboard
(`render()`) wrapped unchanged. BBQ grill score is a toggleable compound (`grillCompound`/
`BBQCRIT`, time/temp/rain/wind/humid/storm). The Swimming view/tab and the Overpass inland-pool
search (`poolCache`, `drawSwimMap`, `drawSwimChart`) were **removed in v3.17**; sea data
(temperature, tides, waves/swell/current) now lives in the Weather view's SEA TEMPERATURE
section for coastal locations, including in comparison mode for the chart itself. New per-view
drawers follow the same destroy-guard + summary-above/legend-below conventions. As of v3.14, boot is instant and
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
for the AQI card's pollutant breakdown. BIOMETEO gained a 72 h pressure-trend chart
(`drawPressure`/`presCh`, backed by `D.presH`). Every data source now reports its own health via
`FEEDS[name]={t,ok,err}` (written by `feedMark()` for forecast/ai/marine/air/climo/radar/lightning),
rendered live on the Info page (`renderFeeds`/`#infoFeeds`).

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
- **Open-Meteo Marine** — `marine-api.open-meteo.com` (sea surface temperature, tides, plus
  wave height/swell height+period/ocean current — the Weather view's SEA TEMPERATURE section
  shows a waves/swell/current line built by `buildSeaWaveLine()` for coastal locations, single
  location only, not shown while comparing).
- **Open-Meteo Air Quality** — `air-quality-api.open-meteo.com` (pollen + `european_aqi`
  with a past day and 3-day hourly forecast → AQI card + AIR QUALITY chart; as of
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
   uses `data-i="key"`; (b) **view-local strings** (v3 pages: BBQ/Hiking cards, phases,
   grades) may be inline `hrv?'…hr…':'…en…'` ternaries inside their render function, since
   those re-run on `setLang`. Either way, EVERY user-visible string must exist in both
   languages — never EN-only. Exception: Monty-Python (`MP`) easter-egg lines are
   intentionally English in both languages.
2. **Light & dark themes.** Colors come from CSS variables and the `calc()` palette
   (`BG`, `txt`, `strong`, `grid`, …). `applyTheme('light'|'dark')` toggles; charts must
   re-read theme colors on redraw. Never hardcode a raw color that breaks in either theme.
3. **Summaries above charts, legends below.** Each chart section follows the order:
   heading → one-line summary paragraph (`…Sum`) → canvas → legend (`…Leg`). Match this
   layout for any new chart. Legends are custom DOM (`display:flex;flex-wrap`), not Chart.js's
   built-in legend (Chart.js `legend:{display:false}` throughout).
4. **Versioned footer.** Footer reads `<span id="foot"></span> · PATRIK'S WEATHER DAILY ·
   vX.YY · by Patrik Pencinger · Info & changelog` (title and version live in the footer as of
   v3.17, not a page heading). Bump the version in **both** the `<title>` and the footer when
   shipping a change.
5. **Static & deployable.** No backend, no build, no secrets, no bundler. Everything must
   work from a plain static host (and reasonably from `file://`).
6. **Accessibility.** Canvases carry `role="img"` + `aria-label`; controls carry `aria-label`.
   Keep these in sync when changing a chart's meaning.

## Code layout within the single file

Roughly top-to-bottom:

- `<head>` / CSS — theme variables, responsive layout rules (see below).
- `<body>` markup — header controls: the **location selector** pill (`#locSel`, see below),
  EN/HR (`btn-en`/`btn-hr`), refresh (`btn-rf`), and one alternating sun/moon theme icon
  (`btn-theme`, `toggleTheme()` — large-font mode and its separate button were removed in
  v3.17; use the browser/system zoom instead). Below that, the **alert banner** (`#alertBox`,
  full-width, above `#tabs`, hidden with no content when there's nothing to warn about — see
  below) and the **tab nav** (`#tabs`, `nav`/`role=tablist`): Weather, Map, BBQ, Hiking, in that
  order (`tab-weather`/`tab-map`/`tab-bbq`/`tab-hike`); Info has no tab entry, reached only via
  the footer's "Info & changelog" link. On desktop `#tabs` renders as the classic top tab bar;
  in the `mobile` and `mid` layout steps the **same element** is restyled (CSS only, no markup
  change) into a fixed, app-like bottom navigation bar — icons + labels stacked, safe-area
  aware (`env(safe-area-inset-bottom)`, `viewport-fit=cover` in the viewport meta) — and is
  hidden (`#tabs.navhide`) while the full-screen Map view is open, since that view has its own
  ✕ close control. Then `#dash`'s per-view `<section>`s:
  Weather view (`#view-weather`): a top card grid (`#nowCards`, no heading) ending with a
  TOMORROW card (range/icon, vs today / vs normal / vs last year via `climo.ly.tomMax`, plus —
  as of v3.15 — rain % and wind) and the 🗺️ map launcher card · HOUR BY HOUR (`#todaySec`,
  always the rolling next-24-h window with the 3-day slider — `TOFF`/`setTOff()` — no separate
  "today" vs "next 24h" mode any more, and its hour icons are twice the old size) · NEXT 24
  HOURS (`#hrSec`, pressure-overlay switch `btn-pr`/`togglePres()` on its heading) · SEA
  TEMPERATURE (`#seaSec`, shown for coastal locations incl. in comparison; the waves/swell/
  current line, `#seaWaveLine`/`buildSeaWaveLine()`, is single-location only) · OUTLOOK
  (`#outlookSec`, confidence switch `btn-cf`/`toggleConf()` on its heading) · WEEKEND PLANS ·
  BIOMETEO (comfort card +, as of v3.15, a 72 h PRESSURE TREND chart — `drawPressure`/`presCh`,
  summary above/legend below like every other chart) · AIR QUALITY (`#aqiSec`) · MOON & TIDE ·
  INTERESTING FACT. (No RIGHT NOW heading, no station line, and no GRILLING section any more —
  all removed/relocated in v3.17.) The MAP view (`#view-map`, full-screen, layered — see above)
  and BBQ view (`#view-bbq`: hero/verdict cards · PREP TIMELINE · TODAY'S GRILL SCORE BY HOUR ·
  **GRILLING** (`#grSec`, moved here from Weather in v3.17, updated by `updateGrSec()` inside
  `renderBbq()`) · THE NONSENSE NUMBERS · PIT CHECKLIST, plus the vegan switch `btn-vegan`/
  `toggleVegan()` on its heading) and HIKE view are their own `<section>`s. INFO
  (`#view-info`, about + a `#infoFeeds` data-sources status panel, see below + `CHANGELOG`
  array, bilingual version history, plus the Monty Python switch `btn-mp`/`toggleMP()`) has no
  tab but is still routable at `#info`, with a "← Back" link to `#weather`. The shared footer
  (see convention 4) sits outside `#dash`, with the title, version and the Info link that used
  to live in a page header.
  Severe-weather alerts (`buildAlerts`/`D.alerts`, returns `null` when there's nothing to show
  or `{sev, rows}` otherwise) are derived client-side from Open-Meteo (storm code / strong wind
  / heavy rain / big swing / extreme UV / dangerous heat / dangerous cold, the last three added
  in v3.15) — official DHMZ/Meteoalarm feeds are CORS-blocked from the browser, so they'd need a
  Worker proxy. `updateAlertBox()` (called from `render()`, `renderActive()` and `showView()`)
  rebuilds `#alertBox` on every view render: one detailed row per alert (icon, message, "today
  at HH:MM"/"tomorrow at HH:MM" context), or hides the banner entirely when `buildAlerts()`
  returns `null`. WEEKEND PLANS rates this & next weekend for hiking/biking/running using a
  forced 14-day lookahead (`D.daysFull`). The MAP section is click-to-forecast: tapping any
  point reverse-geocodes it (Nominatim) and loads that point's forecast via
  `onMapClick`/`pickPoint`. (The old fixed DHMZ-station list was removed in v2.29.) The Hiking
  view (`renderHike`) scores on real hourly data (visibility/freezing-level/gusts/snowfall from
  `D.hx`/`D.gustMax`) when the direct feed provides it — fog/snow-line/gust cards and a 5th
  trail-score component — falling back to its older estimates for the reduced AI-feed object.
  The `#infoFeeds` panel (`renderFeeds()`, called from `renderInfo()` and every 60 s while the
  Info page is open) lists one row per entry in `FEEDS` (forecast/marine/air/climo/radar/
  lightning/ai/pwa — the last is the offline app-shell service worker, see "PWA support files"
  above): a coloured dot, live/failed/not-used-yet status, last-update time and age, and any
  error text.

  **Location selector** (`#locSel` pill in `hdrRow` → `#locPanel` with `#locSearch` +
  `#locList`): tap the pill (`locOpen()`) to open a panel listing, in order, live search
  results while typing (`locSearchInput()`/`locDoSearch()` against `geocoding-api.open-meteo.com`,
  300 ms debounce, results shown first because they'd otherwise be hidden under the phone
  keyboard), "This location" (`GEO_LOC`, geolocation), the clicked map point (`MAP_LOC`, if
  any), then recent places (`recents`, `localStorage` `wd_recents`, removable). The selection
  model is **not** checkbox-style: it holds at most 2 picks. Tapping a row (`locPick(name)`)
  makes that place the *only* selection (the common "switch city" case) and closes the panel;
  each unselected row also has a "+ compare" button (`locCompare(name)`) that sets it as the
  second, comparison location B instead; tapping the already-selected B row removes it; tapping
  the already-selected A row promotes B to A (if a B is set). Reaching 2 selections is what
  starts comparison mode. Enter in the search box with results loads the first result; with no
  results (feed slow/unavailable) it loads the typed name directly (`locSearchKey()`). Exact
  coordinates for names the user actually picked from search are cached in `LOCHINT`
  (`localStorage` `wd_lochint`, via `locHintSave()`) and `geocode()` consults that cache before
  falling back to a fresh geocoding-API lookup. Closing the panel with a pick (`locClose(true)`)
  applies the staged selection to the live `selB`/location-A input and triggers `loadData()`
  (location A changed) or `loadSecondary()`/clears `D2` (only B changed).

  **Responsive layout** (`applyResponsive()`): three steps by `window.innerWidth` — `mobile`
  (`<700px`), `mid` (`700–1099px`, e.g. foldables/tablets — falls through to the desktop
  branch of most `layout==='mobile'` checks, but gets its own two-column `#wxGrid` and the
  bottom tab bar), `desktop` (`>=1100px`). The top card grid (`.cards`) is 2 columns below
  480px, 3 columns from 480px up to the mobile/mid boundary, and 4 columns in `mid`.
- `<script>` — organized by `/* ---------- ... ---------- */` banners:
  state/helpers (incl. `FEEDS`/`feedMark()`, per-source health for the Info status panel) ·
  `T` translations · data sources (forecast / marine / air / climatology / AI) ·
  orchestration (`loadData`, `fetchFor`, …) · recents/selection/location selector
  (`locOpen`/`locPick`/`locCompare`/`locClose`/`geocode`, …) · rendering (`render`, `card`, …) ·
  chart drawers (`drawHourly`, `drawSea`, `drawWeek`, `drawBio`, `drawPressure`, `drawGrill`,
  `drawMT`, `drawBbqTimeline`, `drawBbqGrill`, `drawHikeComfort`, `drawHikeWeek`) ·
  maps (`loadLeaflet` weather map incl. the `locateOnMap` 📍 my-location control) · view router
  (`ROUTES`/`VIEWS`/`showView`/`renderActive`/`updateAlertBox`) · Info panel (`renderInfo`,
  `renderFeeds`, `CHANGELOG`).

Notable globals: `lang`, `theme`, `layout` (`'mobile'`/`'mid'`/`'desktop'`), `RANGE`,
`TOFF` (hour-strip window offset), comparison state (location A vs B, `selB`/`D2`), location
caches (`LOCHINT`, `GEO_LOC`, `MAP_LOC`), and feature toggles (`CONF`, `MOON`, `TIDE`, `PRES`,
`BBQ`, `VEGAN`, `MP`). `MP` is a "Monty Python" easter-egg label set. User prefs (recents)
persist via `localStorage` (`wd_recents`); picked-location coordinates persist via `wd_lochint`.

## Making changes

- Edit `weather-dashboard.html` directly; keep the section-banner organization.
- When touching a chart: update its summary, legend, and `aria-label` together, and make sure
  it redraws correctly across theme switch and language switch.
- Bump the version (`<title>` + footer) on user-visible changes.
- Verify by eye in a browser in both themes, both languages, and all three layout steps
  (mobile/mid/desktop) before committing.
