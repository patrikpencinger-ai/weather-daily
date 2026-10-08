#!/usr/bin/env node
/* I1 time-correctness test for weather-dashboard.html. Dependency-free, node >= 18.
 *
 *   node tools/test-time.js
 *
 * The parent run spawns itself twice (child_process) with TZ=Europe/Zagreb and TZ=America/New_York,
 * because process.env.TZ cannot be changed reliably after node has started. The child run
 *   (a) reads weather-dashboard.html and extracts the <script>,
 *   (b) pulls the source of the functions/consts the pure builder needs BY NAME with a small
 *       brace-matching extractor and evaluates them with new Function,
 *   (c) feeds fixture API responses (Tokyo, and DST fall-back / spring-forward days) to
 *       buildOpenMeteo() and asserts that "now", "today", "yesterday" and every hour index come from the
 *       location-local time strings and not from the browser clock or a 24-rows-per-day assumption.
 * Prints "TIME TESTS OK" and exits 0 on success, exits 1 on any failure. */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ZONES = ['Europe/Zagreb', 'America/New_York'];
const HTML = path.join(__dirname, '..', 'weather-dashboard.html');

/* ======================================================================= parent */
if (!process.env.TIME_TEST_CHILD) {
  let bad = 0;
  for (const tz of ZONES) {
    const r = cp.spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { TZ: tz, TIME_TEST_CHILD: '1' }),
      encoding: 'utf8'
    });
    process.stdout.write('--- browser zone ' + tz + ' (exit ' + r.status + ')\n' + (r.stdout || '') + (r.stderr || ''));
    if (r.status !== 0) bad++;
  }
  if (bad) { console.log('TIME TESTS FAILED (' + bad + ' of ' + ZONES.length + ' zones)'); process.exit(1); }
  console.log('TIME TESTS OK (' + ZONES.join(', ') + ')');
  process.exit(0);
}

/* ======================================================================= source extractor */
function skipLiteral(s, i) { /* s[i] is ' " or ` -> index after the closing quote */
  const q = s[i]; i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    i++;
  }
  throw new Error('unterminated literal');
}
function skipTrivia(s, i) { /* comments; returns new index or i unchanged */
  if (s[i] === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); return e < 0 ? s.length : e; }
  if (s[i] === '/' && s[i + 1] === '*') { return s.indexOf('*/', i) + 2; }
  return i;
}
function matchClose(s, i) { /* s[i] is ( [ or { -> index after the matching closer */
  let d = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') { i = skipLiteral(s, i); continue; }
    const j = skipTrivia(s, i); if (j !== i) { i = j; continue; }
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return i + 1; }
    i++;
  }
  throw new Error('unbalanced');
}
function extractFunction(src, name) {
  const re = new RegExp('(?:^|\\n)((?:async\\s+)?function\\s+' + name + '\\s*\\()');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  const start = m.index + (m[0][0] === '\n' ? 1 : 0);
  const paren = start + m[1].length - 1;
  let i = matchClose(src, paren);
  while (src[i] !== '{') i++;
  return src.slice(start, matchClose(src, i));
}
function extractConst(src, name) { /* const|let NAME=... up to the depth-0 ';' */
  const re = new RegExp('(?:^|\\n)((?:const|let)\\s+' + name + '\\s*=)');
  const m = re.exec(src);
  if (!m) throw new Error('const not found: ' + name);
  const start = m.index + (m[0][0] === '\n' ? 1 : 0);
  let i = start + m[1].length;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipLiteral(src, i); continue; }
    const j = skipTrivia(src, i); if (j !== i) { i = j; continue; }
    if (c === '(' || c === '[' || c === '{') { i = matchClose(src, i); continue; }
    if (c === ';') return src.slice(start, i + 1);
    i++;
  }
  throw new Error('unterminated const: ' + name);
}

