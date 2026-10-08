# CLAUDE.md

Guidance for working in this repository.

## What this is

**Patrik's weather daily** — a bilingual (English / Croatian) weather dashboard.
The entire app is a **single self-contained file**: [weather-dashboard.html](weather-dashboard.html)
(HTML + CSS + vanilla JS, ~4,700 lines). Current version: **v3.22** (also in the `APPV` JS constant,
used for the dynamic `document.title` and to tag `wd_last` snapshots — bump `<title>`, the footer and
`APPV` together, add a `CHANGELOG` entry, and bump `CACHE` in `sw.js`).

There is no build step, no bundler, no package manager, and no backend. It is opened directly in a
browser or served as a static file. Keep it that way.

`index.html` is **not** the app — it's a tiny redirect stub so the bare domain
(e.g. `weather-daily.pages.dev/`) forwards to `weather-dashboard.html`. All real work happens in
`weather-dashboard.html`.

### Shape of the app

A **three-tab SPA in one file** — NOW (Croatian SADA), PLAN (PLANIRAJ) and MAP (KARTA) — plus the tab-less
Info view: a tab bar + hash router over a `VIEWS`/`ROUTES` registry (views `now`/`plan`/`map`/`info`, sections
`#view-now`/`#view-plan`/`#view-map`/`#view-info`). Routes: `#now` (also the empty hash, `#weather` and `#swim`),
`#plan`, `#plan-bbq`/`#plan-hike`/`#plan-bike`/`#plan-run`/`#plan-sea` (open PLAN on that activity),
`#bbq` and `#hike` (old links: open PLAN on BBQ / hiking), `#map` (also `#radar`) and `#info`. `ROUTEACT` maps
the activity-bearing hashes to an activity; `showView('plan')` and the `hashchange` handler apply it to
`PLAN.act`. The separate BBQ and Hiking tabs/views of v3.17–v3.20 were folded into PLAN as activities in
v3.21 (their render functions, `renderBbq`/`renderHike`, are gone). Info has no tab: it is reached only
through the footer's "Info & changelog" link (`#info`), with a "← Back" link inside the view; the route also
works directly. One shared data fetch (`D`, plus `D2` for a comparison
location; always `FCDAYS` = 16 days, see "Data sources") feeds all views. `showView(name)` toggles the `#view-*` sections, calls `destroyAllCharts()`,
then dispatches the active view's render via `setTimeout(0)` (NOT rAF — throttled in background tabs).
The global hooks `applyTheme`/`setLang`/`applyResponsive` (plus the switch toggles) call
`renderActive()`, so only the visible view re-renders. Both `showView` and `renderActive` also refresh the
alert banner (`updateAlertBox()`), the footer line (`updateFoot()`) and the tab badges (`updateTabs()`),
so the footer, the retry button and the failure notes show on every view.

The tab bar (`#tabs`) is the classic top bar on desktop. In the `mobile` and `mid` layouts the **same
element** is restyled (CSS only) into a fixed bottom navigation bar: 30 px monochrome inline-SVG icons
(cloud-sun, clipboard-check, map, in the order NOW · PLAN · MAP; `tab-now`/`tab-plan`/`tab-map`), no visible
label (the label stays for screen readers, visually hidden) and no peek badge. Desktop keeps text labels
(`T` keys `tabNow`/`tabPlan`/`tabMap`) and peeks, set by `updateTabs()`: `pk-now` the current temperature,
`pk-plan` the chosen activity's icon plus its tier dot for today (from `scoreDay`), `pk-map` 🌧️/🗺️. The bar **stays visible on the Map view**: `showView()` sets `#tabs.onmap`;
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
  (moon for clear, cloud for partly cloudy); the hero, the timeline readout and the sticky now-bar use it.

### PWA support files

The app is installable (Android/Chrome "Install app", iOS "Add to Home Screen", standalone display) with
an offline app shell. This is the **one deliberate exception** to "single self-contained file":
`manifest.json`, `sw.js`, the `icons/` PNGs, and the `tools/make-icons.js` script that generates them are
the only other files the site ships (`tools/test-time.js` and `tools/test-score.js` are dev-only tests, see "Running it"). None of
them touch app data or behaviour — `sw.js` precaches only the HTML shell (this file, `index.html`,
`manifest.json`, the icons) and the two pinned CDN library files/styles (Chart.js, Leaflet JS+CSS); it
never intercepts or caches an API or map-tile request — those always go straight to the network,
untouched, exactly as if the service worker did not exist. `tools/make-icons.js` is a dependency-free
node script (hand-rolled PNG encoder: raw RGBA scanlines → `zlib.deflateSync` → PNG chunks with a
hand-rolled CRC32) that regenerates the three icon PNGs; `tools/` is excluded from the deployed site via
`.assetsignore`. **Bump `CACHE` in `sw.js`** (currently `wd-shell-v3.22`) with every release, since the
shell is the HTML, and whenever the precache list or pinned CDN versions change — the old cache is
dropped on activate. The SW registers only on `https:` (never on `file://`, and it's a no-op if
registration fails — the page works identically without it); its status is reported through the same
`FEEDS`/`feedMark('pwa', …)` mechanism as every other data source and shown as a `pwa` row on the Info
page. When a new SW takes over an already-open tab (`controllerchange`), the app does **not** auto-reload
— it appends a bilingual "new version ready — reload" / "nova verzija spremna — osvježi" note to the
footer chip instead.

