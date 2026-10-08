# CLAUDE.md

Guidance for working in this repository.

## What this is

**Patrik's weather daily** — a bilingual (English / Croatian) weather dashboard.
The entire app is a **single self-contained file**: [weather-dashboard.html](weather-dashboard.html)
(HTML + CSS + vanilla JS, ~4,000 lines). Current version: **v3.20** (also in the `APPV` JS constant,
used for the dynamic `document.title` and to tag `wd_last` snapshots — bump `<title>`, the footer and
`APPV` together, add a `CHANGELOG` entry, and bump `CACHE` in `sw.js`).

There is no build step, no bundler, no package manager, and no backend. It is opened directly in a
browser or served as a static file. Keep it that way.

`index.html` is **not** the app — it's a tiny redirect stub so the bare domain
(e.g. `weather-daily.pages.dev/`) forwards to `weather-dashboard.html`. All real work happens in
`weather-dashboard.html`.

### Shape of the app

A **five-view SPA in one file**: a tab bar + hash router (`#weather`/`#bbq`/`#hike`/`#map`/`#info`;
`#swim` redirects to `#weather`, `#radar` redirects to `#map`) over a `VIEWS`/`ROUTES` registry. Info has
no tab: it is reached only through the footer's "Info & changelog" link (`#info`), with a "← Back" link
inside the view; the route also works directly. One shared data fetch (`D`, plus `D2` for a comparison
location) feeds all views. `showView(name)` toggles the `#view-*` sections, calls `destroyAllCharts()`,
then dispatches the active view's render via `setTimeout(0)` (NOT rAF — throttled in background tabs).
The global hooks `applyTheme`/`setLang`/`applyResponsive` (plus the switch toggles) call
`renderActive()`, so only the visible view re-renders. Both `showView` and `renderActive` also refresh the
alert banner (`updateAlertBox()`), the footer line (`updateFoot()`) and the tab badges (`updateTabs()`),
so the footer, the retry button and the failure notes show on every view.

The tab bar (`#tabs`) is the classic top bar on desktop. In the `mobile` and `mid` layouts the **same
element** is restyled (CSS only) into a fixed bottom navigation bar: 30 px monochrome inline-SVG icons,
no visible label (the label stays for screen readers, visually hidden) and no peek badge. Desktop keeps
text labels and peeks. The bar **stays visible on the Map view**: `showView()` sets `#tabs.onmap`;
desktop hides the top tabs there, mobile/mid keep the bar above the map and hide the map's ✕.

Header controls: the location pill (`#locSel`), ONE language toggle (`btn-lang`, `toggleLang()`, shows
the current language code) and one alternating sun/moon theme icon (`btn-theme`). There is no refresh
button — data refreshes through the TTLs and the tab-visibility refetch; `hardRefresh()` is called only
by the two "Try again" buttons (`#btn-retry` on the error screen, `#footRetry` in the footer). Large-font
mode was removed (use browser/system zoom).

Boot is instant and stale-while-revalidate: `initLoc()` fires `loadData()` for the current location
immediately (GPS/Nominatim resolve in parallel and only trigger a refetch if they land >2 km away), the
last direct-mode forecast is cached to `localStorage` (`wd_last`) and rendered right away while a
background refetch runs, async climo/marine/air arrivals are coalesced through `scheduleRender()` (150 ms
debounce), and forecast/marine/air caches carry short TTLs (15 min / 30 min) with a refetch on tab
visibility and a bilingual "updated X min ago" footer chip (`footChip()`, refreshed every 60 s by
`refreshFootChip()`). `wd_last` snapshots carry `v:APPV` and are **ignored across versions** (a snapshot
without a version is ignored too).

### Location time (never browser time)

Everything that means "now", "today" or "yesterday" uses the **forecast location's clock**, not the
browser's, so Tokyo seen from Zagreb is right and 23- or 25-hour clock-change days do not shift hours.

- `LOCTZ` holds `{off,name}` — the UTC offset in seconds (Open-Meteo `utc_offset_seconds`) and the IANA
  `timezone` of the shown place. `setLocTz(tz)` sets it; a missing or invalid `tz` (AI-mode object, old
  snapshot) **resets it to browser time**, never keeps a stale location. It is called wherever `D` is
  assigned (fresh fetch, `wd_last` restore, in-memory cache hit).