/* ======================================================================= load the app code */
const html = fs.readFileSync(HTML, 'utf8');
const scriptM = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)].find(x => x[1].length > 1000);
if (!scriptM) { console.log('FAIL cannot find the app <script>'); process.exit(1); }
const script = scriptM[1];

const CONSTS = ['APPV', 'WD_LAST_KEY', 'LOCTZ', 'ICON', 'ICON_NIGHT', 'GRILLALL', 'HRCOLS', 'WMO', 'COMPASS'];
const FUNCS = ['timePenalty', 'scoreBio', 'grillCompound', 'hrPack', 'hrRow', 'setLocTz', 'locNowAt', 'locNow', 'locNowStrAt', 'locNowStr',
  'todayIso', 'tsMin', 'sameDayISO', 'iconFor', 'buildOpenMeteo', 'fetchOpenMeteo', 'saveLast', 'readWdLast'];
/* T (the translation table) pulls in half the app; the builder only reads three label keys from it, so it is stubbed */
const parts = ['const T={en:{best:"Best",worst:"Worst",dry:"dry"},hr:{best:"Najbolje",worst:"Najgore",dry:"suho"}};', 'function feedMark(){}', 'function tfetch(){throw new Error("no network in tests");}'];
CONSTS.forEach(n => parts.push(extractConst(script, n)));
FUNCS.forEach(n => parts.push(extractFunction(script, n)));
parts.push('return {hrPack, hrRow, iconFor, ICON, buildOpenMeteo, fetchOpenMeteo, locNow, locNowStr, locNowStrAt, locNowAt, todayIso, setLocTz, sameDayISO, saveLast, readWdLast, tsMin, APPV, getTz(){return LOCTZ;}};');
const fakeLS = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; })();
const app = new Function('localStorage', parts.join('\n'))(fakeLS);
const builderSrc = extractFunction(script, 'buildOpenMeteo');