### NOW view (`#view-now`, tab SADA) — DOM order

Above everything, outside `#dash`, sits `#nowBarW` (a zero-height sticky wrapper) holding the sticky now-bar
`#nowBar` (see below).

1. `#cmpNote` — in comparison mode, one line saying what is compared (`T.cmpNote`, `{A}`/`{B}`).
2. `.toprow` — `#hero` (`renderHero()`: temperature, feels like, low–high, rain % + mm, icon, and the
   day verdict from `todayVerdict(l)`; two columns when comparing) and `#stats` (`renderStats()`: four
   chips — wind, UV, air quality, pressure; two values with A/B dots when comparing). Each chip is a
   button: `statGo(k)` switches the timeline's wind / UV layer on and scrolls to `#tlSec`, or opens the
   `air` / `bio` group and scrolls to it.
3. `#tlRow.tlrow` — the timeline and its story column side by side:
   - `#tlSec` — the **timeline** (VREMENSKA OS), see the next section. When the data has no hourly rows
     (AI feed) `#tlSec` stays hidden and `render()` adds `.notl` to `#tlRow`, so the story column takes the
     full width.
   - `#story` (`<aside>`, the **story column**) — `.storyblk` boxes: the daily text block (`#todayLbl`,
     `#badge`, `#recTxt`: day sentence, traffic-light badge, advice and the grilling line `buildBbqLine()` —
     the engine's number for today and its best window; when comparing, a `buildVersus()` line and both
     places' sentences, no badge); `#tomBlk` (the TOMORROW line, `renderTomorrow()`: range, icon, rain %
     + mm, wind; one row per place when comparing); `#outlookSec` (the one-line outlook sentence `#wkSum`
     from `buildWkSum(l)`, plus the long-range note `#wkNote` when the forecast runs past 10 days) and
     `#weekendSec` (WEEKEND PLANS, `#weekendTxt`, `buildWeekendBlock(l)`). Desktop (≥ 1100 px): a 2/3 +
     1/3 grid — timeline left, `#story` is `display:contents` so its blocks stack in the right third and the
     weekend table takes the full row below both; `mid`/`mobile`: everything stacks (timeline, then story).
4. `#wxGrid` (a plain wrapper — charts are full width on foldables too): the four collapsible
   `<details class="grp">` groups, **closed by default**, each with a one-line live summary in its header
   (`grpSum-*`): `grp-air` (AQI, PM2.5, PM10 and dominant-pollutant cards via
   `aqiCardHtml()`/`pmCardHtml()`, plus the AIR QUALITY chart `#aqiSec`), `grp-cmp` (today's max with
   vs-yesterday / last-year / normal context, the TOMORROW card, humidity, the Chance-of-rain card with
   the daily mm), `grp-sea` (SEA TEMPERATURE `#seaSec` + waves/swell/current line `buildSeaWaveLine()`,
   and TIDE `#tideSec`; hidden for inland places), `grp-bio` (BIOMETEO comfort `#bioSec`, 72 h PRESSURE
   TREND `#presBlk`, MOON `#moonSec`). `renderGroups()` fills the cards and summaries and sets `GSHOW`
   (which group charts have data right now); `GROUPS` is the open state, saved in `wd_prefs.groups`;
   `initGroups()` wires each group's `toggle` event; `openGroup(k)`/`grpOpen(k)` open/test a group;
   `drawGroupCharts(k)` draws a group's charts when it opens (`drawAqi`, `drawSea`, `drawTide`,
   `drawBio`, `drawPressure`, `drawMoon`). **Charts inside a closed group are not drawn**: each drawer
   returns early unless `grpOpen`.
5. `#factSec` — INTERESTING FACT.

