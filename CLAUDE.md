# CLAUDE.md

Guidance for working in this repository.

## What this is

**Patrik's weather daily** — a bilingual (English / Croatian) weather dashboard.
The entire app is a **single self-contained file**: [weather-dashboard.html](weather-dashboard.html)
(HTML + CSS + vanilla JS, ~6,800 lines). Current version: **v3.27** (also in the `APPV` JS constant,
used for the dynamic `document.title` and to tag `wd_last` snapshots — bump `<title>`, the footer and
`APPV` together, add a `CHANGELOG` entry, and bump `CACHE` in `sw.js`).

There is no build step, no bundler and no package manager. The app itself is static: it is opened directly in a
browser or served as a static file, and everything but "Ask about the weather" works with no server at all. The one
server-side piece is a small same-origin Cloudflare Worker (`worker.js`, v3.24; place lookups added in v3.25) that proxies the AI search for
visitors without a key; see "Ask about the weather" and the PWA note for the two documented exceptions. Keep it
that way: no framework, no build, no other backend.

`index.html` is **not** the app — it's a tiny redirect stub so the bare domain
(e.g. `weather-daily.pages.dev/`) forwards to `weather-dashboard.html`. All real work happens in
`weather-dashboard.html`.

### Shape of the app

A **four-tab SPA in one file** — NOW (Croatian SADA), GRAPH (GRAF, v3.26), PLAN (PLANIRAJ) and MAP (KARTA) — plus the tab-less
Info view: a tab bar + hash router over a `VIEWS`/`ROUTES` registry (views `now`/`graph`/`plan`/`map`/`info`, sections
`#view-now`/`#view-graph`/`#view-plan`/`#view-map`/`#view-info`). Routes: `#now` (also the empty hash, `#weather` and `#swim`),
`#graph` (also `#graf`: the full-screen timeline, see "Graph view"), `#plan`, `#plan-bbq`/`#plan-hike`/`#plan-bike`/`#plan-run`/`#plan-sea` (open PLAN on that activity),
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
(cloud-sun, line chart, clipboard-check, map, in the order NOW · GRAPH · PLAN · MAP; `tab-now`/`tab-graph`/`tab-plan`/`tab-map`), no visible
label (the label stays for screen readers, visually hidden) and no peek badge. Desktop keeps text labels
(`T` keys `tabNow`/`tabGraph`/`tabPlan`/`tabMap`) and peeks, set by `updateTabs()`: `pk-now` the current temperature,
`pk-graph` the highest temperature of the next 24 h (`↑NN°`), `pk-plan` the chosen activity's icon plus its tier dot for today (from `scoreDay`), `pk-map` 🌧️/🗺️. The bar **stays visible on the full-screen Map and Graph views**: `showView()` sets `#tabs.onfs`;
desktop hides the top tabs there, mobile/mid keep the bar above the map / graph and hide the map's ✕ and the graph's ✕. `setNavH()` (called from `applyResponsive()`, `renderGraph()`, `tlUiApply()` and a `ResizeObserver` on `#tabs`) writes the bottom bar's height, 0 when it is not shown, to the CSS variable `--navh`: the graph view and the Layers panel end at its top edge. A **collapsed graph hides the bar too** (`#tabs.tlimm`, `display:none`). **Tab keyboard (manual activation, WAI-ARIA tabs):** ←/→ (wrapping), Home and End on a focused tab only move focus and the roving `tabindex`; Enter or Space (and a click) open the focused tab; `aria-selected` always sits on the active view's tab (`updateTabs()`), so an arrow press never changes the view.

The ask bar `#askBar` (v3.23, see "Ask about the weather") is the first element of `#dash`, above the alert banner and the tab bar.

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
an offline app shell. This is the **first of two deliberate exceptions** to "single self-contained file" (the second is
`worker.js`, see "Ask about the weather"):
`manifest.json`, `sw.js`, the `icons/` PNGs, and the `tools/make-icons.js` script that generates them are
the only other files the site ships (`tools/test-time.js` and `tools/test-score.js` are dev-only tests, see "Running it"). None of
them touch app data or behaviour — `sw.js` precaches only the HTML shell (this file, `index.html`,
`manifest.json`, the icons) and the two pinned CDN library files/styles (Chart.js, Leaflet JS+CSS); it
never intercepts or caches an API or map-tile request — those always go straight to the network,
untouched, exactly as if the service worker did not exist. That includes the Worker's same-origin dynamic routes:
the fetch handler returns early, before the navigation rule, for every same-origin path under `/api/`
(`/api/ask`, `/api/ask/state` and the `/api/owner` redirect, which is a navigation), so they are never
intercepted or cached. `tools/make-icons.js` is a dependency-free
node script (hand-rolled PNG encoder: raw RGBA scanlines → `zlib.deflateSync` → PNG chunks with a
hand-rolled CRC32) that regenerates the three icon PNGs; `tools/` is excluded from the deployed site via
`.assetsignore`. **Bump `CACHE` in `sw.js`** (currently `wd-shell-v3.27`) with every release, since the
shell is the HTML, and whenever the precache list or pinned CDN versions change — the old cache is
dropped on activate. The SW registers only on `https:` (never on `file://`, and it's a no-op if
registration fails — the page works identically without it); its status is reported through the same
`FEEDS`/`feedMark('pwa', …)` mechanism as every other data source and shown as a `pwa` row on the Info
page. When a new SW takes over an already-open tab (`controllerchange`), the app does **not** auto-reload
— it appends a bilingual "new version ready — reload" / "nova verzija spremna — osvježi" note to the
footer chip instead.

### NOW view (`#view-now`, tab SADA) — DOM order

Above everything, outside `#dash`, sits `#nowBarW` (a zero-height sticky wrapper) holding the sticky now-bar
`#nowBar` (see below). Inside `#dash`, above `#alertBox` and `#tabs`, sits the search bar `#askBar` (shared by NOW, PLAN
and Info; see "Ask about the weather").

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
`D.hr` longer than 24 rows). v3.23 made it the one detailed chart of the app: the legend is the series
control, every series the data has is a layer, and a full-screen view shows it all at once (since v3.26 that is the GRAPH tab). The chart rules
that shaped it are cited by number in the code comments: C-02 value labels, C-03 line style, C-05 hover
readout, C-06 contrast-safe ink, C-13 no series without data, C-15 legend as control, C-16 axis furniture
always drawn, C-17 axis drag / wheel rescale, C-18 Auto / Full, RT-24 series names inside the plot, RT-22 the
full-screen shell (now the graph view).