- `locNow()` returns a `Date` whose local getters show the location's wall-clock time (DST-safe: the
  browser offset is re-read at the shifted instant); `locNowStr()` is the same as `YYYY-MM-DDTHH:MM`
  (the format of Open-Meteo's time strings); `todayIso()` (its date part) and `nowMin()` (minutes since
  local midnight) are built on top of it. `locNowAt(off)`/`locNowStrAt(off)` take an explicit offset.
- The pure forecast builder `buildOpenMeteo(j,loc,range)` takes the raw Open-Meteo response and indexes
  **by time strings**: `nowIdx` is the first hourly row whose time string is after `current.time`,
  `tDay` is the index of today's date in `daily.time`, and `dayRows(date)` gives a day's `[start,end)`
  hourly row range from a date→rows map. It never uses the browser clock and never assumes 24 rows per
  day; yesterday's comparison hour is found by hour string inside yesterday's rows.
- Marine and air-quality responses are compared against `locNowStrAt(j.utc_offset_seconds)`, i.e. each
  response's **own** offset (falling back to `LOCTZ.off`), because their `time` strings are in that
  response's zone.
- Open-Meteo `is_day` marks night hours (`hours[].night`); `nightOf(d)` is the same test for "now" from
  the sunrise/sunset strings. `iconFor(r)` returns `ICON[cond]` or, when `r.night`, `ICON_NIGHT[cond]`
  (moon for clear, cloud for partly cloudy); the hero, the hour strip and the charts use it.

### PWA support files

The app is installable (Android/Chrome "Install app", iOS "Add to Home Screen", standalone display) with
an offline app shell. This is the **one deliberate exception** to "single self-contained file":
`manifest.json`, `sw.js`, the `icons/` PNGs, and the `tools/make-icons.js` script that generates them are
the only other files the site ships (`tools/test-time.js` is a dev-only test, see "Running it"). None of
them touch app data or behaviour — `sw.js` precaches only the HTML shell (this file, `index.html`,
`manifest.json`, the icons) and the two pinned CDN library files/styles (Chart.js, Leaflet JS+CSS); it
never intercepts or caches an API or map-tile request — those always go straight to the network,
untouched, exactly as if the service worker did not exist. `tools/make-icons.js` is a dependency-free
node script (hand-rolled PNG encoder: raw RGBA scanlines → `zlib.deflateSync` → PNG chunks with a
hand-rolled CRC32) that regenerates the three icon PNGs; `tools/` is excluded from the deployed site via
`.assetsignore`. **Bump `CACHE` in `sw.js`** (currently `wd-shell-v3.20`) with every release, since the
shell is the HTML, and whenever the precache list or pinned CDN versions change — the old cache is
dropped on activate. The SW registers only on `https:` (never on `file://`, and it's a no-op if
registration fails — the page works identically without it); its status is reported through the same
`FEEDS`/`feedMark('pwa', …)` mechanism as every other data source and shown as a `pwa` row on the Info
page. When a new SW takes over an already-open tab (`controllerchange`), the app does **not** auto-reload
— it appends a bilingual "new version ready — reload" / "nova verzija spremna — osvježi" note to the
footer chip instead.

### Weather view (`#view-weather`) — DOM order

1. `#cmpNote` — in comparison mode, one line saying what is compared (`T.cmpNote`, `{A}`/`{B}`).
2. `.toprow` — `#hero` (`renderHero()`: temperature, feels like, low–high, rain % + mm, icon, and the
   day verdict from `todayVerdict(l)`; two columns when comparing) and `#stats` (`renderStats()`: four
   chips — wind, UV, air quality, pressure; two values with A/B dots when comparing). Each chip is a
   button: `statGo(k)` scrolls to the hour chart / OUTLOOK, or opens the `air` / `bio` group and scrolls
   to it.
3. `#todaySec` — HOUR BY HOUR: `#todayStrip`, drawn by `renderTodayStrip()` → `renderStripWindow()`. No
   slider and no `TOFF`: every 3-hour point of `D.h3ext` from now (about 4 days) in one horizontal
   `.dragx` strip — touch scrolls natively, a delegated mouse-drag handler scrolls it with the mouse,
   arrow keys when focused; any element with class `dragx` gets this behaviour.