Gone from NOW: the `#nowCards` grid, the RIGHT NOW heading, the station line, the GRILLING section (it now
lives in PLAN) and the map launcher card (v3.18–v3.20); and, replaced by the timeline in v3.22, the
HOUR BY HOUR strip (`#todaySec`, `renderStripWindow()`, `D.h3ext` — a 3-hourly strip of the next ~4 days),
the NEXT 24 HOURS chart (`#hrSec`, `drawHourly`) and the OUTLOOK chart (`drawWeek`; `#outlookSec` is now just
the story's sentence block). The switches that belonged to them — the OUTLOOK range pills 3d/7d/14d/16d
(`RANGE`, `btn-r3`…`btn-r16`), the chart-colour modes (`CMODE`), the Moon / Tide / BBQ overlays
(`MOON`/`TIDE`/`BBQ`), the confidence switch (`CONF`) and the pressure-overlay switch (`PRES`,
`togglePres()`) — were removed with them; their roles live on as timeline layers (pressure,
normal-for-the-date, the day-8+ confidence band) or in the day readout (moon phase). In PLAN, the hiking
comfort and 7-day trail-score charts (`drawHikeComfort`, `drawHikeWeek`) were dropped too; `#ps-hike` keeps
the trail cards and the nonsense numbers. The warning banner `#alertBox` sits above `#tabs`.

### Timeline (VREMENSKA OS, `#tlSec`)

One continuous, zoomable, layered time axis on NOW from six hours ago to the end of the forecast (about 16
days). It is a **custom Canvas 2D** drawing (`#tlCanvas` inside `#tlWrap`), not Chart.js. Banner
`/* ---------- VREMENSKA OS / TIMELINE (K1) ... ---------- */`. Only built when `tlOk()` (direct-mode data with
`D.hr` longer than 24 rows).

- **DOM.** `#tlSec`: heading (`T.tlTitle`), summary `#tlSum` (one line for the visible window, `tlSummary()`,
  written only when the text changes), zoom pills `#tlZoom` (`btn-tlz-h` / `btn-tlz-3` / `btn-tlz-d`), layer
  pills `#tlLayers` (`btn-tll-temp`/`-rain`/`-wind`/`-pres`/`-uv`/`-air`/`-sea`/`-score`/`-norm`, a swipeable row on
  mobile), the canvas wrapper `#tlWrap` (height set by `applyResponsive()`: 340 / 300 / 250 px for
  desktop / mid / mobile) with the readout box `#tlReadout`, the legend `#tlLeg` (custom DOM, built by
  `tlLegend()`), and the screen-reader live region `#tlLive` (`role=status`). The canvas has `tabindex=0`,
  `role=img` and `data-tt="ar_tl"`; the pill groups use `tlZoomAria` / `tlLayersAria`.
- **State.** `TL={zoom,layers,x0,cursor}`: `zoom` is `'h'` (hours), `'3'` (every 3 h) or `'d'` (days; the
  order is `TLZ`); `layers` has the nine flags of `TLLAYERS` (`temp, rain, wind, pres, uv, air, sea, score,
  norm`); `x0` is the left edge and `cursor` the selected column, both in "location-local wall-clock
  minutes × 60000" (the `tsMin()` of Open-Meteo's time strings, so a day is always 1440 minutes wide and DST
  never shifts the axis); `cursor===null` means nothing selected. **Only `zoom` and `layers` are remembered**
  (`wd_prefs.tl`; `x0` and `cursor` never are). **Defaults** with no stored preference: exactly temperature, rain
  and score are on; stored preferences win. `TLC` is the derived cache (row minutes `tm`, temperature and
  pressure scale ranges, per-day wind/gust/UV maxima `ag`, the AQI series, the per-hour and per-day scores
  `rs`/`ds`, the pending frame ids `raf`/`to`).
- **Scale.** `TLPX[zoom]=[desktop/mid, mobile]` pixels per hour: hours 34 / 26, 3 h 12 / 9, days 3.2 / 2.6
  (`tlPpm()` = px per minute). A row is drawn centred on its timestamp; `tlSnap(m)` maps a free minute to the
  column it belongs to (the hour, the 3-hour row, or noon of the day).
- **Lanes.** `tlDraw()` lays out lanes top to bottom and collapses lanes that are off: the main area (rain
  columns + pressure line + temperature line/bars, whichever of those layers are on), then wind (speed
  with gusts), UV, air (AQI), sea (SST) and the activity-score lane (each its own small band), above a
  time axis. Day bands, midnight lines with sticky day labels (month labels at day zoom), night shading from
  `hr[].night`, storm-alert windows from `D.alerts`, the "now" line and the cursor column are drawn under/over
  the lanes. Rain: bars of rain % plus mm amounts (plus the next-2h `D.rain15` strip at hours zoom). The
  **score lane** is the planner's activity (`planAct()`): per-hour `scoreHour` bars and the best-window mark
  from `scoreDay`, so the timeline never disagrees with PLAN; its pill is relabelled with the activity
  (`tlSyncUi()`). The **norm layer** (day zoom only; its pill is hidden at the other zooms and without
  `D.climo.byDay`) draws the climatological normal of the daily maximum as a dotted line. Day zoom adds a
  confidence band for day 8+ on the temperature bars. In comparison mode the temperature lane draws A and B
  (`TLC.hr2`/`tm2`, `CMP.a`/`CMP.b`); every other lane shows A only.