/* ======================================================================= assertions */
let fails = 0, passes = 0;
function ok(cond, msg, detail) {
  if (cond) { passes++; console.log('  ok   ' + msg); }
  else { fails++; console.log('  FAIL ' + msg + (detail !== undefined ? '   -> ' + detail : '')); }
}
function eq(a, b, msg) { ok(a === b, msg, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

/* ======================================================================= fixtures */
const pad = n => String(n).padStart(2, '0');
function addDays(date, n) { return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10); }
function addMin(ts, n) { return new Date(app.tsMin(ts) * 60000 + n * 60000).toISOString().slice(0, 16); }
const HOURS24 = () => Array.from({ length: 24 }, (_, i) => i);
/* o: {off,tz,start,nDays,now,rowHours(date)->hour numbers (a repeated hour appears twice)} */
function mkFixture(o) {
  const dates = Array.from({ length: o.nDays }, (_, i) => addDays(o.start, i));
  const H = { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [], apparent_temperature: [], relative_humidity_2m: [],
    wind_speed_10m: [], precipitation: [], uv_index: [], pressure_msl: [], visibility: [], freezing_level_height: [], wind_gusts_10m: [], snowfall: [],
    cloud_cover_low: [], cloud_cover_mid: [], cloud_cover_high: [], is_day: [] };
  dates.forEach((d, di) => {
    const seen = {};
    o.rowHours(d).forEach(hh => {
      const dup = seen[hh] ? 1 : 0; seen[hh] = 1;
      H.time.push(d + 'T' + pad(hh) + ':00');
      H.temperature_2m.push(hh + (dup ? 0.25 : 0));               /* temperature = hour of day */
      H.precipitation_probability.push((hh * 3) % 100);
      H.weather_code.push(hh % 5 === 0 ? 61 : 0);
      H.apparent_temperature.push(hh - 1);
      H.relative_humidity_2m.push(40 + hh * 2);                    /* 13:00 -> 66 */
      H.wind_speed_10m.push(5 + hh / 2);
      H.precipitation.push(hh % 5 === 0 ? 0.4 : 0);               /* J1: mm per hour */
      H.uv_index.push(hh / 3);
      H.pressure_msl.push(1000 + di * 10 + hh + (dup ? 0.5 : 0)); /* varies within and between days */
      H.visibility.push(10000 - hh * 10);
      H.freezing_level_height.push(2500 + hh);
      H.wind_gusts_10m.push(8 + hh);
      H.snowfall.push(0);
      H.cloud_cover_low.push(hh); H.cloud_cover_mid.push(hh + 1); H.cloud_cover_high.push(hh + 2);
      H.is_day.push(hh >= 6 && hh < 18 ? 1 : 0);                  /* I2: daylight 06:00-17:59 */
    });
  });
  const Dd = { time: dates, temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [], weather_code: [],
    precipitation_sum: [], uv_index_max: [], wind_speed_10m_max: [], wind_gusts_10m_max: [], sunrise: [], sunset: [] };
  dates.forEach((d, di) => {
    Dd.temperature_2m_max.push(20 + di); Dd.temperature_2m_min.push(10 + di); Dd.precipitation_probability_max.push(30 + di);
    Dd.weather_code.push(di % 2 ? 61 : 0); Dd.precipitation_sum.push(di * 0.1); Dd.uv_index_max.push(5); Dd.wind_speed_10m_max.push(15 + di);
    Dd.wind_gusts_10m_max.push(25 + di); Dd.sunrise.push(d + 'T06:30'); Dd.sunset.push(d + 'T17:00');
  });
  const m15t = [], m15p = [];
  for (let k = 0; k < 16; k++) { m15t.push(addMin(o.now.slice(0, 11) + o.now.slice(11, 13) + ':00', -60 + 15 * k)); m15p.push(k % 4 ? 0 : 0.2); }
  return {
    utc_offset_seconds: o.off, timezone: o.tz,
    current: { time: o.now, temperature_2m: 18.2, apparent_temperature: 17, relative_humidity_2m: 60, wind_speed_10m: 12, wind_direction_10m: 200, weather_code: 1, precipitation: 0, pressure_msl: 1012 },
    minutely_15: { time: m15t, precipitation: m15p },
    hourly: H, daily: Dd
  };
}
const valueAt = (fx, field, ts) => fx.hourly[field][fx.hourly.time.indexOf(ts)];
const rowsOf = (fx, date) => { const r = []; fx.hourly.time.forEach((t, i) => { if (t.slice(0, 10) === date) r.push(i); }); return r; };
const meanP = (fx, date) => { const r = rowsOf(fx, date); return r.reduce((a, i) => a + fx.hourly.pressure_msl[i], 0) / r.length; };
const build = (fx, name) => app.buildOpenMeteo(JSON.parse(JSON.stringify(fx)), { name: name, lat: 0, lon: 0, station: 'X' }, 7);

/* ======================================================================= tests */
const zoneName = process.env.TZ;
const bOff = -new Date().getTimezoneOffset() / 60;
console.log('child: browser zone ' + zoneName + ' (UTC' + (bOff >= 0 ? '+' : '') + bOff + ')');
ok(zoneName === 'Europe/Zagreb' ? bOff >= 1 && bOff <= 2 : bOff <= -4 && bOff >= -5, 'TZ env applied to the test process', 'offset ' + bOff);

console.log('static: the builder reads no clock');
ok(!/new Date\s*\(\s*\)/.test(builderSrc), 'buildOpenMeteo has no new Date()');
ok(!/Date\.now\s*\(/.test(builderSrc), 'buildOpenMeteo has no Date.now()');
ok(!/getHours\s*\(/.test(builderSrc), 'buildOpenMeteo has no getHours()');
ok(/return buildOpenMeteo\(j,loc,range\)/.test(extractFunction(script, 'fetchOpenMeteo')), 'fetchOpenMeteo only fetches and delegates to buildOpenMeteo');

console.log('F1 Tokyo (UTC+9), now 2026-10-08T20:45, all days 24 rows');
{
  const fx = mkFixture({ off: 32400, tz: 'Asia/Tokyo', start: '2026-10-07', nDays: 17, now: '2026-10-08T20:45', rowHours: HOURS24 });
  eq(fx.hourly.time.length, 17 * 24, 'fixture has 408 hourly rows');
  const r = build(fx, 'Tokyo');
  eq(r.hours[0].h, '21:00', 'hours[0].h is the next Tokyo hour');
  eq(r.yest.t, valueAt(fx, 'temperature_2m', '2026-10-07T20:00'), 'yest.t = yesterday 20:00 (same hour as location now)');
  eq(r.yest.hum, valueAt(fx, 'relative_humidity_2m', '2026-10-07T20:00'), 'yest.hum = yesterday 20:00');
  eq(r.hx.length, 24, 'hx has 24 rows'); eq(r.hx[0].h, '00:00', 'hx starts at 00:00');
  eq(r.hours[0].night, true, 'I2: the 21:00 hours row is night:true');
  eq(app.iconFor({ cond: 'sun', night: true }), '🌙', 'I2: iconFor night + clear = moon');
  eq(app.iconFor({ cond: 'sun' }), app.ICON.sun, 'I2: iconFor day + clear = sun');
  eq(app.iconFor({ cond: 'rain', night: true }), app.ICON.rain, 'I2: iconFor night + rain keeps the rain icon');
  ok(/is_day/.test(extractFunction(script, 'fetchOpenMeteo')), 'I2: the hourly request asks for is_day');
  eq(r.daysFull[0].dt, '2026-10-08', 'daysFull[0] is the Tokyo today');
  eq(r.days[0].dt, '2026-10-08', 'days[0] is the Tokyo today');
  eq(r.grillRaw.length, 14, 'grillRaw has the 14 hours 09..22');
  ok(r.grillRaw.every(g => g.t === valueAt(fx, 'temperature_2m', '2026-10-08T' + g.hh)), 'every grillRaw row is from 2026-10-08 (temperature matches that date)');
  eq(r.days[0].p, Math.round(meanP(fx, '2026-10-08')), 'days[0].p = mean pressure of 2026-10-08 rows');
  eq(r.days[1].p, Math.round(meanP(fx, '2026-10-09')), 'days[1].p = mean pressure of 2026-10-09 rows');
  eq(r.bio.d[0].dt, '2026-10-08', 'bio.d starts today'); eq(r.bio.d.length, 7, 'bio.d has 7 days');
  eq(r.bio.h.length, 24, 'bio.h has 24 hours'); eq(r.bio.h[0].h, '21:00', 'bio.h starts at the next hour');
  eq(r.presH.length, 24, 'presH has the 72 h window in 3 h steps'); eq(r.presH[0].dt, '2026-10-07', 'presH starts yesterday');
  eq(r.presNowIdx, 15, 'presNowIdx = position of the 45th row (today 21:00)');
  eq(r.sun.rise, '06:30', 'sun.rise is today'); eq(r.sun.len, 630, 'sun.len in minutes');
  eq(r.gustMax, 26, 'gustMax is today (daily index of today)');
  eq(r.uv.max, 5, 'uv.max read');
  ok(r.rain15 && r.rain15[0].h === '20:45', 'rain15 starts with the slot containing now', JSON.stringify(r.rain15 && r.rain15[0]));
  eq(r.tz.off, 32400, 'tz.off from the response'); eq(r.tz.name, 'Asia/Tokyo', 'tz.name from the response');
  ok(!('today3' in r) && !('todayMeta' in r) && !('station' in r), 'dead keys today3/todayMeta/station are gone');
  eq(r.now.t, 18, 'now.t from current');
}

console.log('F2 DST fall-back, Europe/Zagreb (UTC+1), yesterday 2026-10-25 has 25 rows, now 2026-10-26T09:10');
{
  const fx = mkFixture({ off: 3600, tz: 'Europe/Zagreb', start: '2026-10-25', nDays: 17, now: '2026-10-26T09:10',
    rowHours: d => d === '2026-10-25' ? [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : HOURS24() });
  eq(rowsOf(fx, '2026-10-25').length, 25, 'fixture: 2026-10-25 has 25 rows (02:00 twice)');
  const r = build(fx, 'Zagreb');
  eq(r.hours[0].h, '10:00', 'hours[0].h = 10:00');
  eq(r.hx.length, 24, 'hx has 24 rows for 2026-10-26'); eq(r.hx[0].h, '00:00', 'hx starts 00:00'); eq(r.hx[23].h, '23:00', 'hx ends 23:00');
  eq(r.daysFull[0].dt, '2026-10-26', 'daysFull[0] = 2026-10-26');
  eq(r.yest.t, valueAt(fx, 'temperature_2m', '2026-10-25T09:00'), 'yest.t samples the 25-row day at 09:00');
  eq(r.yest.t, 9, 'yest.t is 9 (not the 08:00 value an index-24 shortcut would give)');
  eq(r.days[0].p, Math.round(meanP(fx, '2026-10-26')), 'days[0].p = mean over exactly the 24 rows of 2026-10-26');
  eq(rowsOf(fx, '2026-10-26').length, 24, 'fixture: 2026-10-26 has 24 rows');
  eq(r.bio.d[0].dt, '2026-10-26', 'bio.d starts today');
  eq(r.presNowIdx, 11, 'presNowIdx anchored on the string-based now index (row 35 -> position 11)');
  eq(r.presH[0].dt, '2026-10-25', 'presH starts at yesterday');
  ok(r.grillRaw.every(g => g.t === valueAt(fx, 'temperature_2m', '2026-10-26T' + g.hh)), 'grillRaw rows are all 2026-10-26');
  /* bioD pressure delta uses exact date windows (25-row yesterday vs 24-row today) */
  const hum13 = valueAt(fx, 'relative_humidity_2m', '2026-10-26T13:00'); ok(hum13 === 66, 'fixture 13:00 humidity is 66');
}

console.log('F3 DST fall-back, today IS the 25-row day (now 2026-10-25T09:10)');
{
  const fx = mkFixture({ off: 3600, tz: 'Europe/Zagreb', start: '2026-10-24', nDays: 17, now: '2026-10-25T09:10',
    rowHours: d => d === '2026-10-25' ? [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : HOURS24() });
  const r = build(fx, 'Zagreb');
  eq(r.hx.length, 25, 'hx has all 25 rows of the long day');
  eq(r.hours[0].h, '10:00', 'hours[0].h = 10:00');
  eq(r.daysFull[0].dt, '2026-10-25', 'daysFull[0] = 2026-10-25');
  eq(r.yest.t, valueAt(fx, 'temperature_2m', '2026-10-24T09:00'), 'yest.t = 2026-10-24 09:00');
  eq(r.days[0].p, Math.round(meanP(fx, '2026-10-25')), 'days[0].p = mean over the 25 rows');
}

console.log('F4 DST spring-forward, today is the 23-row day (now 2026-03-29T09:10)');
{
  const fx = mkFixture({ off: 7200, tz: 'Europe/Zagreb', start: '2026-03-28', nDays: 17, now: '2026-03-29T09:10',
    rowHours: d => d === '2026-03-29' ? [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : HOURS24() });
  eq(rowsOf(fx, '2026-03-29').length, 23, 'fixture: 2026-03-29 has 23 rows');
  const r = build(fx, 'Zagreb');
  eq(r.hx.length, 23, 'hx has 23 rows'); eq(r.daysFull[0].dt, '2026-03-29', 'daysFull[0] = 2026-03-29');
  eq(r.hours[0].h, '10:00', 'hours[0].h = 10:00');
  eq(r.days[0].p, Math.round(meanP(fx, '2026-03-29')), 'days[0].p = mean over the 23 rows');
  eq(r.yest.t, valueAt(fx, 'temperature_2m', '2026-03-28T09:00'), 'yest.t = 2026-03-28 09:00');
}

console.log('location clock (locNow / locNowStr / todayIso)');
{
  const indep = off => new Date(Date.now() + off * 1000).toISOString().slice(0, 16);
  function sameMinute(off, f) { /* retry across a minute rollover */
    for (let k = 0; k < 3; k++) { const a = indep(off), v = f(), b = indep(off); if (a === b) return [v, a]; }
    return [f(), indep(off)];
  }
  const savedTz = app.getTz();
  eq(savedTz.off, null, 'LOCTZ.off is null before any forecast');
  { const [v, a] = sameMinute(-new Date().getTimezoneOffset() * 60, () => app.locNowStr()); eq(v, a, 'LOCTZ.off=null -> locNowStr() is the browser wall-clock'); }
  app.setLocTz({ off: 32400, name: 'Asia/Tokyo' });
  eq(app.getTz().name, 'Asia/Tokyo', 'setLocTz stores the name');
  { const [v, a] = sameMinute(32400, () => app.locNowStr()); eq(v, a, 'Tokyo: locNowStr() = UTC+9 wall-clock'); }
  { const [v, a] = sameMinute(32400, () => app.todayIso()); eq(v, a.slice(0, 10), 'Tokyo: todayIso() = Tokyo date'); }
  { const [v, a] = sameMinute(32400, () => { const d = app.locNow(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }); eq(v, a.slice(11, 16), 'Tokyo: locNow().getHours()/getMinutes() = Tokyo clock'); }
  { const [v, a] = sameMinute(32400, () => app.sameDayISO(0)); eq(v, a.slice(0, 10), 'Tokyo: sameDayISO(0) = Tokyo date'); }
  app.setLocTz({ off: -4 * 3600, name: 'America/New_York' });
  { const [v, a] = sameMinute(-4 * 3600, () => app.locNowStr()); eq(v, a, 'UTC-4: locNowStr() = UTC-4 wall-clock'); }
  { const [v, a] = sameMinute(3600, () => app.locNowStrAt(3600)); eq(v, a, 'locNowStrAt(off) works for an explicit offset'); }
  app.setLocTz({ off: 'x' }); eq(app.getTz().off, null, 'setLocTz resets on garbage (browser time, never a stale location)');
  app.setLocTz(undefined); eq(app.getTz().off, null, 'setLocTz(undefined) resets to browser time');
}

console.log('wd_last snapshot (version tag + tz round trip)');
{
  const fx = mkFixture({ off: 32400, tz: 'Asia/Tokyo', start: '2026-10-07', nDays: 17, now: '2026-10-08T20:45', rowHours: HOURS24 });
  const d = build(fx, 'Tokyo'); const key = '7|tokyo';
  app.saveLast(key, 'Tokyo', d);
  const o = app.readWdLast('Tokyo', key);
  ok(o && o.v === app.APPV, 'snapshot is tagged with APPV and read back');
  ok(o && o.D.tz && o.D.tz.off === 32400 && o.D.tz.name === 'Asia/Tokyo', 'snapshot carries tz {off,name}');
  const raw = JSON.parse(fakeLS._m.wd_last);
  raw.v = '0.00'; fakeLS._m.wd_last = JSON.stringify(raw);
  eq(app.readWdLast('Tokyo', key), null, 'snapshot with a different version is ignored');
  delete raw.v; fakeLS._m.wd_last = JSON.stringify(raw);
  eq(app.readWdLast('Tokyo', key), null, 'snapshot with no version is ignored');
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