4. The daily text block (`#todayLbl`, `#badge`, `#recTxt`: day sentence, traffic-light badge, advice and
   one BBQ line; when comparing, a `buildVersus()` line and both places' sentences, no badge).
5. `#wxGrid` (a plain wrapper — charts are full width on foldables too): `#hrSec` NEXT 24 HOURS
   (pressure-overlay switch `btn-pr`/`togglePres()` on its heading; pressure overlay ON by default) →
   `#outlookSec` OUTLOOK → `#weekendSec` (WEEKEND PLANS, `buildWeekendBlock(l)`). OUTLOOK has two
   control rows: range pills 3d / 7d / 14d / 16d (`btn-r3`…`btn-r16`; 16 days is the real Open-Meteo
   maximum) + the chart-colour modes STD / °C / Δ° (`btn-c0/1/2`, `CMODE`); then the overlay pills
   🌙 Moon, 🌊 Tide, 🔥 BBQ (`btn-moon`/`btn-tide`/`btn-bbq`, labels from T keys `pillMoon`, `pillTide`,
   `pillBbq`) and the confidence switch `btn-cf`.
6. Four collapsible `<details class="grp">` groups, **closed by default**, each with a one-line live
   summary in its header (`grpSum-*`): `grp-air` (AQI, PM2.5, PM10 and dominant-pollutant cards via
   `aqiCardHtml()`/`pmCardHtml()`, plus the AIR QUALITY chart `#aqiSec`), `grp-cmp` (today's max with
   vs-yesterday / last-year / normal context, the TOMORROW card, humidity, the Chance-of-rain card with
   the daily mm), `grp-sea` (SEA TEMPERATURE `#seaSec` + waves/swell/current line `buildSeaWaveLine()`,
   and TIDE `#tideSec`; hidden for inland places), `grp-bio` (BIOMETEO comfort `#bioSec`, 72 h PRESSURE
   TREND `#presBlk`, MOON `#moonSec`). `renderGroups()` fills the cards and summaries and sets `GSHOW`
   (which group charts have data right now); `GROUPS` is the open state, saved in `wd_prefs.groups`;
   `initGroups()` wires each group's `toggle` event; `openGroup(k)`/`grpOpen(k)` open/test a group;
   `drawGroupCharts(k)` draws a group's charts when it opens (`drawAqi`, `drawSea`, `drawTide`,
   `drawBio`, `drawPressure`, `drawMoon` — `drawTide` and `drawMoon` were split out of the old
   `drawMT`). **Charts inside a closed group are not drawn**: each drawer returns early unless
   `grpOpen`.
7. `#factSec` — INTERESTING FACT.

The old `#nowCards` grid, the RIGHT NOW heading, the station line, the GRILLING section on Weather and
the map launcher card are gone. The warning banner `#alertBox` sits above `#tabs`.

### Logic shared between views

- **One BBQ number.** `bbqToday(d,crit)` is the hourly compound score (`grillCompound`, criteria
  `BBQCRIT`: time/temp/rain/wind/humid/storm). Its peak (best hour still ahead, or the day's best once
  the day is over) is THE number: the daily text line, the `pk-bbq` tab badge, the BBQ hero, the GRILLING
  summary and the A-vs-B verdict all use it. It falls back to the day-level score when there is no
  hourly data (reduced AI-feed object). `bbqScore(d)`/`bbqDay(x,bs)` remain for **per-day** values that
  have no hourly rows: the OUTLOOK fire overlay, the GRILLING day bars and the weekend block.
- **One weekend block.** `buildWeekendBlock(l)` (BBQ rating from `weekendBbq(grp)`, shared Sat/Sun
  grouping with the lone-Sunday skip) is the single component rendered into `#weekendTxt` on Weather and
  `#bbqWkTxt` on BBQ: this & next weekend rated for BBQ, hiking, biking and running from a forced 14-day
  lookahead (`D.daysFull`).