- **Interaction** (`tlInit()`, one-time listeners on the canvas). Pointer events: drag pans (`TL.x0`, clamped
  by `tlClamp()` to now − 6 h … the end of the data), a quick tap (< 5 px, < 700 ms) calls `tlTap(px)`;
  horizontal wheel / shift+wheel pans. Keyboard (canvas focused): ←/→ `tlMoveCursor(±1)` (one column), Home
  `tlHome()` (cursor to now), +/− `tlSetZoom` one step, Enter/Space toggles the readout, Esc `tlHide()`.
  `tlSetZoom(z)` keeps the view centred on the cursor (or the view centre); `tlSetLayer(k)` toggles a layer;
  both save the prefs and refresh pills + legend. **The cursor is always a column inside the pannable range**
  (now − 6 h … the last row): `tlCurClamp(m)` snaps and clamps, and `tlTap`, `tlMoveCursor`, `tlHome`,
  `tlSetZoom` and `tlSyncFromMap` all go through it, so `#tlLive` never announces an off-canvas column.
- **Readout.** Tap/Enter opens `#tlReadout` next to the cursor column (`tlPlaceReadout()`); its content comes
  from `tlReadoutLines()` → `{title, lines:[[icon,text]]}` for the **active layers only**, and the same text
  is mirrored into `#tlLive`. A line whose value is missing is skipped (never a lone `°` or an empty rain
  line); numbers go through `tlN()` (HR decimal comma) and mm through `tlMm()` in every zoom. Hour/3 h
  readouts show temperature (+ feels like), rain % · mm (3 h: max % and summed mm), wind (+ gust), pressure,
  UV, AQI, sea, the score; the day readout shows low … high, rain, wind, pressure, UV, peak AQI, sea, the
  normal with its delta, **the moon phase** (`moonIcon`/`moonName`/`moonIllum`; it replaces the removed Moon
  overlay) and the score with its best window.
- **Programmatic access.** `tlGoto(ts)` centres the view on a location-local time string; `tlCursorTs()` returns
  the cursor as `YYYY-MM-DDTHH:MM` (or `null`); `tlInvalidate()` drops the score / AQI / row caches and
  redraws (called by `setAct()` so the score lane follows the planner); `tlRender()` (called from
  `render()`) shows/hides the section, refreshes pills and legend and draws.
- **Drawing and performance.** `tlSchedule()` coalesces redraws into one `requestAnimationFrame`, with a 160 ms
  timeout fallback because rAF is throttled in background tabs; `tlDraw()` first cancels a still-pending
  frame, so `tlSchedule(); tlRender()` draws once. `tlPrep()` and `tlScores()` rebuild their caches only when
  `D.hr` / `D2.hr` / the activity change (identity checks), never per frame; per frame only the rows between
  `iA` and `iB` (binary search `tlLb`) are touched. The canvas backing store is `W×dpr` with
  `dpr=min(3,devicePixelRatio)` and is only resized when the size changes; a `ResizeObserver` on `#tlWrap`
  redraws on layout changes. **Theme colours are read at draw time** (`C`, `BG`, `txt`, `strong`, `grid`,
  `halo`, `theme`), so `applyTheme`/`setLang` just trigger a redraw.

**Sticky now-bar.** `#nowBar` (inside `#nowBarW`, a 36 px bar pinned to the top of the viewport while the page
scrolls) shows the place, the current temperature, feels like and today's range (both places when comparing)
while `#hero` is scrolled out of view; tapping it scrolls to the top (`nowBarTop()`, honours
reduced-motion). `HERO_OUT` is driven by an `IntersectionObserver` on `#hero`; `updateNowBar()` rebuilds the
text and visibility (shown only when `active==='now'` and `D` exists — never on PLAN, MAP or Info; `showView`
and every render call it); its label is `T.nowBarAria`.

**Map ⏱ sync.** `mapSyncFromTl()` (called by `showView('map')`) puts the map's time-scrub slider
(`#gridSlider`, `gridSeek`) on the hour of the timeline cursor when it lies 0–23 h ahead; `tlSyncFromMap()`
(only when the previous view was the map, via `prevView` in `showView`) moves the cursor to the hour the map was left on (`GRIDHR` > 0) and centres
the view with `tlGoto`. Both are wrapped in try/catch.