- **DOM** (compact since v3.26: one control bar, one legend row, everything else in a panel). On NOW `#tlSec` holds, in
  this order and nothing else: the heading row `.hd.tlhd` (`T.tlTitle` and the ⛶ button `btn-tlfs`, `tlFullOpen()`),
  the summary `#tlSum` (one line for the visible window, `tlSummary()`, written only when the text changes; with the
  visibility / snow layers on it also names the first fog / snow hour in view), the **control bar `#tlBar`** (one row,
  no wrap, 36 px desktop / 44 px mobile+mid: the segmented zoom `#tlZoom` with `btn-tlz-h` / `btn-tlz-3` /
  `btn-tlz-d` — short labels `tlZ_h`/`tlZ_3`/`tlZ_d` "Sat | 3 h | Dan" / "Hour | 3 h | Day" — then the Layers button
  `btn-tlpanel`: layers icon, `tlPanelBtn` and a count `#tlPanelN` of the visible layers, `aria-haspopup="dialog"`; its
  title / `aria-label` and the bar's `aria-label` are written by `tlSyncUi()`; below 390 px the word is hidden and only
  icon + count remain), the canvas wrapper `#tlWrap` (compact height set by `tlDraw()` itself, never smaller than
  `applyResponsive()`'s 340 / 300 / 250 px for desktop / mid / mobile, and tall enough for every lane that is
  on) with the readout box `#tlReadout`, the **mini legend `#tlMini`** (a `.dragx` row, `role=group`, built by
  `tlLegend()`; replaces the old inline grouped legend `#tlLeg`, which is gone) and the screen-reader live region
  `#tlLive` (`role=status`). The bar also contains four graph-only controls that are hidden on NOW (see "Graph
  view"): the place + summary slot `#tlBarStart` (`#tlBarLoc`), `btn-tltheme`, `btn-tlcollapse`, `btn-tlfsx`. The
  rest lives in the **Layers & display panel `#tlPanel`** (see "Legend as control"), whose static markup (backdrop
  `#tlPanelBk`, then the `<aside>`) sits after `#view-graph` at the end of `#wrap`. The canvas has `tabindex=0`,
  `role=img` and `data-tt="ar_tl"`; the zoom group uses `tlZoomAria`, the panel's pairs `tlFitAria` / `tlStyleAria`.
  There are no separate layer pills any more: the legend chips are the only series control (C-15).
- **State.** `TL={zoom,layers,style,names,axis,x0,cursor,full,pxh,fit,ui}`. `zoom` is `'h'` (hours), `'3'` (every 3 h) or
  `'d'` (days; the order is `TLZ`): the last chosen preset / the current representation, and what is saved. `pxh` is
  the continuous horizontal scale in px per hour (session only, `null` = the preset of `zoom`), `fit` is true while
  all days are fitted to the width (see Scale). `layers` has one flag per entry of `TLLAYERS` (the readout order `TLORDER`,
  flattened from `TLGROUPS`: `temp, feels, norm, rain, snow, cloud, wind, gust, pres, humid, uv, air, pollen,
  vis, frz, sea, tide, sun, moon, score`) with **three states**: `0` hidden, `1` visible without value labels,
  `2` visible with value labels. `style` is `'linear'`, `'step'` or `'smooth'` (`TLSTYLES`, default `smooth`:
  monotone cubic, no overshoot). `names={c,f}` switches the series-name overlays on for the compact (`c`,
  default off) and graph-view (`f`, default on) timeline. `ui={c:0|1}` is the graph view's collapsed state (see "Graph view"). `axis={temp,pres}`, each `{mode:'auto'|'full',lo,hi}`,
  where `lo`/`hi` are a manual override (both `null` = automatic). `x0` is the left edge and `cursor` the
  selected column, both in "location-local wall-clock minutes × 60000" (the `tsMin()` of Open-Meteo's time
  strings, so a day is always 1440 minutes wide and DST never shifts the axis); `cursor===null` means nothing
  selected; `full` is true while the timeline is mounted in the graph view. **Remembered**
  (`wd_prefs.tl={v:2,zoom,layers,style,names,axis,ui}`): everything except `x0`, `cursor`, `full`, `pxh` and `fit`;
  restoring `zoom` applies that preset's px/hour.
  **Defaults** with no stored preference: exactly temperature, rain and score at state 2, every other layer
  hidden; stored preferences win (`loadPrefs()` migrates the pre-v3.23 0 / 1 / boolean flags, where a stored
  "on" becomes 2). `TLC` is the derived cache (row minutes `tm`, the raw temperature and pressure data ranges
  `tMin`/`tMax`/`pMin`/`pMax`, per-day aggregates `ag` — wind, gust, UV, visibility, snow sum and the means of
  humidity, freezing level and the three cloud bands — the AQI series, the pollen series `pol`/`polD`, the
  per-hour and per-day scores `rs`/`ds`, the availability cache `has`, the hover minute `hov`, the legend
  preview `preview`, the mini legend's "just turned off" chips `ghost` with their 8 s timer `gt`, the pending frame ids `raf`/`to`, the location key `locKey`).
- **Scale** (continuous since v3.24). The horizontal scale is `TL.pxh` px per hour (`tlPxh()`, `tlPpm()` = px per
  minute); a new value comes from a preset, the wheel, a pinch, `+`/`−` or a fit. The representation follows
  from it: `tlRep()` → `'h'` (hourly rows) when `pxh` ≥ 18, `'3'` (3-hourly) when 8 ≤ `pxh` < 18, else `'d'`
  (daily). **Every place that means "which representation" calls `tlRep()`, never `TL.zoom`** (`TL.zoom` only
  feeds the pills' preset and the saved pref; `tlScaleDone(old)` sets it to the new representation when that
  changes, re-snaps the cursor, saves, repaints the pills and rebuilds the legend). Bounds: `tlPxhMin(W)` =
  fit-all (plot width over every hour from now − 6 h to the end of the last row, `tlRangeStart()`),
  `tlPxhMax()` = 60 (48 on mobile); `tlScaleFix(W)` clamps `pxh` once per `tlDraw()`. Presets (`tlSetZoom(z)`,
  `tlPresetPxh(z)`): Hours `TLPX.h`, 3 h `TLPX['3']`, Days `TLPX.d` = 34 / 26, 12 / 9, 3.2 / 2.6 (desktop/mid,
  mobile) in the compact view; **in the graph view Days = fit-to-width** (`tlFitX()`: `pxh=tlPxhMin()`, `x0` = range
  start, so the last day's right edge is the plot's right edge). `TL.fit` stays true until the user pans or
  zooms (`tlPanTo()` clears it only when the view really moved; zooming out to the minimum sets it again);
  while it is true `tlScaleFix()` and the `ResizeObserver` refit on every resize / layout step. Entering
  the graph view with the Days representation refits; leaving restores the compact Days preset. A row is drawn
  centred on its timestamp; `tlSnap(m)` maps a free minute to the column it belongs to (the hour, the 3-hour row,
  or noon of the day). Bars, cells and labels use the real column width (`pxH` in `tlDraw`); label cadence
  (value labels, hour ticks, day ticks, score cells) is chosen from `pxh` with the `fits()` decimation, so no
  scale overlaps labels.
- **Layers and their data** (`tlHas()` says which the place offers, `tlAvail(k,has)` also applies the zoom;
  a series with no data is never drawn and never listed in the legend, C-13). `temp`, `rain` (rain % bars plus
  mm; the next-2h `D.rain15` strip at hours zoom), `wind`, `pres`, `uv`, `air` (the hourly AQI series
  `D.air.aqi.series`), `sea` (`D.sea.days`), `norm` (day zoom only, `D.climo.byDay`) and `score` are the v3.22
  layers. New in v3.23: `feels` (`hr[].fl`, hours and 3 h only; dotted, on the temperature scale), `humid`
  (`rh`; takes the right-hand axis strip while pressure is off, else a thin lane of its own), `cloud`
  (`cl`/`cm`/`ch` as three stacked grey bands at the top of the main area; day zoom the daily mean), `snow`
  (`hr[].snow`, cm, violet bars inside the rain lane: 1.5 cm is full height at hours zoom, 4 cm at 3 h, 15 cm
  at days), `gust` (`g`, a line over the wind lane), `vis` (`vis`, metres shown in km on a log-ish scale; fog
  below 1 km in the warning colour), `frz` (`frz`, freezing level in m, a line with its own small scale drawn
  inside the plot), `sun` (**`D.sunDays=[{dt,rise,set}]`**, added by `buildOpenMeteo` for every day of the
  response — `D.sun` stays today's — gives the exact-minute night shading `tlNights()` and the sun-up /
  sun-down ticks on the axis, and with labels the sunrise / sunset times), `moon` (`moonIcon`/`moonName`/
  `moonIllum`: day zoom one icon per day above the day label, hours / 3 h the icon at local midnight), `tide`
  (`D.sea.tide` daily high / low levels in cm as ↑ / ↓ marks in the sea lane; the data has no times, which the
  legend tooltip `tlTideTip` says; omitted inland) and `pollen` (**`D.air.pollenH=[{ts,k,v}]`**, the dominant
  pollen type and value of every hour, built by `ensureAir()` from the hourly `*_pollen` arrays of the same
  air-quality response and cached with the same 30 min TTL; `tlPollen()` turns it into minutes; cells are
  coloured by the `polLvl` bands, state 2 writes the type abbreviation `polAbbr`, at 3 h zoom on every third
  cell). `TLPAL`/`tlCol(k)` hold the series colours (light, dark; read at draw time), `TLIC` the readout
  icons, `TLUNIT` the legend units.
- **Lanes.** `tlDraw()` lays out lanes top to bottom and collapses lanes that are off: the main area (the
  cloud band, rain / snow columns, the pressure, humidity, freezing-level, normal, feels-like and temperature
  lines, whichever of those layers are on), then the humidity lane (only when pressure is also on), wind
  (speed bars with the gust line), UV, air (AQI), pollen, visibility, sea (SST plus tide marks) and the
  activity-score lane (each its own small band), above an axis band with the time labels, the sun ticks and
  (state 2) times, and the moon icons. Day bands, midnight lines with sticky day labels (month labels at day
  zoom), night shading (exact sunset / sunrise with a 35-minute ramp when the sun layer is on, else
  `hr[].night`), storm-alert windows from `D.alerts`, the "now" line, the cursor column and the hover
  crosshair are drawn under/over the lanes. The **score lane** is the planner's activity (`planAct()`):
  per-hour `scoreHour` bars and the best-window mark from `scoreDay`, so the timeline never disagrees with
  PLAN; its chip is relabelled with the activity (`tlLayerName()`). Day zoom adds a confidence band for day 8+
  on the temperature bars. In comparison mode the temperature lane draws A and B (`TLC.hr2`/`tm2`,
  `CMP.a`/`CMP.b`); every other lane shows A only. The compact canvas grows to fit every lane that is on (a
  phone with many layers gets taller, never clipped); in the graph view the lanes are scaled up to the free
  height and the type is 2 px larger.
- **Legend as control** (`tlLegend()`; one delegated click / pointer listener set on `#tlMini` and on `#tlPanel` in
  `tlInit()`). Chips are `<button class="tlk s0|s1|s2" data-k="…">`. A click calls `tlSetLayer(k)` and cycles 2 → 1 → 0 → 2
  (filled swatch / hollow swatch / grey and struck through); the chip's `aria-pressed` means "visible" and its
  `aria-label` states the state (`tlSt0`/`tlSt1`/`tlSt2`). A mouse hovering a hidden chip previews that series at 35 %
  (`TLC.preview`; never on touch). **Mini legend `#tlMini`** — one horizontal `.dragx` row, no wrap (36 / 44 px): one chip per
  available layer whose state is above 0 (swatch + short name `tlL_*`, no unit), in `TLORDER`; the A / B swatches when
  comparing; and a last chip `#tlMiniMore` "＋ Layers" (`.tlmm`, opens the panel). A chip tapped to 0 stays in the row, grey and struck
  through, as a **ghost** (`TLC.ghost`, `tlGhost(k)`) so a wrong tap can be undone; the ghosts go when the panel opens or
  closes, the zoom changes (`tlSetZoom`, `tlScaleDone`) or after 8 s (`tlGhostClear()`). **Layers & display panel
  `#tlPanel`** (`<aside role="dialog" aria-modal="true" aria-labelledby="tlPanelT">`, title `tlPanelTitle`, close `btn-tlpx`;
  `TLP={open,opener}`, `tlPanelOpen(opener)` / `tlPanelClose(restore)`): mobile/mid = a bottom sheet (fixed, bottom at
  `var(--navh)` so the tab bar stays visible, rounded top corners, max-height 70 vh, scrolls inside), desktop = a 340 px right side
  sheet over the full viewport height; `#tlPanelBk` is the tap-to-close backdrop. Content: every available layer in its
  `TLGROUPS` group under a muted title (`tlG_*`: Temperature, Precipitation, Wind, Air, Sea, Sun and moon, Scores) with all
  states and the unit (`#tlPanelGroups`, filled by `tlLegend()` only while open), the confidence-band and score-tier swatches,
  then the "Display" block (`tlDisplay`): Auto / Full `#tlFit` (`btn-tlf-auto`/`-full`, `tlSetFit`), line style `#tlStyle`
  (`btn-tls-linear`/`-step`/`-smooth`, `tlSetStyle`), the series-names switch `#tlNames` (`tlToggleNames()`, writes
  `TL.names.c` or `.f`, `aria-pressed` kept by `tlSyncUi()`) and the muted hint `tlHint` (hidden on touch). Opening moves focus to
  `btn-tlpx`; Tab is trapped inside (`document` keydown in `tlInit()`); Esc, the ✕ or the backdrop close it and focus returns to the
  opener (`TLP.opener` is an id, because the mini chip is re-rendered). A view change or a collapse closes it. The old inline
  grouped legend, the "More / Less" chip (`#tlMore`, `tlToggleMore()`, `TLmore`, `TLC.keep`) and the `tlMore` / `tlLess` keys are gone.
- **Value labels** (state 2 only, C-02). Each layer prints its numbers when its state is 2 (`LB[k]` in the
  draw); `fits(key,x,w)` refuses a label that would touch the previous one of the same kind, so labels thin
  out instead of overlapping; text on a coloured cell uses `tlTextOn(c)` (black or white by luminance) and a
  series colour used as ink goes through `tlInk(c,BG)` (mixed towards black / white until it reaches 4.5:1,
  cached in `TLINK`) — C-06.
- **Series-name overlays** (RT-24, `TL.names`). With the switch on, every visible line series (temperature,
  feels like, pressure, humidity, freezing level, gusts, normal, and B in comparison mode) writes its short
  name (`tlN_temp`, `tlN_feels`, `tlN_pres`, `tlN_humid`, `tlN_frz`, `tlN_gust`, `tlN_norm`) inside the plot at
  the left and right edges next to the line's first and last visible point, with a halo, kept apart from
  other marks and from the axis labels (`NMS`, `occ`).
- **Axes** (C-16 / C-17 / C-18). The temperature axis is the left strip (30 px), the pressure axis the right
  strip (34 px; it shows the humidity scale while pressure is off, and that one is not draggable). Ticks and
  labels are **always drawn**, dimmed while their series is hidden. `tlAxisCalc(which,rng,zoneH)` returns
  `{lo,hi,step,ticks,manual,mode}`; `tlRange()` supplies the data range (Auto = the visible window, Full =
  all data). **Mouse only:** dragging an axis strip vertically (`tlAxisAt` finds the strip, `tlAxisBase` /
  `tlAxisScale` rescale) or the wheel over it rescales the axis (up = smaller maximum, down = larger; Auto
  keeps the minimum, Full scales around the middle) and creates a manual override `TL.axis.*.lo/hi`;
  double-click on the strip, or choosing Auto / Full (`tlSetFit(mode)`), drops it. A touch swipe that starts
  inside a strip pans like anywhere else (the axis branch of `pointerdown` requires `pointerType==='mouse'`).
  `tlPrep()` also drops the overrides when the forecast place changes (`TLC.locKey`, from `D.loc` / `D.tz`),
  since a range set for one place means nothing for another. `tlSetStyle(st)` sets the line style of the
  temperature (A and B), feels, pressure, humidity, freezing-level, gust, normal and (without labels) sea lines.
- **Interaction** (`tlInit()`, one-time listeners on the canvas). Pointer events: drag pans (`TL.x0`, clamped
  by `tlClamp()` to now − 6 h … the end of the data), a quick tap (< 5 px, < 700 ms) calls `tlTap(px)`;
  horizontal wheel / shift+wheel pans; in the graph view the plain vertical wheel zooms the time
  scale, in the compact view only ctrl/meta+wheel (and a trackpad pinch, which arrives as ctrl+wheel) does and a
  plain vertical wheel scrolls the page (no `preventDefault`); the factor is 1.15^(−Δy/100) around the pointer
  (`tlApplyScale(np,ax,am)` keeps the minute under `ax` fixed);
  two touch pointers pinch (`tlPts`, `tlPinch`, `tlPinchMove()`: the distance ratio scales `pxh` around the
  midpoint, a second finger drops a pan / tap in progress); a double-click on the plot calls `tlFitX()`, on an
  axis strip it resets that axis. A mouse moving over the plot (`tlHoverAt()`, C-05) sets `TLC.hov` and
  shows the readout of the column under it plus a crosshair, with no tap needed
  (`tlPlaceReadout(x,m,hover)`); leaving the canvas hides it unless a cursor is set. Keyboard (canvas
  focused): ←/→ `tlMoveCursor(±1)` (one column), Home `tlHome()` (cursor to now), +/− `tlStepScale(±1)` (×1.5 / ÷1.5 around the cursor or the view centre),
  Enter/Space toggles the readout, Esc `tlHide()` (in the graph view the document handler runs instead: panel → expand → leave, see "Graph view").
  `tlSetZoom(z)` (a preset) keeps the view centred on the cursor (or the view centre); `tlSetLayer(k,st)` sets a layer
  state (without `st` it cycles); all of these save the prefs and refresh the toolbar and the legend. **The
  cursor is always a column inside the pannable range** (now − 6 h … the last row): `tlCurClamp(m)` snaps and
  clamps, and `tlTap`, `tlMoveCursor`, `tlHome`, `tlSetZoom` and `tlSyncFromMap` all go through it, so
  `#tlLive` never announces an off-canvas column.
- **Readout.** Tap/Enter (or a mouse hover) opens `#tlReadout` next to the column (`tlPlaceReadout()`); its
  content comes from `tlReadoutLines(m)` → `{title, lines:[[icon,text]]}`: **one line per visible layer, in
  legend order** (`TLORDER`); with many layers on, the box switches to two columns (`.c2`) rather than
  outgrow the plot. The text is mirrored into `#tlLive` (not for hover). A line whose value is missing is
  skipped (never a lone `°` or an empty rain line); numbers go through `tlN()` (HR decimal comma) and mm
  through `tlMm()` in every zoom. The temperature line keeps its "(feels X°)" suffix while the feels layer is
  off; with the layer on, the feels line carries it. Hour / 3 h readouts show the value of each active layer
  (3 h: the window's maximum, the sum for mm and snow, the minimum for visibility); the day readout shows low … high, rain, wind, pressure,
  UV, peak AQI, sea, the normal with its delta, the day's sunrise / sunset (`sunLine`), the tide
  (`tideLine`), the strongest pollen hour (`polTxt`), **the moon phase** (`moonIcon`/`moonName`/`moonIllum`)
  and the score with its best window.
- **Graph view** (G1 v3.26 = the old RT-22 full-screen overlay turned into a tab; G2 v3.26 = compact controls). View `graph` / section
  `#view-graph` (`role=tabpanel`, labelled by the visually hidden `#tlGraphH`), route `#graph` (`#graf`), tab `tab-graph`. The ⛶ button
  (`btn-tlfs`) calls `tlFullOpen()` (sets `TL.fromApp`, navigates to `#graph`); `tlFullClose()` (✕, Esc) goes `history.back()` when it was
  opened that way, else to `TL.backTo` (the view it was opened from; set by `showView`); it sets `TL.closing` on the first call so a second Esc / ✕ in
  the same tick does nothing, and `showView()` clears the flag when the active view changes. **Focus on leaving the graph** (`graphLeaveFocus()`, called
  by `showView` after the target view rendered): `btn-tlfs` when the graph was opened with ⛶ and the user returns to NOW, else the tab of the view
  returned to. **No data yet:** while `D` is null `showView('graph')` keeps `#view-graph` hidden (and `html.tlfs` off), so `#loading` / `#error` with its
  retry button stay visible; the `showView(route())` after the load shows it. `renderGraph()` (`VIEWS.graph.render`)
  **mounts** the existing nodes into the view with `tlMountGraph()` (one engine, one canvas, nothing duplicated; `TLFS_BACK` remembers
  where each came from): `#tlSum` into `#tlBarStart`, `#tlBar` into the top slot `#tlFullTop`, `#tlWrap`, `#tlMini` and `#tlLive` into
  `#tlFullBody`; `tlUnmountGraph()` puts them back into `#tlSec` when the view is left or the data stops supporting a timeline (then
  `#graphEmpty` shows `graphNeed`). `TL.full` is true while mounted. The view is `position:fixed; inset:0` (z-index 1000, like the map):
  desktop hides the top tabs (`#tabs.onfs`), mobile/mid keep the bottom bar and the view ends at `--navh`. `html.tlfs` locks the page
  scroll; `#askBar` is hidden. The graph-view bar is the view's top row (36 / 44 px): at the start the place name `#tlBarLoc` (both places
  when comparing) and `#tlSum` (one line, ellipsis; hidden on mobile, where the readout carries the details), then the zoom, the
  Layers button and, right-aligned, `btn-tltheme` (sun / moon, `toggleTheme()`, `data-tt="tt_theme"`; `applyTheme()` keeps its icon in
  step with `btn-theme`, so the graph has its own light/dark switch), `btn-tlcollapse` (`tt_tlcollapse`) and `btn-tlfsx` ✕ (desktop only).
  `#tlWrap` flex-grows between the bar and `#tlMini`; the view scrolls (`overflow:auto`) only if a very short viewport cannot fit the
  bar, a 140 px plot and the legend row.
  **Collapse (immersive).** `TL.ui={c:0|1}`, remembered in `wd_prefs.tl.ui` (a missing or invalid value is 0). `tlSetCollapsed(c)` saves it,
  closes the panel and calls `tlUiApply()`, which toggles `#view-graph.imm` and `#tabs.tlimm` (`tlImm()` = graph view active, `TL.ui.c===1`
  and a timeline exists) and refreshes `--navh`. Collapsed: `#tlBar`, `#tlSum`, `#tlMini` and the panel are hidden, on mobile/mid the
  bottom tab bar is hidden too (`--navh` becomes 0), the view's padding is only `env(safe-area-inset-*)`, `#tlWrap` loses its border and
  radius and the canvas fills the whole viewport (desktop 100 vw × 100 vh; the `ResizeObserver` on `#tlWrap` redraws). One floating round
  button `#tlExpand` (top-right inside the safe area, 40 px desktop / 44 px mobile+mid, semi-transparent `var(--bg)` with backdrop blur,
  `tt_tlexpand`, sliders icon) restores the controls; focus moves between it and `btn-tlcollapse`. While collapsed `tlPlaceReadout()`
  keeps the readout out of a 56 × 56 px top-right exclusion (below it, or left of it). **Esc order in the graph view** (the one `document`
  keydown handler in `tlInit()`): close the panel → expand (when collapsed) → leave the graph view (`tlFullClose`).
  **Rotate hint.** `tlRotateToast()` shows `tlRotate` once per page load, as a 4 s toast `#tlToast` (`role=status`, in `#tlFullBody`, over the top
  of the canvas), when the graph opens on a phone in portrait; there is no layout row for it any more.
  `#tlLive` is mounted into the view too, so the readout is still announced there.
- **Programmatic access.** `tlGoto(ts)` centres the view on a location-local time string; `tlCursorTs()` returns
  the cursor as `YYYY-MM-DDTHH:MM` (or `null`); `tlInvalidate()` drops the score / AQI / row caches and
  redraws (called by `setAct()` so the score lane follows the planner); `tlRender()` (called from
  `render()`) shows/hides the section, refreshes the toolbar and the legend and draws.
- **Drawing and performance.** `tlSchedule()` coalesces redraws into one `requestAnimationFrame`, with a 160 ms
  timeout fallback because rAF is throttled in background tabs; `tlDraw()` first cancels a still-pending
  frame, so `tlSchedule(); tlRender()` draws once (`TLC.ms` holds the duration of the last draw). `tlPrep()`
  and `tlScores()` rebuild their caches only when `D.hr` / `D2.hr` / the activity change (identity checks),
  and `tlHas()` / `tlPollen()` / `tlSunBy()` / `tlNights()` only when their source object changes, never per
  frame; per frame only the rows between `iA` and `iB` (binary search `tlLb`) are touched. The canvas backing
  store is `W×dpr` with `dpr=min(3,devicePixelRatio)` and is only resized when the size changes; a
  `ResizeObserver` on `#tlWrap` redraws on layout changes. **Theme colours are read at draw time** (`C`,
  `BG`, `txt`, `strong`, `grid`, `halo`, `theme`), so `applyTheme`/`setLang` just trigger a redraw.

**Sticky now-bar.** `#nowBar` (inside `#nowBarW`, a 36 px bar pinned to the top of the viewport while the page
scrolls) shows the place, the current temperature, feels like and today's range (both places when comparing)
while `#hero` is scrolled out of view; tapping it scrolls to the top (`nowBarTop()`, honours
reduced-motion). `HERO_OUT` is driven by an `IntersectionObserver` on `#hero`; `updateNowBar()` rebuilds the
text and visibility (shown only when `active==='now'` and `D` exists — never on PLAN, MAP or Info; `showView`
and every render call it); its label is `T.nowBarAria`.

**Map ⏱ sync.** `mapSyncFromTl()` (called by `showView('map')`) puts the map's time-scrub slider
(`#gridSlider`, `gridSeek`) on the hour of the timeline cursor when it lies 0–23 h ahead; `tlSyncFromMap()`
(only when NOW or the graph view is opened from the map, via `prevView` in `showView`) moves the cursor to the hour the map was left on (`GRIDHR` > 0) and centres
the view with `tlGoto`. Both are wrapped in try/catch.

**Fixed 16-day forecast.** `FCDAYS=16` (the Open-Meteo maximum) is the only forecast span: `fetchFor`, the cache
keys (`FCDAYS|place`), the AI-feed fallback and `hardRefresh()` all use it; there is no range selector any more.

### Ask about the weather (AI search, `#askBar`)

A natural-language question box at the top of the page (v3.23, proxy added in v3.24): the user types a question in
Croatian or English and Claude answers it from the forecast the app has loaded, and the answer **streams in**
as it is written. It is **optional**: nothing else in the app depends on it. There are three modes, picked by
`askMode()` on every use:

- `'key'` — the visitor stored their own Claude API key (`wd_apikey`, Info page). The page calls
  `api.anthropic.com` directly with `stream:true`: unlimited, the model is the `ASKMODELS` choice. **Takes
  precedence** over the proxy when a key is stored.
- `'proxy'` — no key, and `GET /api/ask/state` reported `enabled:true`: the question goes to the same-origin
  Worker (below): 10 questions a day per device, the server's model (Claude Sonnet).
- `'none'` — no key and no (or a disabled, or an unreachable) Worker, e.g. `file://` or a plain static host:
  the bar shows the original no-key hint and the "add a key" note.

- **DOM.** `#askBar` (`role=search`) is the first child of `#dash`, above `#alertBox` and `#tabs`: the row
  `.askrow` with the input `#askIn` (`maxlength=300`, Enter calls `askKey(ev)` → `askSubmit()`), the send button
  `#askGo` and the key button `#btn-askKey` (🔑, `askKeyGo()`); then the mode hint `#askHint` (always one line,
  see below), the example chips `#askEx` (`.askchip` buttons from `T.askEx`; index 7, the sea question, is skipped for
  inland places; index 8 "What is the weather in Split tomorrow?" shows unless the shown place is Split, in which
  case index 9 (the same question for Rijeka) shows instead; shown only while there is no answer yet) and the answer panel `#askOut` (`aria-live=polite`,
  `aria-busy` while an answer streams so screen readers read the finished text; header with collapse and Clear,
  a note — "no key" or "limit reached" — with a button, one `.askent` per answer). The bar is hidden on the MAP
  view and the graph view (`askUi()` toggles `.hidden` for `#view-map` and `#view-graph`; `html.tlfs` also hides it by CSS); it shows
  on NOW, PLAN and Info. `askUi()` refreshes it and is called from `applyTitles()`, `showView()`,
  `renderActive()`, the key handlers and `askRefreshState()`; it rebuilds the chips and the panel only when its
  signature `ASK.sig` (language, theme, state, mode, hint text, history) changes and never touches the input.
- **State.** `ASK={model,hist,busy,open,note,setMsg,memKey,ctrl,seq,sig,state,stateAt,stateTried,paintT}` with the
  constants `ASK_KEY` (`'wd_apikey'`), `ASK_URL`, `ASKMODELS`, `ASK_API` (`'/api/ask'`), `ASK_STATE_API`
  (`'/api/ask/state'`), `ASK_MAXROUNDS` (2) and `ASK_TOOLS` (the `get_forecast` tool definition), declared next to the prefs code **before** `T` because `setLang → applyTitles → askUi`
  already runs during boot. `ASK.state` is the last `GET /api/ask/state` answer
  `{enabled,model,limit,used,remaining,owner,resetAt}` or `null` (unknown); `limit:0` / `remaining:-1` mean an
  unlimited owner (`askUnlimited()`). `ASK.note` is `'nokey'` or `'limit'` (the note shown in the panel).
- **Server state.** `askRefreshState()` calls `GET /api/ask/state` (`credentials:'same-origin'`,
  `cache:'no-store'`, 8 s timeout; one call at a time, a second caller gets the call in flight via `ASK.stateP`)
  once at boot (right after `initLoc()`), after every answer, and when a tab becomes visible again more than 10
  minutes since the last state call (the daily reset). It **fails silently**: the previous state is kept (`null`
  on the first try, which is mode `'none'`); only a well-formed JSON answer with a boolean `enabled` is
  accepted. **Retry rule:** if the boot call failed, it is repeated once after 15 s (a single retry, no loop); and
  when a question is submitted (`askSubmit()`, also an example chip via `askChip()`) while `ASK.state===null`
  and no own key is stored, `askEnsureState()` first awaits one `askRefreshState()` (8 s at most) and only then
  evaluates `askMode()`; the "needs a key" note shows only if the state is still unknown or disabled. While the
  first state call is pending the hint shows a neutral "…" instead of the no-key text. `askBlocked()` says why
  a question cannot go out now: `'nokey'` (mode `'none'`) or `'limit'` (proxy mode with `remaining===0`);
  `askSubmit()` then shows the note and **keeps the typed question** in the box. The same holds when the server
  itself answers 429 or 503 to `/api/ask` (stale client state): `askClaude(q,true)` puts the question back in
  the input (if it is empty) and the end-of-answer `askRefreshState()` refreshes the state.
- **Hint.** `askHintText()` → proxy: "Preostalo danas: 7 od 10 pitanja" / "7 of 10 questions left today"
  (`T.askHintLeft`), owner: "Bez ograničenja" / "Unlimited" (`askHintOwner`), own key: "Vlastiti ključ" / "Own key"
  (`askHintKey`), otherwise the original no-key hint (`askHintNoKey`). At `remaining===0` the input stays usable;
  sending shows `askLimitMsg()` (today's `limit` used up, the reset date from `resetAt`, formatted by
  `askResetTxt()`: the Worker sends a Zagreb calendar date `YYYY-MM-DD`, a timestamp is accepted too) and a
  button "Dodaj vlastiti ključ za neograničeno" / "Add your own key for unlimited" that opens the Info page.
- **Settings panel (Info page).** The card `#askSet` sits on the Info view between `#infoAbout` and the data
  sources, in two short blocks. (a) **Without a key** — `#askFreeTxt` ("Bez ključa: 10 pitanja dnevno po
  uređaju, model Claude Sonnet", the number from `ASK.state.limit`, plus "(currently unavailable)" once the
  state has been tried and the Worker is absent or disabled) and the owner note `askOwnerNote` ("open the
  /api/owner?t=… link once per device"; the page shows only these instructions). (b) **Own key (unlimited)**
  (`askKeyH`): a password-type input `#apiKeyIn` (`autocomplete=off`; Enter saves), `btn-askSave` →
  `askKeySave()`, `btn-askDel` → `askKeyDel()`, the status line `#askKeyState` (`role=status`; shows the key
  **masked** by `askKeyMask()`, the first seven characters, an ellipsis and the last four, and a saved /
  removed message from `T.askMsg`), the model select `#askModel` (`askModelSet(v)`; labelled "Model (own key)":
  it applies to key mode only, the proxy's model is the server's), the cost note (`askSetNote`) and a link to
  console.anthropic.com/settings/keys. `askSetRender()` fills it from `renderInfo()` and `askRefreshState()`;
  `askKeyGo()` (the 🔑 button, also the "Add key" / limit buttons) opens `#info` and focuses the key field.
- **BYOK rule (never break it).** The user's Claude API key lives **only** in `localStorage` under `wd_apikey`
  (`askKeyGet()` / `askKeySave()` / `askKeyDel()`; `askKeyOk()` accepts printable ASCII of 8–300 characters,
  because a header value must be ISO-8859-1). When storage is blocked the key is kept in `ASK.memKey` for the
  page session only. It is sent **only** as the `x-api-key` header of the `POST` to `ASK_URL`
  (`https://api.anthropic.com/v1/messages`, a direct browser call), never to `/api/`. It is never written to
  `wd_prefs` or `wd_last`, a URL or hash, the console or visible text (the input is cleared after saving; only
  the masked form is shown), and it never appears in the source, the changelog or a test. Headers used:
  `content-type`, `x-api-key`, `anthropic-version: 2023-06-01` and `anthropic-dangerous-direct-browser-access: true`
  (the header Anthropic requires for browser calls); the request is sent with `credentials:'omit'`,
  `referrerPolicy:'no-referrer'` and `cache:'no-store'`. `sw.js` never touches a `POST`. Test with a dummy key
  such as `sk-ant-test`, never a real one. The Worker's secrets are never in the page or the repo (below).
- **The Worker proxy (`worker.js`, v3.24 — the second documented exception to "no backend").** A Cloudflare
  Worker (`main` in `wrangler.toml`, `[assets]` binding `ASSETS`) serves every non-`/api/` request from the static
  assets unchanged and adds three same-origin routes: `GET /api/ask/state` → `{enabled,model,limit,used,remaining,
  owner,resetAt}`; `POST /api/ask` with JSON `{q (≤500 chars), lang:'hr'|'en', ctx:object, place:string}` →
  `text/event-stream` (`event: meta` `{model,remaining}`; `event: delta` `{t}`; `event: tool` `{place}` (a place
  lookup starts); `event: toolres` `{place,ok:true,name,lat,lon,tz}` or `{place,ok:false,reason:'not_found'|'fetch_failed'}`;
  `event: done` `{in,out,cached,places:[{name,lat,lon}],calls}`; `event: error` `{code,message}`; the tool events
  and `places`/`calls` are new in v3.25) or a JSON error before the stream (400 `bad_request`, 403 `origin`, 413
  `too_large`, 429 `{error:'limit',limit,used,resetAt}`, 503 `disabled`, 502 `{error:'upstream',status}`); and
  `GET /api/owner?t=TOKEN`, which sets the owner cookie and redirects to `/weather-dashboard.html#info`. The
  Worker holds the Anthropic key: the secrets **`ANTHROPIC_API_KEY`** and **`OWNER_TOKEN`** are set with
  `wrangler secret put` (or the dashboard) and are never in a file; plain vars in `wrangler.toml` are `ASK_MODEL`,
  `ASK_DAILY` (10 a day per visitor), `ASK_DAILY_IP` (40 a day per IP) and `ASK_DAILY_GLOBAL` (400 a day in
  total); each question counts one hit against all three caps. Quotas live in the SQLite-backed
  **Durable Object** `Quota` (binding `QUOTA`, migration `v1`), one object per key, counting per Europe/Zagreb
  day. A request that fails before any stream is sent (upstream refused or unreachable, the pre-stream 502) gives
  its three hits back (`refundHits()` → the object's `/refund`; never for the owner). Two HttpOnly cookies
  identify the caller: `wd_vid` (the visitor id) and `wd_owner` (an HMAC of the owner token, never the token
  itself). `/api/owner` is brute-force limited to `OWNER_ATTEMPTS` = 10 attempts per IP per Zagreb day in
  `handleOwner` (every attempt counts, also a correct one; the 11th gets 429). `worker.js` is listed in `.assetsignore` so it is not published as a static file. Its tests:
  `node tools/test-worker.js`. **Owner link flow:** the owner opens `/api/owner?t=<OWNER_TOKEN>` once per device;
  the Worker sets an **HttpOnly** cookie (the page never reads or writes cookies, only sends requests with
  `credentials:'same-origin'`) and the next `/api/ask/state` reports `owner:true, limit:0, remaining:-1`, so the
  hint reads "Unlimited". The token is never in the page or the source, and `tools/test-worker.js` uses a dummy token. The page works without the Worker
  (mode `'none'`, or `'key'`).
- **Streaming.** `askReadStream(response, onDelta, onDone, onError, onMeta)` is the one parser for both wire
  formats: the proxy's `event: meta|delta|done|error` and Anthropic's `message_start` / `content_block_delta`
  (`delta.text`) / `message_delta` / `message_stop` / `error` (usage and stop reason are collected from them); it
  splits on blank lines (LF or CRLF), ignores comments and unknown events, reads `response.body` with a
  `TextDecoder` (or `response.text()` where streams are missing) and ends the answer with exactly one of
  `onDone` / `onError`; a stream that closes without its final event keeps the text (`incomplete`). `askStream()`
  appends each delta to the entry (`ent.a`) and repaints through `askPaint()` (a 70 ms `setTimeout` coalescer,
  not rAF); the bullet / bold pass `askFormat()` runs on the text so far, a small spinner trails the text until
  the end, and the model / token line and Copy button appear only when the answer is complete.
  `askClaude(q)` owns one `AbortController` and one **30 s** timeout for the whole answer, stream included;
  `askClear()` aborts it. `askReadStream` takes a sixth callback `onEvent(name,data)` for the proxy's `tool` /
  `toolres` events, puts the proxy's `places` / `calls` into the done info, and for Anthropic streams also collects
  the content blocks (`content_block_start`, `text_delta`, `input_json_delta`) and the stop reason, so the done info
  carries `stop` and `blocks` (text blocks and `tool_use` blocks with their parsed `input`). `askStream()` returns
  that info (or `null` after an error).
- **Other places (v3.25, tool use).** A question about a place other than the loaded one ("Kakvo je vrijeme sutra
  u Splitu?") is answered through the model tool `get_forecast({place})`; the system prompt says "When the question
  concerns a place other than DATA.place, call get_forecast for it and answer from the tool result; say which place
  you answered for" (the Worker's prompt and `askSystem` carry the same sentence; the loaded data is labelled DATA).
  **Proxy mode:** the Worker runs the lookups and reports them as `tool` / `toolres` events; the page shows a muted
  status line in the answer card (`ent.stat`, `T.askToolFetch`: "Dohvaćam prognozu za Split…" / "Fetching the
  forecast for Split…"), a failed lookup adds a muted line that stays above the answer (`ent.nf`, `askAddNf`,
  `T.askToolNf` "Mjesto „X“ nije pronađeno" / "Place “X” not found", `T.askToolFail` for `fetch_failed`), the answer
  that follows is kept, and `done.places` (also each `toolres ok:true`) fills `ent.places` (`askAddPlaces`: valid
  coordinates, deduplicated, at most 3). **Own-key mode:** `askKeyRun(ent,q,ctrl)` runs the loop in the page. The
  direct call always sends `tools:ASK_TOOLS`; on `stop_reason:'tool_use'` it runs `askLookupPlace(place)` for each
  `tool_use` block (at most 2 per round; further ones get an `is_error` result), which is `geocode(place)` (consults
  `LOCHINT`) → `fetchOpenMeteo(loc,7)` → `askBrief(d,name)` (a compact JSON string of that forecast object: `ok`,
  place, tz, local time/date/weekday, a short legend, `now` via `askNow`, 48 hourly rows via `askHourly`, 7 daily
  rows with sunrise/sunset via `askDaily`; trimmed to 36/24/12 hours to stay ≤ 6 kB), then streams a second call
  with the assistant's blocks and a user message of `tool_result`s (`is_error:true` with `{ok:false,reason}` for a
  failed lookup). **At most 2 tool rounds** (`ASK_MAXROUNDS`): the third request goes out with
  `tool_choice:{type:'none'}`, so it must answer. The text of the rounds is joined with a blank line (`ent.sep`),
  tokens add up across the requests, and `ent.meta.calls` is the number of requests. The 30 s timeout covers the
  whole loop. The lookup is a one-off fetch: it never touches `D`, `D2`, `LOCTZ`, the forecast cache or `FEEDS`.
  **The chip:** under a finished answer each place gets one `.lbtn.askplace` button "Otvori Split" / "Open Split"
  (`T.askOpenPlace`; 44 px on `mobile`/`mid` through `.lbtn`), which calls `askOpenPlace(p)`: `locHintPut` seeds
  `LOCHINT` (`wd_lochint`) with the exact coordinates, then `locOpenFlag=true; locStageA=name; locStageB=null;
  locClose(true)` — the same path as `locPick`, so the place becomes the only location and the forecast loads (from
  the Info view it also goes to `#now`). The footer meta line appends "2 poziva" / "2 calls" (`T.askCalls`) when
  `calls` is above 1.
- **Models and cost.** Key mode: `claude-sonnet-5` (default, more accurate) and `claude-haiku-4-5-20251001`
  (cheaper), the choice is `wd_prefs.aiModel` (`loadPrefs` accepts only `ASKMODELS`); `max_tokens` is 600. A
  question costs roughly 1–3 cents on Sonnet and under 1 cent on Haiku (said in the settings panel,
  `askSetNote`); an other-place question adds a second request that carries the ~6 kB brief, roughly doubling that
  (a third only when a second place is looked up); the system prompt's rules-and-data block carries `cache_control: ephemeral` and the changing
  clock line comes after it. Proxy mode uses the server's model (`ASK_MODEL`). Each answer shows the model and
  the tokens in / out / cached.
- **What is sent.** The question (at most 300 characters in the page; the Worker accepts 500) and
  `askContext()`, a compact JSON string of what is already loaded: place and time zone, today's date and weekday
  (`askDow`, UTC noon, no browser clock), a unit legend, `now` (`askNow`), `hourly` (`askHourly`: 48 hourly rows,
  then 3-hour blocks up to +168 h; the AI fallback feed sends its 24 rows), `daily` (`askDaily`: 16 days with the
  day's wind / gust / UV maxima and sunrise / sunset from `D.sunDays`), alerts, sea, air quality with the
  strongest pollen, climate normals and the activity scores of the next seven days (`askScores`, straight from
  `scoreDays`), plus the second place in comparison mode (48 h and 7 days). Key mode sends it through
  `askSystem(ctx)` (the two system blocks). Proxy mode sends `{q, lang, ctx, place}` where `ctx` is the parsed
  `askContext()` object plus `now_local` (`"YYYY-MM-DD HH:MM"` from `locNowStr()`, the place's clock) and
  `place`. No coordinates, no key and nothing personal is included.
- **Never stored.** The answers live only in `ASK.hist` (the last five questions, in memory; `askClear()`
  also aborts a pending request); no question, answer or history is written to `localStorage`, and nothing is
  logged by the page.
- **Rendering and errors.** Answers are turned into DOM with `textContent` only (`askFormat()` understands
  `- ` bullets and `**bold**`, never HTML). A failed call is shown inline in its entry (`askErrText`, the
  `T.askErr` words: key 401 / 403 with an "Add key" button, rate 429, busy 529 / 5xx, net, time, offline,
  bad 400 / 404 with the API's message cut to 200 characters, http, empty, nodata). **Proxy errors**
  (`askHttpErr`): 429 → `askLimitMsg()` with the reset date, the limit button, and `ASK.state.remaining=0`;
  403 → `origin` ("Otvori stranicu na weath.er45.com" / "Open the page on weath.er45.com"); 503 → the entry is
  dropped, `ASK.state.enabled=false` and the no-key note is shown (back to the key hint); 502 / 5xx → `busy`
  ("Servis je zauzet" / "Service busy"); 400 / 413 → `bad`. An `event: error` inside the stream
  (`askStreamErr`) keeps the text received so far and appends a short "⚠ Answer interrupted" note (`T.askErr.cut`),
  or shows the mapped error when nothing arrived. A question is user-triggered, so none of this is a `FEEDS`
  source. Every `ask*` string exists in both languages; the answer follows the language of the question.

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
`aiModel` (the AI-search model, one of `ASKMODELS`) and `tl` (`{v:2,zoom,layers,style,names,axis,ui}` of the
timeline; `loadPrefs()` accepts only known zoom values, 0/1/2/boolean layer flags for known layers — an older
snapshot's "on" becomes state 2 —, a known line style, the boolean `names.c`/`names.f` and an `axis` mode with a
numeric `lo < hi` override, and `ui.c` only when it is 1 or `true`, otherwise 0). The v3.21 keys `CONF`/`MOON`/`TIDE`/`PRES`/`BBQ`/`CMODE` are no longer written; only a stored
`PRES` is migrated once into `tl.layers.pres` (only when no timeline pressure choice is stored) and disappears
with the next save. **MP (Monty Python) is deliberately not stored.** `PREFS_LIVE`
is `false` during boot, so reading the saved prefs never rewrites them; it flips to `true` at the end of
boot. **First visit** (no `wd_prefs`): `lang` follows `navigator.language` (`hr*` → Croatian, otherwise
English) and the theme follows the OS preference. A new switch must be added to both `savePrefs` and
`loadPrefs`.

All `localStorage` keys (every access wrapped in try/catch): `wd_recents` (recent places), `wd_lochint`
(exact coordinates of places picked from search), `wd_bbqcheck` (BBQ checklist ticks), `wd_last` (last
direct-mode forecast snapshot `{v:APPV,key,loc,t,D}` with `D.hr` stored columnar as `D.hrc`, ≤ 400 kB), `wd_prefs`
and `wd_apikey` (the user's own Claude API key for the AI search: **only** the key, written and removed by
`askKeySave()` / `askKeyDel()`, read by `askKeyGet()`; never copied into `wd_prefs` or `wd_last`; see "Ask about the
weather").

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
`feedMark(name,ok,err,na)` for forecast/ai/marine/air/climo/radar/sat/lightning/pwa; `na:true` means "this
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
error tiles), toggleable layers in `MLAYERS`/`mlyToggle`: RainViewer radar frames (at most
**two frames stay attached** at a time, current + preloaded next, so panning doesn't refetch every
frame), **satellite clouds** (below), Blitzortung live lightning (reconnects with exponential backoff), and an Open-Meteo **point
grid** (`gridRefresh`/`gridDraw`: a temperature IDW heatmap with a legend, wind arrows and 48 h rainfall — **no
clouds**: `gridActive()` is temp/wind/rain only and the grid fetch carries no `cloud_cover`; cache keyed to a zoom-scaled cell so high-zoom pans stay accurate). The grid fetch carries
24 h of hourly temperature/wind/gusts/precip per point, and a **⏱ time-scrub slider** in the bottom
panel (0 = now … +24 h, `tt_gridSlider` "Grid data hour slider (temperature/wind/rain)") redraws the heatmap, labels and rain blobs for the chosen hour straight
from that cached response — no refetch while scrubbing; the legend and the next-2h rain strip's pill
re-label to match; opening the map puts the slider on the hour chosen on the NOW timeline, and coming back moves the timeline cursor to the hour the map was left at (see "Map ⏱ sync" above). Wind labels show gusts in parentheses when they clear speed+5. Also the next-2h rain
strip, click-to-forecast (`onMapClick`/`pickPoint`: reverse-geocodes the tapped point with Nominatim and
loads its forecast) and a **📍 my-location** Leaflet control (`locateOnMap`) that geolocates and
recentres/pins the map. Layout: on `mobile` only, `#mlyPills` (the layer buttons) is a fixed swipeable
row right above the bottom bar and `#mapBottom` sits above that row; on `mobile` and `mid` the zoom and
locate controls are top-right (below the top row), clear of the bottom panel, and the attribution text
lives in the bottom panel. The ✕ (desktop only) returns to `#now`.

- **Satellite clouds** (the ☁️ pill, default off; code banner `/* ---------- Satellite clouds ... ---------- */`, state `SAT`, `sat*` functions after the radar code).
  Observed Meteosat imagery from the EUMETSAT EUMETView WMS (see Data sources), **not** tiles: for the last 2 hours,
  13 frames = the newest infrared time and the 12 previous 10-min steps (`satList()`: the newest times come from the two per-layer
  GetCapabilities `<Dimension name="time" default=…>`; list cached 5 min, refreshed when the map opens after that; if a caps request
  fails the documented fallback is IR newest = UTC now floored to 10 min − 30 min, CLM newest = floored to 15 min − 45 min, and the feed
  row says "caps: …" until the first frame loads). Each IR frame pairs with the cloud-mask (CLM) frame at the latest 15-min time ≤ it and ≤ the
  newest CLM time; each unique CLM time is fetched once and shared (about 13 IR + 9 CLM GetMaps per box). **View box:** one GetMap per frame per
  layer for the viewport padded by 25 % on every side, in EPSG:3857 metres (`satNewBox`, clamped to ±20037508.34; IR image = min(box CSS px,
  box metres / 600, 1600) on the longer side, CLM = box metres / 5000 clamped 32…512). `satBoxCheck()` (run after a 300 ms debounce on
  `moveend`/`zoomend`/`resize`) keeps the box while the viewport stays inside it at the same integer zoom — small pans cause **no** new GetMaps —
  and otherwise makes a new box, dropping the old frames but keeping the old picture on screen until the new box paints its first frame.
  **Pixels** (`satDecIr`/`satDecCm`/`satPaint`): per frame one ramp byte per pixel from the IR grey (smoothstep over grey 70…160) plus the CLM red
  channel upscaled smoothly onto the IR size (m = red/255; white = cloud, clear land/water ≈ 0). Alpha = aMax·max(LOW·m, ramp) with both, aMax·ramp
  with IR only, aMax·0.55·m with the mask only; dark map tint white (aMax 0.85, LOW 0.40), light map tint slate rgb(92,104,122) (0.75, 0.38) — low
  cloud / fog shows faint, high cold tops solid. The per-frame data is theme-independent, so `mapThemeToggle` → `satRefresh()` only repaints
  (no refetch). **Rendering:** one overlay whose element is a single `<canvas>` at the IR image size (`satOverlayCls()`, an `L.ImageOverlay` subclass
  supplying a canvas the way `VideoOverlay` supplies a `<video>`, so Leaflet positions and zoom-animates it); showing a frame writes its alpha into an
  `ImageData` and `putImageData`. **Panes / z-order:** base tiles (tilePane 200) < `satPane` (250, clouds) < `radarPane` (260, the radar tile layers,
  still `className:'radarlayer'` with the FIX-2 at-most-2-attached rule) < the temperature heat overlay < markers/labels. The canvas is not a tile, so
  the dark-theme tile filters never touch it. **Loading** (`satPump`/`satRun`): `tfetchP(url,{mode:'cors'},15000)` → blob → `createImageBitmap` (fallback
  `Image` with `crossOrigin='anonymous'`); at most 2 requests in flight, the frame to show now first, then the following frames in playback order; a
  generation counter (`SAT.gen`, plus the identity of the frame's entry) discards results from an old box, an old frame list or a layer switched off; a failed request is
  retried once later, a failed frame is skipped (the previous picture stays) and never stalls the animation; leaving the map pauses the queue
  (`SAT.paused`, set in `showView`), returning resumes it (`satEnsure`); switching the layer off removes the overlay and drops the data. **Failure is visible:**
  `feedMark('sat',…)` (first frame result, caps fallback, total failure; Info row "Satellite clouds (EUMETSAT)"), the pill gets `dimmed` with the title
  "Satellite unavailable — click to retry" (a click retries instead of switching off) and the timeline label says "satellite unavailable" (`SAT.fail`:
  nothing loaded after 4 failed requests, or every frame dead). While `SAT.fail` holds, `satPump` sends **no** more requests; a retry click or a
  new view box (`satNewBox` clears `SAT.fail`) re-probes the service with a few requests.
- **One shared timeline.** `#radarCtl` (⏮ ▶️ ⏭ slider time) is the one observation timeline, shown when radar **or** clouds is on, with **one** 600 ms
  play timer (`radarPlay`/`tlmStep`; switching radar off mid-play keeps playing the clouds, `tlmRealign` stops the timer only when no layer is left; the
  control tooltips `tt_radarPrev`/`tt_radarPlay`/`tt_radarNext`/`tt_radarSlider` say "radar / satellite"). The master list (`tlmMaster()`) is the radar frames when radar is on and loaded, else the satellite frames; with radar as
  master the satellite shows the frame with the latest time ≤ the radar frame's (else the oldest; a failed frame falls back to the nearest good one,
  `satIdxFor`). Toggling radar or clouds keeps the time position (`TLPOS`, `tlmRealign`) and resets the slider max. `tlmSync()` writes slider, label and the
  satellite frame: radar only "HH:MM" (+ " · forecast"), clouds only "HH:MM ☁", both "HH:MM · ☁ HH:MM" (the second is the satellite frame's time), "☁ …" while
  loading. **All map times are in the place's time** (`mapHM()`: the UTC fields of t + `LOCTZ.off`, browser time only when there is no offset), the radar's too.
  `#radarNote` (`updateMapNote()`, re-run by `tlmSync`) carries, **only while the ☁️ layer is on** (keeps the phone panel short), the cloud legend and the
  EUMETSAT credit: "☁️ Meteosat satellite, last 2 h: faint = low cloud/fog, solid = high cloud · Contains modified EUMETSAT Meteosat data <UTC year of the shown
  frame>" / "… Sadrži izmijenjene EUMETSAT Meteosat podatke <godina>"; the base-layer attribution always ends with " · EUMETSAT".

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

**Worker test** (dependency-free, node ≥ 20):

```powershell
node tools/test-worker.js
```

It imports `worker.js` as a module, runs the real `Quota` Durable Object class against an in-memory storage fake and
stubs the upstream `fetch` with a fake Anthropic SSE stream: the quotas and their reset, the owner cookie, the
`/api/ask` and `/api/ask/state` contract above and its error cases. It prints `WORKER TESTS OK` and exits 1 on any
failure. Run it after touching `worker.js`; run `node --check worker.js` too.

## Data sources (all client-side; keyless except the optional AI search, which uses the visitor's own key)

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
- **Anthropic Messages API** (`api.anthropic.com/v1/messages`) — only for "Ask about the weather", only when the
  visitor has stored their own key (`wd_apikey`) and asks a question; a direct, streamed browser `POST` with the
  `anthropic-dangerous-direct-browser-access` header. Models `claude-sonnet-5` / `claude-haiku-4-5-20251001`.
  See "Ask about the weather" for what is sent and the key rules.
- **Same-origin Worker** (`/api/ask`, `/api/ask/state`, `/api/owner`; `worker.js`) — only for "Ask about the
  weather" without a stored key: the free daily questions, streamed, with the server-held key. Never cached by
  `sw.js`; reached with `credentials:'same-origin'`. See "Ask about the weather".
- **Nominatim** (`nominatim.openstreetmap.org`) — reverse geocoding for map clicks / GPS.
- **RainViewer** (`api.rainviewer.com` + `tilecache.rainviewer.com`) — rain-radar tile frames for the Map
  view: past ~2 h plus nowcast frames when the public API provides them (lazy; frame list cached ~5 min;
  requires "© RainViewer" attribution).
- **EUMETSAT EUMETView** (`view.eumetsat.int/geoserver`) — Meteosat satellite clouds on the Map (the ☁️ layer): keyless WMS, `Access-Control-Allow-Origin: *` (so the
  pixels are readable after a CORS fetch); time-pinned GetMap responses are cacheable for 7 days. Two layers, **one GetMap per frame per layer, never tiles**
  (the service delays — does not refuse — more than about 20 requests per window per IP): IR `layers=mtg_fd:ir105_hrfi`, `styles=mtg_fd:mtg_fd_ir105_hrfi_grayscale`,
  `image/jpeg` (every 10 min, the newest frame ~20–25 min behind real time, bright = cold cloud tops) and the cloud mask `layers=msg_fes:clm`, `styles=` (empty), `image/png`
  (**never JPEG**: the class colours must survive; every 15 min, ~30–35 min behind; white = cloud, green = clear land, blue = clear water; cloudiness = red/255).
  Params: `service=WMS&version=1.3.0&request=GetMap&crs=EPSG:3857&bbox=minx,miny,maxx,maxy&width&height&time=YYYY-MM-DDTHH:MM:00Z` (UTC). The newest time comes from
  the per-layer capabilities (`/geoserver/mtg_fd/ir105_hrfi/ows?…request=GetCapabilities`, `/geoserver/msg_fes/clm/ows?…`, ~8 KB, max-age 120): the time dimension's `default`
  attribute. **Never request a time newer than that**: it answers HTTP 200 with an XML ServiceException (the image decode fails). Licence: EUMETSAT Data Policy (2026) — the WMS
  single-channel visualisations are "Advanced Image Products" and the cloud mask a "Derived Product", both Core data, CC-BY-4.0, free for any use at any latency; required credit
  "Contains modified EUMETSAT Meteosat data <year>" (HR "Sadrži izmijenjene EUMETSAT Meteosat podatke <godina>", year = UTC year of the shown frame), shown in `#radarNote`.

All data requests go through `tfetch(url, ms)`, a `fetch` wrapper with a timeout, or its sibling `tfetchP(url, opts, ms)` (same timeout plus fetch
options and an abort on timeout; the satellite clouds use it with `mode:'cors'`) (the AI-search calls in
`askClaude()` and the `askRefreshState()` state call are the exceptions: they carry their own `AbortController` and
timeout, 30 s for a whole streamed answer and 8 s for the state).

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
5. **Static & deployable.** No build, no bundler, no secrets in any file. The app works from a plain static host
   (and reasonably from `file://`); the only server-side code is `worker.js` (the AI-search proxy, the second
   documented exception after the PWA files), and the page works fully without it. The only credential the page
   ever handles is the visitor's own Claude API key (rule 12); the source ships none, and the Worker's
   `ANTHROPIC_API_KEY` / `OWNER_TOKEN` exist only as Cloudflare secrets.
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
   failure into an empty-looking section. (A failed AI-search question is shown inline in its answer entry.)
10. **Tap targets.** Interactive controls are ≥ 36 px tall on desktop and 44 px on `mobile`/`mid`.
11. **The timeline is canvas, not Chart.js — read theme colours at draw time.** `tlDraw()` takes `C`, `BG`,
    `txt`, `strong`, `grid`, `halo` and `theme` on every frame (no colours cached across frames or hard-coded),
    keeps the summary above (`#tlSum`) and the legend below (`#tlMini`, custom DOM, plus the panel chips in `#tlPanel`), and every user-visible
    string it draws or announces (labels, readout, legend, aria) exists in both languages. Keep the cursor
    inside the pannable range (`tlCurClamp`) and redraw through `tlSchedule()`. The legend chips (mini row and panel) are the only series
    control (three states per series: labels / no labels / hidden), the axis strips always draw their ticks, a
    series with no data is never drawn or listed, and a touch swipe must never start an axis rescale.
12. **The API key never appears in the source, prefs or snapshots.** The visitor's Claude API key exists only in
    `localStorage` `wd_apikey` (or `ASK.memKey` when storage is blocked) and in the `x-api-key` header of the
    request to `api.anthropic.com`. It is never written to `wd_prefs`, `wd_last`, a URL, the console, the DOM
    (only the masked form) or any test or fixture (use a dummy such as `sk-ant-test`); `grep -n "sk-ant"` finds
    only the masked placeholder example. Questions, answers and the forecast context are never stored either. The
    Worker's secrets (`ANTHROPIC_API_KEY`, `OWNER_TOKEN`) never appear in the page, the repo, a test or the
    console, and the owner cookie is HttpOnly: the page never reads it.

## Code layout within the single file

Roughly top-to-bottom:

- `<head>` / CSS — theme variables, responsive layout rules (`#wrap.mobile` / `#wrap.mid` / desktop),
  card/hero/stat/group styles, the control sizes above.
- `<body>` markup — header (`#locSel`, `btn-lang`, `btn-theme`), then `#dash`, which starts with `#askBar` (AI
  search), `#alertBox` and `#tabs` (NOW, GRAPH, PLAN, MAP — `tab-now`/`tab-graph`/`tab-plan`/`tab-map`) and continues with the
  per-view `<section>`s: `#view-now` and `#view-plan` (DOM
  orders above; the BBQ and hike sections live inside PLAN as `#ps-bbq`/`#ps-hike`), `#view-map`, and
  `#view-info` (about + the AI-search settings card `#askSet` + the `#infoFeeds` status panel + the bilingual
  `CHANGELOG` array + the Monty Python switch `btn-mp`/`toggleMP()`). The shared footer is the last child of
  `#dash`. The loading and error screens (`#loading` / `#error`) come before `#dash` in `#wrap`, and the
  graph view `#view-graph` (a full-screen `position:fixed` section, like `#view-map`; it holds `#tlFullTop`, `#graphEmpty`, `#tlFullBody` with
  `#tlToast`, and `#tlExpand`) after it, followed by the Layers panel (`#tlPanelBk`, `#tlPanel`).
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
  `locHintSave()`, which writes through `locHintPut(name,lat,lon,station)`; the "Open <place>" chips of the ask answers call `locHintPut` too) and `geocode()` consults that cache first. Closing with a pick (`locClose(true)`)
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
  `drawBbqGrill`) · **timeline** (`tlInit`, `tlRender`, `tlDraw`, `tlSchedule`, `tlSetZoom`, `tlFitX`, `tlApplyScale`, `tlRep`, `tlSetLayer`, `tlSetFit`, `tlSetStyle`,
  `tlLegend`, `tlPanelOpen`/`tlPanelClose`, `tlGoto`, `tlCursorTs`, `tlInvalidate`, `tlHome`, `tlMoveCursor`, `tlTap`, `tlReadoutLines`,
  `renderGraph`, `tlMountGraph`/`tlUnmountGraph`, `tlUiApply`/`tlSetCollapsed`/`tlImm`, `tlRotateToast`, `tlFullOpen`/`tlFullClose`, `setNavH`; state `TL`, `TLP`, cache `TLC`) · maps
  (`loadLeaflet`, the weather map incl. `locateOnMap`, the shared timeline `tlmMaster`/`tlmSync`/`tlmRealign`/`tlmStep`/`mapHM`, and the satellite clouds `satList`/`satBoxCheck`/`satNewBox`/`satPump`/`satRun`/`satPaint`/`satShow`/`satRefresh`/`satEnsure`/`satOverlayCls`; state `SAT`, `TLPOS`) · view router (`ROUTES`/`ROUTEACT`/`VIEWS`/
  `showView`/`renderActive`/`updateAlertBox`) · Info panel (`renderInfo`, `renderFeeds`, `CHANGELOG`) · **Ask the
  weather** (`askKeyGet`/`askKeySave`/`askKeyDel`, `askMode`, `askRefreshState`, `askContext`, `askSystem`, `askClaude`, `askReadStream`, `askUi`; state `ASK`,
  declared earlier next to the prefs) — the banner `/* ---------- Ask the weather (A1) ... ---------- */` sits
  between the Info panel and the view router.

Notable globals: `lang`, `theme`, `layout` (`'mobile'`/`'mid'`/`'desktop'`), `FCDAYS` (16), comparison state
(`selB`/`D2`), location caches (`LOCHINT`, `GEO_LOC`, `MAP_LOC`, `LOCTZ`), `GROUPS`, `PLAN`, `TL`/`TLC` (the
timeline), `HERO_OUT` (sticky now-bar), `ASK` (AI search), and the feature toggles (`VEGAN`, `MP`). `MP` is a "Monty Python"
easter-egg label set.

## Making changes

- Edit `weather-dashboard.html` directly; keep the section-banner organization.
- When touching the timeline: draw through `tlSchedule()`, set the cursor only through `tlCurClamp`, and check all
  three zooms, both themes, both languages and keyboard use (arrows, +/−, Home, Esc), the legend states (labels /
  no labels / hidden, plus the ghost chip), the Layers & display panel (bottom sheet at 412×891 and 891×412, side sheet at 1440×900, Tab
  trap, Esc), the graph view expanded and collapsed (canvas = the whole viewport when collapsed, 360 px wide with no horizontal scroll,
  the theme switch in both themes) and mouse versus touch on the axis strips.
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