- **Severe-weather alerts** (`buildAlerts`/`D.alerts`, `null` when there is nothing to show, else
  `{sev, rows}`) are derived client-side from Open-Meteo (storm code / strong wind / heavy rain / big
  swing / extreme UV / dangerous heat / dangerous cold) — official DHMZ/Meteoalarm feeds are CORS-blocked
  from the browser. `updateAlertBox()` rebuilds `#alertBox` on every view render (icon, message,
  "today at HH:MM"/"tomorrow at HH:MM"), or hides it.
- **Daily precipitation amount:** `fullDs[].mm` (Open-Meteo `precipitation_sum`, mm/day), formatted by
  `mmTxt()`; shown on the OUTLOOK chart labels + tooltip + summary total, the hero, the Tomorrow card and
  the Chance-of-rain card.

### Preferences and local storage

`wd_prefs` (`PREFS_KEY`) is written by `savePrefs()` and read once at boot by `loadPrefs()`. It stores
`lang`, `theme`, the switches `CONF`/`MOON`/`TIDE`/`PRES`/`BBQ`/`VEGAN`, the chart mode `CMODE`, and
`groups` (open state of the four groups). **MP (Monty Python) is deliberately not stored.** `PREFS_LIVE`
is `false` during boot, so reading the saved prefs never rewrites them; it flips to `true` at the end of
boot. **First visit** (no `wd_prefs`): `lang` follows `navigator.language` (`hr*` → Croatian, otherwise
English) and the theme follows the OS preference. A new switch must be added to both `savePrefs` and
`loadPrefs`.

All `localStorage` keys (every access wrapped in try/catch): `wd_recents` (recent places), `wd_lochint`
(exact coordinates of places picked from search), `wd_bbqcheck` (BBQ checklist ticks), `wd_last` (last
direct-mode forecast snapshot `{v:APPV,key,loc,t,D}`, ≤ 400 kB), `wd_prefs`.

### Comparison mode (location A vs B)

Reaching two selections starts comparison. **What compares:** the hero and stat chips, the group cards,
the NEXT 24 HOURS chart, the sea chart and the OUTLOOK (A and B series), plus the versus line in the
daily text block. **What shows A only:** the hour strip, the weekend block, the air, tide, bio, pressure
and moon charts, and the whole BBQ and Hiking views. `#cmpNote` states this on Weather; BBQ and Hiking
show a `setOnlyChip(id)` chip (`bbqOnly`/`hikeOnly`, text `T.onlyA` "only {A}"). If the second place
fails to load, `FOOT_NOTE` holds its name and the footer chip adds a bilingual "⚠ Second location
failed: …" note (`T.secFail`) until the next location change. `buildLegends()` draws each legend to match
its chart in both modes (the tide legend follows the tide chart).

### Failure visibility

Every data source reports its own health via `FEEDS[name]={t,ok,err,na}`, written by
`feedMark(name,ok,err,na)` for forecast/ai/marine/air/climo/radar/lightning/pwa; `na:true` means "this
source has nothing for this place" (inland marine) and is **not a failure**. When a side source (sea,
air, normals) fails for the shown place, `noteSrcFail(d,feed,field)` records it in `SRCFAIL` (a `WeakMap`
keyed by the forecast object, so it never reaches `wd_last`), and `srcFailNote()` turns it into a
"⚠ unavailable: sea, air, …" note in the footer chip (`footChip()`). A failed background refresh sets
`lastRefreshFailed`, adds "refresh failed" to the chip and reveals `#footRetry`; the error screen has
`#btn-retry`; both call `hardRefresh()`. The Info page lists one row per source (`renderFeeds()`,
`#infoFeeds`, `FEED_ROWS`, refreshed every 60 s while open): coloured dot, live/failed/not-used-yet,
last-update time and age, error text. The marine row reads "no sea here" only when the feed's `na` flag
is set, so a real network failure on a coastal place reads "failed". The footer's source label comes from
`D.srcKey` (a translated `T` key such as `srcBest`, "Open-Meteo · best model") with `D.src` as the
fallback for the AI feed.

### i18n helpers and controls