**Fixed 16-day forecast.** `FCDAYS=16` (the Open-Meteo maximum) is the only forecast span: `fetchFor`, the cache
keys (`FCDAYS|place`), the AI-feed fallback and `hardRefresh()` all use it; there is no range selector any more.

### Logic shared between views

- **One scoring engine** (next section): the grilling line, the `pk-plan` tab peek, the PLAN card, the day
  pills, the timeline's score lane, the weekend block and the GRILLING summary all call
  `scoreHour`/`scoreDay`/`scoreDays`, so the same day shows the same number everywhere. The day-level
  estimates `bbqScore(d)`/`bbqDay(x,bs)` remain only for the GRILLING day bars and as the fallback for data
  without hourly rows.
- **One weekend block.** `buildWeekendBlock(l)` (shared Sat/Sun grouping with the lone-Sunday skip via
  `weekendGroups()`) is the single component rendered into `#weekendTxt` (the story column) on NOW and `#planWkTxt` on PLAN:
  this & next weekend, one row per activity (BBQ, hiking, biking, running, plus sea on a coast) with a tier
  dot and word, and the best day by `scoreDay` with its temperature, rain chance, score and top reasons
  (`planReasons`). A day the engine cannot score is skipped, never shown as a stray 100. It reads
  `D.daysFull` (forced 14-day lookahead).
- **Severe-weather alerts** (`buildAlerts`/`D.alerts`, `null` when there is nothing to show, else
  `{sev, rows}`) are derived client-side from Open-Meteo (storm code / strong wind / heavy rain / big
  swing / extreme UV / dangerous heat / dangerous cold) — official DHMZ/Meteoalarm feeds are CORS-blocked
  from the browser. `updateAlertBox()` rebuilds `#alertBox` on every view render (icon, message,
  "today at HH:MM"/"tomorrow at HH:MM"), or hides it.
- **Daily precipitation amount:** `fullDs[].mm` (Open-Meteo `precipitation_sum`, mm/day), formatted by
  `mmTxt()`; shown on the timeline's day-zoom rain lane and readout, the hero, the TOMORROW line, the
  Tomorrow card and the Chance-of-rain card.

### Activity engine (one score for every activity)