Static markup uses `data-i="key"` (sets `textContent` from `LBL[key]`) and `data-tt="key"` (sets `title`
**and** `aria-label` from `LBL[key]`; canvases and `role=img` boxes get `aria-label` only).
`applyTitles()` applies the `data-tt` keys on `setLang` and also sets the tooltips of the header/switch
buttons from the `tt_lang`, `tt_theme`, `tt_pr`, `tt_cf`, `tt_mp`, `tt_vegan` keys; chart aria-labels are
the `ar_*` keys. `.lbtn`, `.rbtn` and `.mly` are `min-height:36px` on desktop and **44 px in `mobile` and
`mid`** (as is `.locsel`; the `.stat` chips and the group summaries are 44 px everywhere); toggles and pills use text labels from T
keys, not bare emoji.

### Map view (`#view-map`)

A **full-screen weather map** (`renderMapFull`/`drawRadarMap`, Leaflet map `radarMapL`): keyless
**OpenStreetMap** basemap (`mapBaseUrl`; an optional `CARTOKEY` restores CARTO Positron) with its own
light/dark switch (`MAPTHEME`/`mapThemeToggle`, independent of the app theme) — dark mode is a CSS invert
on the base tiles (`.mapdark .basetiles`) — zoom to 19 (radar tiles stretched via `maxNativeZoom:7` —
RainViewer's free tiles END at z7; requesting deeper native tiles returns "Zoom Level Not Supported"
error tiles), toggleable layers in `MLAYERS`/`mlyToggle`: RainViewer radar frames with timeline (at most
**two frames stay attached** at a time, current + preloaded next, so panning doesn't refetch every
frame), Blitzortung live lightning (reconnects with exponential backoff), and an Open-Meteo **point
grid** (`gridRefresh`/`gridDraw`: a temperature IDW heatmap with a legend, wind arrows, 48 h rainfall,
cloud cover; cache keyed to a zoom-scaled cell so high-zoom pans stay accurate). The grid fetch carries
24 h of hourly temperature/wind/gusts/cloud/precip per point, and a **⏱ time-scrub slider** in the bottom
panel (0 = now … +24 h) redraws the heatmap, labels and rain/cloud blobs for the chosen hour straight
from that cached response — no refetch while scrubbing; the legend and the next-2h rain strip's pill
re-label to match. Wind labels show gusts in parentheses when they clear speed+5. Also the next-2h rain
strip, click-to-forecast (`onMapClick`/`pickPoint`: reverse-geocodes the tapped point with Nominatim and
loads its forecast) and a **📍 my-location** Leaflet control (`locateOnMap`) that geolocates and
recentres/pins the map. Layout: on `mobile` only, `#mlyPills` (the layer buttons) is a fixed swipeable
row right above the bottom bar and `#mapBottom` sits above that row; on `mobile` and `mid` the zoom and
locate controls are top-right (below the top row), clear of the bottom panel, and the attribution text
lives in the bottom panel. The ✕ (desktop only) returns to `#weather`.

## Running it

Just open `weather-dashboard.html` in a browser, or serve the folder statically:

```powershell
python -m http.server 8000   # then visit http://localhost:8000/weather-dashboard.html
```

A few features need a `https://`/`http://` origin rather than `file://` (browser geolocation, some
fetches), so prefer the local server when testing those.

**iOS caveat:** iPhone/iPad Safari blocks **all** network requests on `file://` pages, so opening the raw
`.html` directly on iOS leaves it stuck/erroring with no data — it must be served over `http(s)` (GitHub
Pages, Netlify, or a LAN web server) to work on a phone. The error screen explains this, and the AI-feed
fallback (`fetchAI` → `tfetchP`) has a timeout so a failed load shows the error rather than hanging.

**Time regression test** (dependency-free, node ≥ 18):

```powershell
node tools/test-time.js
```

It spawns itself twice with `TZ=Europe/Zagreb` and `TZ=America/New_York`. Each child extracts the app
`<script>`, pulls the functions it needs by name and runs fixture Open-Meteo responses through
`buildOpenMeteo()`: Tokyo (all 24-row days), a DST fall-back day (25 rows) as yesterday and as today, a
spring-forward day (23 rows); it also checks the location clock (`locNow`/`locNowStr`/`todayIso`, the
`setLocTz` reset), the `wd_last` snapshot version/tz round trip, and statically that the builder reads
no clock. It prints `TIME TESTS OK` and exits 1 on any failure.