Banner `/* ---------- Activity engine (J1) ---------- */`. Pure functions that read only their arguments plus
the location clock (`todayIso()`/`nowMin()`, overridable through `scoreDay`'s `opts`).

- **Hourly rows.** `buildOpenMeteo` returns `D.hr`: every hourly row from yesterday to the last forecast day in
  one flat shape (`ts, dt, h, hi, t, fl, pp, mm, w, g, rh, uv, p, code, cond, night, vis, frz, snow, cl, cm, ch`),
  `D.hrDay` (date → `[start,end)` row range, the same map as `dayRows()`) and `D.hrNow` (index of the first row
  after `current.time`). The AI-feed object has none of these. In `wd_last` the rows are stored **columnar**
  (`hrPack(hr)` → `hrc`, `hrRow(hrc,i)` → row `i`, about 3× smaller, keeping the snapshot under the 400 kB
  guard): `saveLast` writes `hrc` only when `hrPack` returns non-null, `readWdLast` rebuilds `D.hr` and always
  deletes `hrc` again.
- **Registry.** `ACTS={bbq,hike,bike,run,sea}`, each with `win` = the `[start,end)` wall-clock hours in which the
  activity is realistic (bbq 9–22, hike 6–20, bike 6–21, run 5–22, sea 8–20); `ACTORDER` (pill order),
  `ACTICON`, `ACTCOL` (tier colours) and `TIERIC` (tier dots).
- **`scoreHour(act,r,d)`** → `{v:1..100, parts:{reasonKey:penalty}}`, or `null` when not scoreable (sea without
  `d.sea`). BBQ is the unchanged `grillCompound`; hike, bike, run and sea use a feels-like comfort band,
  rain-probability, gust/wind, fog, UV and storm/night caps. Hard caps record their key with the points they
  removed so reasons rank sensibly.
- **`scoreDay(act,date,d,opts)`** → `null` or `{act,date,v,tier,best:{from,to,v},hours:[{h,hi,v}],reasons,over}`.
  **The score of a day is the mean of its best contiguous 3-hour window** (the "best 3-hour window" rule)
  among the rows inside `ACTS[act].win` (fewer rows if the day has fewer). For today, windows that already
  ended are skipped; when none is left `over:true` and the best past window is reported. `reasons` are the two
  penalty keys that cost that window the most. `opts={today,nowMin}` replaces the location clock.
- **`scoreDays(act,d,n)`** — `scoreDay` for the next `n` forecast days (today first), skipping unscoreable days.
- **`actTier(v)`** — four bands: 0 great (80+), 1 good (60+), 2 okay (40+), 3 poor. (`bbqTier` is a different
  five-way scale kept for the day-level estimates.)
- **`T` keys** (nested objects, identical keys in both languages): `actName` (bbq/hike/bike/run/sea),
  `actTier` (the four tier words) and `actWhy` (reason chips: rain, hot, cold, wind, storm, night, fog, uv,
  waves, coldsea, humid, time).
- **BBQ hour series.** `bbqHourly(d,crit)` builds the per-hour grill series (`grillCompound` over `D.grillRaw`,
  criteria `BBQCRIT` ticked in the UI, `GRILLALL` = all ticked) for the BBQ section's chart and prep timeline;
  with all criteria ticked it equals `scoreDay('bbq',today).hours` and its peak lies inside the engine's best
  window, so the timeline never disagrees with the PLAN card. Unticking a criterion is a what-if that leaves
  the engine out of it.
- **Test:** `node tools/test-score.js` (see "Running it").

### PLAN view (`#view-plan`, tab PLANIRAJ) — DOM order

One planner for every activity, built on the engine. `PLAN={act,date}`: `act` is the chosen activity (saved in
`wd_prefs.act`), `date` the chosen day (today by default, never saved). `planAct()` is the effective activity
(a sea pick falls back to bbq while the place has no sea data); `planDates()` is today … +15 from `D.hrDay`
(falling back to the daily list for a snapshot without hourly rows); `planDate()` the effective day.
`renderPlan()` runs `renderPlanActs` → `renderPlanDays` → `renderPlanCard` → `renderPlanSections`, then the
weekends, and destroys the charts of activity sections that are not showing.

1. `.viewhead` — `#planHead`, `#planOnly` (the `setOnlyChip` "only A" chip when a comparison is set; PLAN
   scores the first place only) and the vegan switch `#btn-vegan`/`toggleVegan()` (shown for BBQ only);
   `#planTag` — a one-line tagline per activity (`T` keys `bbqTag`/`hikeTag`/`bikeTag`/`runTag`/`seaTag`).
2. `#actRow` — activity pills `btn-act-bbq`/`-hike`/`-bike`/`-run`/`-sea` (`setAct(a)` saves the pref and does
   `history.replaceState` to `#plan-<act>`; the sea pill is hidden without sea data).
3. `#dayRow` — a `.dragx` strip of day pills (`.dpill`, `setPlanDate(dt)`) for the next 16 days, each with a
   tier-coloured dot and an aria-label carrying weekday, score and tier word; `min-width:0` keeps the row
   from widening the page on phones.
4. `#planCard` — **the one card** (`renderPlanCard()`): score /100, tier word, the best window ("Best 14–17 h",
   "Done for today — best was …" when `over`), up to two reason chips (`planReasons(sd)`, which hides the "late
   hour" `time` chip when the window already lies inside 12–19 h), hour-by-hour bars (`.hbars`, best window
   highlighted) and the day in numbers (`planFacts`). When the engine has nothing to score it shows an
   `emptyCard` saying why (`planNoAi`/`planNoHr`/`planNoDay`).
5. `#planSections` — exactly one block, chosen by `renderPlanSections()`: `#ps-bbq` (`renderBbqSections()`:
   prep timeline `drawBbqTimeline`, grill score by hour `drawBbqGrill` with the criteria chips, `#grSec`
   GRILLING via `updateGrSec()`, nonsense numbers, pit checklist `renderBbqCheck()`/`toggleCheck`),
   `#ps-hike` (`renderHikeSections()`: trail cards on `D.hx`/`D.gustMax`, trail nonsense — the hourly comfort and
   7-day trail charts were removed in v3.22, the timeline covers them) or `#ps-cards` (`renderCondCards()`: a few
   wind / UV / daylight / sea cards for bike, run and sea). On a day other than today the BBQ and hike
   sections carry a "Shown for today" note (`planNote`).
6. `#planWeekends` — the shared `buildWeekendBlock` in `#planWkTxt`.

### Preferences and local storage

`wd_prefs` (`PREFS_KEY`) is written by `savePrefs()` and read once at boot by `loadPrefs()`. It stores
`lang`, `theme`, `VEGAN`, `act` (the PLAN activity, `PLAN.act`), `groups` (open state of the four groups) and
`tl` (`{zoom,layers}` of the timeline; `loadPrefs()` accepts only known zoom values and 0/1/boolean layer flags
for known layers). The v3.21 keys `CONF`/`MOON`/`TIDE`/`PRES`/`BBQ`/`CMODE` are no longer written; only a stored
`PRES` is migrated once into `tl.layers.pres` (only when no timeline pressure choice is stored) and disappears
with the next save. **MP (Monty Python) is deliberately not stored.** `PREFS_LIVE`
is `false` during boot, so reading the saved prefs never rewrites them; it flips to `true` at the end of
boot. **First visit** (no `wd_prefs`): `lang` follows `navigator.language` (`hr*` → Croatian, otherwise
English) and the theme follows the OS preference. A new switch must be added to both `savePrefs` and
`loadPrefs`.

All `localStorage` keys (every access wrapped in try/catch): `wd_recents` (recent places), `wd_lochint`
(exact coordinates of places picked from search), `wd_bbqcheck` (BBQ checklist ticks), `wd_last` (last
direct-mode forecast snapshot `{v:APPV,key,loc,t,D}` with `D.hr` stored columnar as `D.hrc`, ≤ 400 kB), `wd_prefs`.

### Comparison mode (location A vs B)

Reaching two selections starts comparison. **What compares:** the hero and stat chips, the group cards,
the timeline's temperature lane (A and B series), the TOMORROW line, the sea chart, plus the versus line in
the daily text block. **What shows A only:** the timeline's other lanes (rain, pressure, wind, UV, air, sea,
scores), the weekend block, the air, tide, bio, pressure and moon charts, and the whole PLAN view. `#cmpNote` states this on NOW; PLAN shows a `setOnlyChip(id)` chip
(`#planOnly`, text `T.onlyA` "only {A}"). If the second place
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
buttons from the `tt_lang`, `tt_theme`, `tt_mp`, `tt_vegan` keys; chart aria-labels are
the `ar_*` keys. `.lbtn` and `.mly` are `min-height:36px` on desktop and **44 px in `mobile` and
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
re-label to match; opening the map puts the slider on the hour chosen on the NOW timeline, and coming back moves the timeline cursor to the hour the map was left at (see "Map ⏱ sync" above). Wind labels show gusts in parentheses when they clear speed+5. Also the next-2h rain
strip, click-to-forecast (`onMapClick`/`pickPoint`: reverse-geocodes the tapped point with Nominatim and
loads its forecast) and a **📍 my-location** Leaflet control (`locateOnMap`) that geolocates and
recentres/pins the map. Layout: on `mobile` only, `#mlyPills` (the layer buttons) is a fixed swipeable
row right above the bottom bar and `#mapBottom` sits above that row; on `mobile` and `mid` the zoom and
locate controls are top-right (below the top row), clear of the bottom panel, and the attribution text
lives in the bottom panel. The ✕ (desktop only) returns to `#now`.

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

**Activity-engine test** (dependency-free, node ≥ 18):

```powershell
node tools/test-score.js
```

It extracts `ACTS`, `scoreHour`, `scoreDay`, `scoreDays`, `actTier`, `grillCompound`, `hrPack`/`hrRow` … from the
app `<script>` by name (same extractor as `test-time.js`), stubs the location clock, and runs synthetic hourly
fixtures: the registry and tier bands, BBQ equal to the unchanged `grillCompound`, rain lowering every score
monotonically, the hard caps, hike/bike/run specifics, sea inland (`null`), the best 3-hour window, today
skipping windows that already ended, the reason keys, `scoreDays`, and the columnar `wd_last` round trip. It
prints `SCORE TESTS OK` and exits 1 on any failure.

## Data sources (all keyless, all client-side)

- **Open-Meteo forecast** — `api.open-meteo.com` (`timezone=auto`, `past_days=1`, a fixed `FCDAYS` = 16 forecast days; hourly + daily +
  `minutely_15` precipitation for the next-2h rain strip, `D.rain15`; hourly carries `pressure_msl`
  (72 h pressure trend, `D.presH`), `is_day` (night icons), `visibility`, `freezing_level_height`,
  `wind_gusts_10m` and `snowfall` (today's values in `D.hx`), plus daily `wind_gusts_10m_max`
  (`D.gustMax`) and `precipitation_sum`, plus hourly `precipitation` — together with every other hourly field
  they fill `D.hr` for the activity engine and feed the hike cards' visibility/snow-line/gust values and the
  map's gust-aware wind labels) and `geocoding-api.open-meteo.com` for city → lat/lon.
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
   `data-i="key"` (text) or `data-tt="key"` (title + aria-label); (b) **view-local strings** (PLAN
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
11. **The timeline is canvas, not Chart.js — read theme colours at draw time.** `tlDraw()` takes `C`, `BG`,
    `txt`, `strong`, `grid`, `halo` and `theme` on every frame (no colours cached across frames or hard-coded),
    keeps the summary above (`#tlSum`) and the legend below (`#tlLeg`, custom DOM), and every user-visible
    string it draws or announces (labels, readout, legend, aria) exists in both languages. Keep the cursor
    inside the pannable range (`tlCurClamp`) and redraw through `tlSchedule()`.

## Code layout within the single file

Roughly top-to-bottom:

- `<head>` / CSS — theme variables, responsive layout rules (`#wrap.mobile` / `#wrap.mid` / desktop),
  card/hero/stat/group styles, the control sizes above.
- `<body>` markup — header (`#locSel`, `btn-lang`, `btn-theme`), `#alertBox`, `#tabs` (NOW, PLAN, MAP —
  `tab-now`/`tab-plan`/`tab-map`), then `#dash`'s per-view `<section>`s: `#view-now` and `#view-plan` (DOM
  orders above; the BBQ and hike sections live inside PLAN as `#ps-bbq`/`#ps-hike`), `#view-map`, and
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
  `feedMark()`, location clock, prefs, BBQ scoring, `FCDAYS`) · **activity engine** (`ACTS`, `scoreHour`/`scoreDay`/`scoreDays`, `hrPack`/`hrRow`) · `T` translations · data sources (the pure
  `buildOpenMeteo`, forecast / marine / air / climatology / AI fetchers) · orchestration (`loadData`,
  `fetchFor`, `loadSecondary`, `wd_last` save/restore) · recents/selection/location selector · rendering
  (`render`, `renderHero`, `renderStats`, `renderGroups`, `updateFoot`, `card`) · **PLAN view** (`planAct`,
  `setAct`, `renderPlan`, `renderPlanCard`, `renderPlanSections`, `renderBbqSections`, `renderHikeSections`,
  `renderCondCards`) · chart drawers
  (`drawSea`, `drawTide`, `drawMoon`, `drawBio`, `drawPressure`, `drawAqi`, `drawGrill`, `drawBbqTimeline`,
  `drawBbqGrill`) · **timeline** (`tlInit`, `tlRender`, `tlDraw`, `tlSchedule`, `tlSetZoom`, `tlSetLayer`, `tlGoto`,
  `tlCursorTs`, `tlInvalidate`, `tlHome`, `tlMoveCursor`, `tlTap`, `tlReadoutLines`; state `TL`, cache `TLC`) · maps
  (`loadLeaflet`, the weather map incl. `locateOnMap`) · view router (`ROUTES`/`ROUTEACT`/`VIEWS`/
  `showView`/`renderActive`/`updateAlertBox`) · Info panel (`renderInfo`, `renderFeeds`, `CHANGELOG`).

Notable globals: `lang`, `theme`, `layout` (`'mobile'`/`'mid'`/`'desktop'`), `FCDAYS` (16), comparison state
(`selB`/`D2`), location caches (`LOCHINT`, `GEO_LOC`, `MAP_LOC`, `LOCTZ`), `GROUPS`, `PLAN`, `TL`/`TLC` (the
timeline), `HERO_OUT` (sticky now-bar), and the feature toggles (`VEGAN`, `MP`). `MP` is a "Monty Python"
easter-egg label set.

## Making changes

- Edit `weather-dashboard.html` directly; keep the section-banner organization.
- When touching the timeline: draw through `tlSchedule()`, set the cursor only through `tlCurClamp`, and check all
  three zooms, both themes, both languages and keyboard use (arrows, +/−, Home, Esc).
- When touching a chart: update its summary, legend, and `aria-label` together, and make sure it
  redraws correctly across theme switch and language switch, and that it is not drawn while its group is
  closed.
- After touching `buildOpenMeteo` or any time code, run `node tools/test-time.js` (it must print
  `TIME TESTS OK`) and add a fixture there for any new time-dependent rule.
- After touching the activity engine (`ACTS`, `scoreHour`, `scoreDay`, `scoreDays`, `actTier`), `hrPack`/`hrRow`,
  `D.hr` in `buildOpenMeteo` or the `wd_last` save/restore, run `node tools/test-score.js` (it must print
  `SCORE TESTS OK`) and add a fixture there for any new rule. A score shown anywhere must come from the
  engine, never from a second formula.
- Syntax checks: `node --check sw.js`, and for the page script
  `node -e "const fs=require('fs');const h=fs.readFileSync('weather-dashboard.html','utf8');const m=[...h.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)].find(x=>x[1].length>1000);new Function(m[1]);console.log('SYNTAX OK')"`.
- Shipping a user-visible change: bump the version in `<title>`, the footer and `APPV`; add a bilingual
  `CHANGELOG` entry at the top; bump `CACHE` in `sw.js`; grep the old version number — only historical
  CHANGELOG hits may remain. Update this file in place so it keeps describing the current state (no
  "vX changes override older text" sections).
- Verify by eye in a browser in both themes, both languages, and all three layout steps
  (mobile/mid/desktop) before committing.