## Data sources (all keyless, all client-side)

- **Open-Meteo forecast** — `api.open-meteo.com` (`timezone=auto`, `past_days=1`; hourly + daily +
  `minutely_15` precipitation for the next-2h rain strip, `D.rain15`; hourly carries `pressure_msl`
  (72 h pressure trend, `D.presH`), `is_day` (night icons), `visibility`, `freezing_level_height`,
  `wind_gusts_10m` and `snowfall` (today's values in `D.hx`), plus daily `wind_gusts_10m_max`
  (`D.gustMax`) and `precipitation_sum` — these feed the Hiking view's visibility/snow-line/gust cards
  and the map's gust-aware wind labels) and `geocoding-api.open-meteo.com` for city → lat/lon.
- **Open-Meteo Marine** — `marine-api.open-meteo.com` (sea surface temperature, tides, plus wave
  height/swell height+period/ocean current — the sea group shows a waves/swell/current line built by
  `buildSeaWaveLine()` for coastal locations, single location only). A 400 response means "no sea point
  here" (inland) and is marked `na`, not failed.
- **Open-Meteo Air Quality** — `air-quality-api.open-meteo.com` (pollen + `european_aqi` with a past day
  and 3-day hourly forecast → AQI cards + AIR QUALITY chart; `pm10`/`nitrogen_dioxide`/`ozone`/`dust`
  for the pollutant breakdown).
- **Blitzortung.org** — live lightning strikes over websocket (`ws1/ws7/ws8.blitzortung.org`,
  LZW-decoded JSON) as a ⚡ toggle layer on the Map. Live-only (accumulates while the view is open),
  suspended when leaving the tab, attribution required, non-commercial use.
- **OpenStreetMap tiles** (`tile.openstreetmap.org`) — keyless base map for the Map view; its dark mode
  is a CSS invert. CARTO Positron (`basemaps.cartocdn.com`) was dropped in v3.13 when CARTO made its
  basemaps key-only (tiles come back watermarked "API KEY REQUIRED"); setting the `CARTOKEY` constant to
  a free key from carto.com/basemaps/apikey restores it.
- **Open-Meteo Archive** — `archive-api.open-meteo.com` (1991–2020 climatology / anomalies).
- **AI feed (optional secondary)** — a Claude + web-search "interesting fact" / outlook feed. The
  dashboard degrades gracefully when this is unavailable; its reduced forecast object has no `tz`
  (browser time) and none of the hourly extras.
- **Nominatim** (`nominatim.openstreetmap.org`) — reverse geocoding for map clicks / GPS.
- **RainViewer** (`api.rainviewer.com` + `tilecache.rainviewer.com`) — rain-radar tile frames for the Map
  view: past ~2 h plus nowcast frames when the public API provides them (lazy; frame list cached ~5 min;
  requires "© RainViewer" attribution).

All requests go through `tfetch(url, ms)`, a `fetch` wrapper with a timeout.

## Third-party libraries (CDN only — keep it that way)

- **Chart.js 4.4.1** — `cdnjs.cloudflare.com/.../Chart.js/4.4.1/chart.umd.js` (loaded eagerly, with a
  second CDN as fallback).
- **Leaflet 1.9.4** — `cdnjs.cloudflare.com/.../leaflet/1.9.4/...` (lazy-loaded via `loadLeaflet()` only
  when the map section is shown). Map tiles © OpenStreetMap.

Pin exact versions from **cdnjs**. Do not add npm dependencies or a build pipeline.

## Conventions — ALWAYS follow these

These are the non-negotiable house rules for any change:

1. **Bilingual everywhere (EN / HR).** Two accepted patterns: (a) shared/static strings live in the `T`
   translation object (`T.en` / `T.hr`, identical key sets), looked up via `LBL`; static markup uses
   `data-i="key"` (text) or `data-tt="key"` (title + aria-label); (b) **view-local strings** (BBQ/Hiking
   cards, phases, grades) may be inline `hrv?'…hr…':'…en…'` ternaries inside their render function, since
   those re-run on `setLang`. Either way, EVERY user-visible string — tooltips and aria-labels included —
   must exist in both languages, never EN-only. Exception: Monty-Python (`MP`) easter-egg lines are
   intentionally English in both languages. When the last reference to a `T` key goes away, delete the
   key from BOTH languages.
2. **Light & dark themes.** Colors come from CSS variables and the `calc()` palette (`BG`, `txt`,
   `strong`, `grid`, …). `applyTheme('light'|'dark')` toggles; charts must re-read theme colors on
   redraw. Never hardcode a raw color that breaks in either theme.
3. **Summaries above charts, legends below.** Each chart section follows the order: heading → one-line
   summary paragraph (`…Sum`) → canvas → legend (`…Leg`). Legends are custom DOM
   (`display:flex;flex-wrap`), not Chart.js's built-in legend (`legend:{display:false}` throughout);
   `buildLegends()` owns them and must match what the chart draws, in comparison mode too.
4. **Versioned footer.** Footer reads `<span id="foot"></span> · PATRIK'S WEATHER DAILY · vX.YY · by
   Patrik Pencinger · Info & changelog`. Bump the version in `<title>`, the footer and `APPV` together.
5. **Static & deployable.** No backend, no build, no secrets, no bundler. Everything must work from a
   plain static host (and reasonably from `file://`).
6. **Accessibility.** Canvases carry `role="img"` + `aria-label` (`data-tt="ar_*"`); controls carry
   `aria-label`. Keep these in sync when changing a chart's meaning.
7. **Location time, never browser time.** Anything meaning now / today / yesterday / which hourly row to
   show comes from `locNow()`/`locNowStr()`/`todayIso()`/`nowMin()` or from the response's own time
   strings and offset — never from `new Date()`/`Date.now()` for forecast logic, never `getHours()` of
   the browser clock, never "24 rows per day". Call `setLocTz()` whenever `D` is replaced. Run
   `node tools/test-time.js` after touching the builder or any time code.
8. **Charts inside closed groups are not drawn.** A drawer for a chart inside a `grp-*` group must return
   early unless `grpOpen(k)`; opening the group draws it (`drawGroupCharts`). Do not assume the canvas of
   a closed group has a size or a Chart.js instance.
9. **Failures are visible.** A new data source reports through `feedMark()` (with `na` for "nothing
   here"); a failed side source is recorded with `noteSrcFail()` so the footer says so; never swallow a
   failure into an empty-looking section.
10. **Tap targets.** Interactive controls are ≥ 36 px tall on desktop and 44 px on `mobile`/`mid`.

## Code layout within the single file

Roughly top-to-bottom:

- `<head>` / CSS — theme variables, responsive layout rules (`#wrap.mobile` / `#wrap.mid` / desktop),
  card/hero/stat/group styles, the control sizes above.
- `<body>` markup — header (`#locSel`, `btn-lang`, `btn-theme`), `#alertBox`, `#tabs` (Weather, Map, BBQ,
  Hiking — `tab-weather`/`tab-map`/`tab-bbq`/`tab-hike`), then `#dash`'s per-view `<section>`s:
  `#view-weather` (DOM order above), `#view-bbq` (hero/verdict · WEEKENDS `#bbqWkTxt` · PREP TIMELINE ·
  TODAY'S GRILL SCORE BY HOUR · **GRILLING** `#grSec`, updated by `updateGrSec()` inside `renderBbq()` ·
  THE NONSENSE NUMBERS · PIT CHECKLIST, plus the vegan switch `btn-vegan`/`toggleVegan()` on its
  heading), `#view-hike` (`renderHike`: scores on real hourly data — visibility / freezing level / gusts
  / snowfall from `D.hx`/`D.gustMax` — with fog, snow-line and gust cards and a 5th trail-score
  component, falling back to older estimates for the reduced AI-feed object), `#view-map`, and
  `#view-info` (about + the `#infoFeeds` status panel + the bilingual `CHANGELOG` array + the Monty
  Python switch `btn-mp`/`toggleMP()`). The shared footer sits outside `#dash`. The loading and error
  screens are `#loading` / `#error`.
- **Location selector** (`#locSel` pill in the header → `#locPanel` with `#locSearch` + `#locList`): tap
  the pill (`locOpen()`) to open a panel listing, in order, live search results while typing
  (`locSearchInput()`/`locDoSearch()` against `geocoding-api.open-meteo.com`, 300 ms debounce, shown
  first because they'd otherwise be hidden under the phone keyboard), "This location" (`GEO_LOC`,
  geolocation), the clicked map point (`MAP_LOC`, if any), then recent places (`recents`,
  `wd_recents`, removable). The selection holds at most 2 picks (not checkboxes): tapping a row
  (`locPick(name)`) makes that place the only selection and closes the panel; each unselected row also
  has a "+ compare" button (`locCompare(name)`) that sets it as the second location B; tapping the
  already-selected B row removes it; tapping the selected A row promotes B to A. Enter in the search box
  with results loads the first result; with no results it loads the typed name directly
  (`locSearchKey()`). Exact coordinates of picked places are cached in `LOCHINT` (`wd_lochint`,
  `locHintSave()`) and `geocode()` consults that cache first. Closing with a pick (`locClose(true)`)
  applies the staged selection and triggers `loadData()` (A changed) or `loadSecondary()` / clears `D2`
  (only B changed).
- **Responsive layout** (`applyResponsive()`): three steps by `window.innerWidth` — `mobile` (< 700 px),
  `mid` (700–1099 px, foldables/tablets; falls through to the desktop branch of most
  `layout==='mobile'` checks but gets the bottom bar), `desktop` (≥ 1100 px).
- `<script>` — organized by `/* ---------- ... ---------- */` banners: state/helpers (`FEEDS`/
  `feedMark()`, location clock, prefs, BBQ scoring) · `T` translations · data sources (the pure
  `buildOpenMeteo`, forecast / marine / air / climatology / AI fetchers) · orchestration (`loadData`,
  `fetchFor`, `loadSecondary`, `wd_last` save/restore) · recents/selection/location selector · rendering
  (`render`, `renderHero`, `renderStats`, `renderGroups`, `updateFoot`, `card`) · chart drawers
  (`drawHourly`, `drawSea`, `drawTide`, `drawMoon`, `drawWeek`, `drawBio`, `drawPressure`, `drawAqi`,
  `drawGrill`, `drawBbqTimeline`, `drawBbqGrill`, `drawHikeComfort`, `drawHikeWeek`) · maps
  (`loadLeaflet`, the weather map incl. `locateOnMap`) · view router (`ROUTES`/`VIEWS`/`showView`/
  `renderActive`/`updateAlertBox`) · Info panel (`renderInfo`, `renderFeeds`, `CHANGELOG`).

Notable globals: `lang`, `theme`, `layout` (`'mobile'`/`'mid'`/`'desktop'`), `RANGE`, comparison state
(`selB`/`D2`), location caches (`LOCHINT`, `GEO_LOC`, `MAP_LOC`, `LOCTZ`), `GROUPS`, and the feature
toggles (`CONF`, `MOON`, `TIDE`, `PRES`, `BBQ`, `VEGAN`, `MP`). `MP` is a "Monty Python" easter-egg
label set.

## Making changes

- Edit `weather-dashboard.html` directly; keep the section-banner organization.
- When touching a chart: update its summary, legend, and `aria-label` together, and make sure it
  redraws correctly across theme switch and language switch, and that it is not drawn while its group is
  closed.
- After touching `buildOpenMeteo` or any time code, run `node tools/test-time.js` (it must print
  `TIME TESTS OK`) and add a fixture there for any new time-dependent rule.
- Syntax checks: `node --check sw.js`, and for the page script
  `node -e "const fs=require('fs');const h=fs.readFileSync('weather-dashboard.html','utf8');const m=[...h.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)].find(x=>x[1].length>1000);new Function(m[1]);console.log('SYNTAX OK')"`.
- Shipping a user-visible change: bump the version in `<title>`, the footer and `APPV`; add a bilingual
  `CHANGELOG` entry at the top; bump `CACHE` in `sw.js`; grep the old version number — only historical
  CHANGELOG hits may remain. Update this file in place so it keeps describing the current state (no
  "vX changes override older text" sections).
- Verify by eye in a browser in both themes, both languages, and all three layout steps
  (mobile/mid/desktop) before committing.
