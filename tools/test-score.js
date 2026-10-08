#!/usr/bin/env node
/* J1 activity-engine test for weather-dashboard.html. Dependency-free, node >= 18.
 *
 *   node tools/test-score.js
 *
 * Pulls ACTS / scoreHour / scoreDay / scoreDays / actTier / grillCompound / hrPack / hrRow ... out of the app
 * <script> BY NAME (same brace-matching extractor as tools/test-time.js), stubs the location clock
 * (todayIso / nowMin), and runs synthetic hourly fixtures through the engine.
 * Prints "SCORE TESTS OK" and exits 0, or exits 1 on any failure. */
'use strict';
const fs = require('fs');
const path = require('path');
const HTML = path.join(__dirname, '..', 'weather-dashboard.html');

/* ======================================================================= source extractor (same as test-time.js) */
function skipLiteral(s, i) { const q = s[i]; i++; while (i < s.length) { const c = s[i]; if (c === '\\') { i += 2; continue; } if (c === q) return i + 1; i++; } throw new Error('unterminated literal'); }
function skipTrivia(s, i) {
  if (s[i] === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); return e < 0 ? s.length : e; }
  if (s[i] === '/' && s[i + 1] === '*') { return s.indexOf('*/', i) + 2; }
  return i;
}
function matchClose(s, i) {
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
function extractConst(src, name) {
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

const CONSTS = ['APPV', 'WD_LAST_KEY', 'GRILLALL', 'WMO', 'ACTS', 'ACTICON', 'HRCOLS'];
const FUNCS = ['timePenalty', 'grillCompound', 'bbqTier', 'actTier', 'scoreHour', 'scoreDay', 'scoreDays', 'hrPack', 'hrRow', 'saveLast', 'readWdLast'];
const parts = ['let _today="2026-10-08",_now=12*60;', 'function todayIso(){return _today;}', 'function nowMin(){return _now;}'];
CONSTS.forEach(n => parts.push(extractConst(script, n)));
FUNCS.forEach(n => parts.push(extractFunction(script, n)));
parts.push('return {ACTS, ACTICON, actTier, scoreHour, scoreDay, scoreDays, grillCompound, GRILLALL, bbqTier, hrPack, hrRow, saveLast, readWdLast, APPV, setClock(t,m){_today=t;_now=m;}};');
const fakeLS = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; })();
const E = new Function('localStorage', parts.join('\n'))(fakeLS);

/* ======================================================================= assertions */
let fails = 0, passes = 0;
function ok(cond, msg, detail) {
  if (cond) { passes++; console.log('  ok   ' + msg); }
  else { fails++; console.log('  FAIL ' + msg + (detail !== undefined ? '   -> ' + detail : '')); }
}
function eq(a, b, msg) { ok(a === b, msg, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }
const pad = n => String(n).padStart(2, '0');
const ACT_LIST = ['bbq', 'hike', 'bike', 'run', 'sea'];
const WHY_KEYS = ['rain', 'hot', 'cold', 'wind', 'storm', 'night', 'fog', 'uv', 'waves', 'coldsea', 'humid', 'time'];

/* ======================================================================= fixtures */
const DATES = ['2026-10-08', '2026-10-09', '2026-10-10'];
/* a calm, mild hour; `over` overrides any field */
function mkRow(date, hi, over) {
  const r = { ts: date + 'T' + pad(hi) + ':00', dt: date, h: pad(hi) + ':00', hi: hi, t: 20, fl: 20, pp: 0, mm: 0, w: 8, g: 15, rh: 50, uv: 3, p: 1015,
    code: 0, cond: 'sun', night: hi < 6 || hi >= 19, vis: 20000, frz: 3000, snow: 0, cl: 5, cm: 5, ch: 5 };
  return Object.assign(r, over || {});
}
/* 3 days x 24 rows; mod(date,hi) may return field overrides */
function mkD(mod, withSea) {
  const hr = [], hrDay = {};
  DATES.forEach(date => {
    const s = hr.length;
    for (let hi = 0; hi < 24; hi++) hr.push(mkRow(date, hi, mod ? mod(date, hi) : null));
    hrDay[date] = [s, hr.length];
  });
  const d = { hr: hr, hrDay: hrDay, hrNow: 0 };
  if (withSea !== false) d.sea = { cur: 24, wave: 20, swell: 10, swellT: 5, current: 0.5, days: DATES.map(x => ({ dt: x, t: 24 })), tide: [] };
  return d;
}
const calm = mkD(null, true), calmInland = mkD(null, false);
E.setClock('2026-10-08', 12 * 60);

/* ======================================================================= tests */
console.log('registry + tiers');
{
  eq(JSON.stringify(Object.keys(E.ACTS)), JSON.stringify(ACT_LIST), 'ACTS has bbq/hike/bike/run/sea');
  eq(JSON.stringify(E.ACTS.bbq.win), '[9,22]', 'bbq window 9-22'); eq(JSON.stringify(E.ACTS.hike.win), '[6,20]', 'hike window 6-20');
  eq(JSON.stringify(E.ACTS.bike.win), '[6,21]', 'bike window 6-21'); eq(JSON.stringify(E.ACTS.run.win), '[5,22]', 'run window 5-22');
  eq(JSON.stringify(E.ACTS.sea.win), '[8,20]', 'sea window 8-20');
  eq(E.actTier(100), 0, 'actTier 100 -> 0 (great)'); eq(E.actTier(80), 0, 'actTier 80 -> 0'); eq(E.actTier(79), 1, 'actTier 79 -> 1 (good)');
  eq(E.actTier(60), 1, 'actTier 60 -> 1'); eq(E.actTier(59), 2, 'actTier 59 -> 2 (okay)'); eq(E.actTier(40), 2, 'actTier 40 -> 2');
  eq(E.actTier(39), 3, 'actTier 39 -> 3 (poor)'); eq(E.actTier(1), 3, 'actTier 1 -> 3');
  ACT_LIST.forEach(a => ok(typeof E.ACTICON[a] === 'string' && E.ACTICON[a].length > 0, 'ACTICON has an icon for ' + a));
}

console.log('scoreHour: bbq is the unchanged grillCompound');
{
  const cases = [{ hi: 14, t: 20, pp: 0, w: 5, rh: 50, cond: 'sun' }, { hi: 10, t: 31, pp: 30, w: 28, rh: 85, cond: 'cloud' }, { hi: 15, t: 8, pp: 60, w: 12, rh: 60, cond: 'storm' }];
  cases.forEach(o => {
    const r = mkRow('2026-10-08', o.hi, { t: o.t, pp: o.pp, w: o.w, rh: o.rh, cond: o.cond });
    const g = E.grillCompound({ h: o.hi, t: o.t, pp: o.pp, wind: o.w, rh: o.rh, cond: o.cond }, E.GRILLALL);
    eq(E.scoreHour('bbq', r, calm).v, g.v, 'bbq hour ' + o.hi + ':00 t=' + o.t + ' equals grillCompound (' + g.v + ')');
  });
  const hot = E.scoreHour('bbq', mkRow('2026-10-08', 14, { t: 33 }), calm), cold = E.scoreHour('bbq', mkRow('2026-10-08', 14, { t: 8 }), calm);
  ok(hot.parts.hot > 0 && !('cold' in hot.parts), 'bbq t>22 maps temp -> hot'); ok(cold.parts.cold > 0 && !('hot' in cold.parts), 'bbq t<22 maps temp -> cold');
  ok(E.scoreHour('bbq', mkRow('2026-10-08', 22, {}), calm).parts.time > 0, 'bbq late hour has a time part');
  ok(E.scoreHour('bbq', mkRow('2026-10-08', 14, { rh: 90, t: 27 }), calm).parts.humid > 0, 'bbq muggy hour has a humid part');
}

console.log('scoreHour: rain lowers every activity monotonically');
ACT_LIST.forEach(a => {
  const vs = [0, 50, 100].map(pp => E.scoreHour(a, mkRow('2026-10-08', 14, { pp: pp }), calm).v);
  ok(vs[0] > vs[1] && vs[1] > vs[2], a + ' pp 0 > 50 > 100', vs.join(' > '));
  ok(vs.every(v => v >= 1 && v <= 100 && Number.isInteger(v)), a + ' scores are integers in 1..100', vs.join(','));
  ok(E.scoreHour(a, mkRow('2026-10-08', 14, { pp: 80 }), calm).parts.rain > 0, a + ' pp 80 has a rain part');
});

console.log('scoreHour: caps');
{
  const cap = { bbq: 15, hike: 20, bike: 15, run: 15, sea: 10 };
  ACT_LIST.forEach(a => {
    const s = E.scoreHour(a, mkRow('2026-10-08', 14, { cond: 'storm', code: 95 }), calm);
    ok(s.v <= cap[a], a + ' storm caps at ' + cap[a], s.v); ok(s.parts.storm > 0, a + ' storm records the storm reason');
  });
  eq(E.scoreHour('hike', mkRow('2026-10-08', 14, {}), calm).v, 100, 'hike calm midday = 100');
  const nightCap = { hike: 30, bike: 30, run: 60, sea: 10 };
  Object.keys(nightCap).forEach(a => {
    const s = E.scoreHour(a, mkRow('2026-10-08', 14, { night: true }), calm);
    ok(s.v <= nightCap[a], a + ' night caps at ' + nightCap[a], s.v); ok(s.parts.night > 0, a + ' night records the night reason');
    ok(E.scoreHour(a, mkRow('2026-10-08', 14, {}), calm).v > nightCap[a], a + ' same hour by day is above the night cap');
  });
  const coldSea = mkD(null, true); coldSea.sea.cur = 16; coldSea.sea.days = [];
  const cs = E.scoreHour('sea', mkRow('2026-10-08', 14, {}), coldSea);
  ok(cs.v <= 30, 'cold sea (16 C) caps sea at 30', cs.v); ok(cs.parts.coldsea > 0, 'cold sea records coldsea');
  const coolSea = mkD(null, true); coolSea.sea.days = DATES.map(x => ({ dt: x, t: 19.5 }));
  const cl = E.scoreHour('sea', mkRow('2026-10-08', 14, {}), coolSea);
  ok(cl.v > 30 && cl.v < E.scoreHour('sea', mkRow('2026-10-08', 14, {}), calm).v && cl.parts.coldsea === 20, 'sea 19.5 C is -20 (coldsea), not capped', cl.v);
  const mix = mkD(null, true); mix.sea.cur = 16; mix.sea.days = [{ dt: '2026-10-08', t: 25 }];
  ok(E.scoreHour('sea', mkRow('2026-10-08', 14, {}), mix).v > 30, 'sea days[] entry for the row date wins over sea.cur');
  const waves = mkD(null, true); waves.sea.wave = 90;
  eq(E.scoreHour('sea', mkRow('2026-10-08', 14, {}), waves).parts.waves, 25, 'waves > 80 cm: -25');
  waves.sea.wave = 60; eq(E.scoreHour('sea', mkRow('2026-10-08', 14, {}), waves).parts.waves, 10, 'waves > 50 cm: -10');
  ok(E.scoreHour('sea', mkRow('2026-10-08', 14, { t: 15 }), calm).v <= 20, 'sea air < 18 C caps at 20');
  eq(E.scoreHour('sea', mkRow('2026-10-08', 14, { uv: 9 }), calm).v, E.scoreHour('sea', mkRow('2026-10-08', 14, {}), calm).v, 'sea strong UV is note-only (no points taken)');
  ok('uv' in E.scoreHour('sea', mkRow('2026-10-08', 14, { uv: 9 }), calm).parts, 'sea strong UV records the uv key');
}

console.log('scoreHour: hike / bike / run specifics');
{
  const sc = (a, o) => E.scoreHour(a, mkRow('2026-10-08', 14, o), calm);
  ok(sc('hike', { fl: 35 }).parts.hot > 0 && sc('hike', { fl: -5 }).parts.cold > 0, 'hike hot/cold keys by feels-like');
  ok(sc('hike', { g: 70 }).parts.wind > 0 && sc('hike', { g: 70 }).v < 100, 'hike strong gusts take points and record wind');
  ok(sc('hike', { vis: 800 }).parts.fog === 20 && sc('hike', { vis: 800 }).v === 80, 'hike fog (vis < 2000 m) = -20');
  eq(sc('hike', { uv: 9 }).parts.uv, 5, 'hike uv >= 8 = -5');
  ok(sc('bike', { w: 40 }).parts.wind > 0 && sc('bike', { w: 40 }).v === 76, 'bike wind 40 = -24 (1.2 per km/h over 20)');
  ok(sc('run', { fl: 10 }).v === 100 && sc('run', { fl: 22 }).v === 88, 'run ideal 4-18 feels-like, -3 per degree above');
  eq(sc('run', { uv: 9 }).parts.uv, 10, 'run uv >= 8 = -10');
  eq(sc('hike', { fl: null, g: null, vis: null, uv: null }).v, 100, 'hike with null fields scores 100 (nulls are skipped)');
}

console.log('inland sea');
{
  eq(E.scoreHour('sea', mkRow('2026-10-08', 14, {}), calmInland), null, 'scoreHour(sea) is null inland');
  eq(E.scoreDay('sea', DATES[0], calmInland), null, 'scoreDay(sea) is null inland');
  eq(E.scoreDays('sea', calmInland, 5).length, 0, 'scoreDays(sea) is empty inland');
  ok(E.scoreDay('hike', DATES[0], calmInland) !== null, 'other activities still score inland');
  eq(E.scoreDay('sea', DATES[0], { hr: calm.hr, hrDay: calm.hrDay, sea: null }), null, 'scoreDay(sea) with sea:null is null');
}

console.log('scoreDay: shape + best 3-hour window');
{
  /* afternoon is best, mornings/evenings are rainy, so the best window is not at the edge */
  const d = mkD((date, hi) => (hi < 11 || hi > 16) ? { pp: 70 } : null, true);
  E.setClock('2026-10-07', 12 * 60); /* neither fixture day is "today" -> no past-window filtering */
  ACT_LIST.forEach(a => {
    const s = E.scoreDay(a, DATES[1], d);
    ok(s && s.act === a && s.date === DATES[1], a + ' scoreDay shape (act/date)');
    if (!s) return;
    const f = parseInt(s.best.from, 10), t = parseInt(s.best.to, 10), w = E.ACTS[a].win;
    eq(t - f, 3, a + ' best window is 3 hours long (' + s.best.from + '-' + s.best.to + ')');
    ok(f >= w[0] && t <= w[1], a + ' best window sits inside the activity window ' + w.join('-'), s.best.from + '-' + s.best.to);
    ok(f >= 11 && t <= 17, a + ' best window is the dry afternoon', s.best.from + '-' + s.best.to);
    const inside = s.hours.filter(x => x.hi >= f && x.hi < t);
    eq(inside.length, 3, a + ' hours[] holds the 3 window hours');
    eq(Math.round(inside.reduce((x, y) => x + y.v, 0) / 3), s.v, a + ' v = mean of the best window hours');
    eq(s.best.v, s.v, a + ' best.v = v'); eq(s.tier, E.actTier(s.v), a + ' tier = actTier(v)');
    ok(s.hours.every(x => x.hi >= w[0] && x.hi < w[1] && typeof x.h === 'string'), a + ' hours[] stay inside the window');
    eq(s.over, false, a + ' over is false off-today');
    let best = -1; for (let k = 0; k + 3 <= s.hours.length; k++) best = Math.max(best, (s.hours[k].v + s.hours[k + 1].v + s.hours[k + 2].v) / 3);
    eq(Math.round(best), s.v, a + ' nothing beats the reported window');
  });
  eq(E.scoreDay('hike', '2030-01-01', d), null, 'scoreDay for a date with no rows is null');
  eq(E.scoreDay('nope', DATES[1], d), null, 'unknown activity is null');
  eq(E.scoreDay('hike', DATES[1], { hr: [], hrDay: {} }), null, 'no hourly rows -> null');
  eq(E.scoreDay('hike', DATES[1], {}), null, 'no D.hr at all (old snapshot) -> null');
  /* short days: only one / two in-window rows */
  const short = { hr: [mkRow(DATES[1], 20, {})], hrDay: {} }; short.hrDay[DATES[1]] = [0, 1];
  const ss = E.scoreDay('bike', DATES[1], short);
  ok(ss && ss.best.from === '20:00' && ss.best.to === '21:00' && ss.hours.length === 1, 'one in-window row -> a 1-hour window 20:00-21:00', JSON.stringify(ss && ss.best));
  const two = { hr: [mkRow(DATES[1], 19, {}), mkRow(DATES[1], 20, {})], hrDay: {} }; two.hrDay[DATES[1]] = [0, 2];
  const s2 = E.scoreDay('bike', DATES[1], two);
  ok(s2 && s2.best.from === '19:00' && s2.best.to === '21:00', 'two in-window rows -> a 2-hour window', JSON.stringify(s2 && s2.best));
}

console.log('scoreDay: today excludes windows that already ended');
{
  /* best window in the morning (dry until 11:00), wet from 11:00 on */
  const d = mkD((date, hi) => hi >= 11 ? { pp: 80 } : null, true);
  E.setClock(DATES[0], 12 * 60 + 30);
  const tomorrow = E.scoreDay('bike', DATES[1], d);
  eq(tomorrow.best.from, '06:00', 'tomorrow: the morning window is the best (06:00)');
  const live = E.scoreDay('bike', DATES[0], d);
  ok(parseInt(live.best.to, 10) * 60 >= 12 * 60 + 30, 'today at 12:30: best window ends at or after now', live.best.from + '-' + live.best.to);
  eq(live.over, false, 'today at 12:30 is not over');
  ok(live.v < tomorrow.v, 'today at 12:30 scores lower than the same day tomorrow (dry morning has gone)', live.v + ' vs ' + tomorrow.v);
  E.setClock(DATES[0], 23 * 60);
  const done = E.scoreDay('bike', DATES[0], d);
  eq(done.over, true, 'today at 23:00: over is true');
  eq(done.best.from, '06:00', 'over day still reports the best (past) window'); eq(done.v, tomorrow.v, 'over day reports that past window score');
  eq(E.scoreDay('bike', DATES[1], d).over, false, 'tomorrow is never over');
  /* opts override the clock (second location in another time zone) */
  const o1 = E.scoreDay('bike', DATES[0], d, { today: DATES[0], nowMin: 7 * 60 });
  eq(o1.over, false, 'opts.nowMin = 07:00 -> not over'); eq(o1.best.from, '06:00', 'opts.nowMin = 07:00 keeps the 06:00-09:00 window');
  const o2 = E.scoreDay('bike', DATES[0], d, { today: DATES[1], nowMin: 23 * 60 });
  eq(o2.over, false, 'opts.today elsewhere -> the date is not treated as today');
  E.setClock(DATES[0], 12 * 60);
}

console.log('scoreDay: reasons');
{
  E.setClock('2026-10-07', 12 * 60);
  const rainy = mkD((date, hi) => date === DATES[1] ? { pp: 90, mm: 1.2, code: 63, cond: 'rain' } : null, true);
  ACT_LIST.forEach(a => {
    const s = E.scoreDay(a, DATES[1], rainy);
    ok(s.reasons.indexOf('rain') >= 0, a + ' rainy best window lists rain', s.reasons.join(','));
    ok(s.reasons.length <= 2, a + ' at most two reasons', s.reasons.length);
    ok(s.reasons.every(k => WHY_KEYS.indexOf(k) >= 0), a + ' reasons are known actWhy keys', s.reasons.join(','));
  });
  eq(E.scoreDay('hike', DATES[0], rainy).reasons.length, 0, 'a clean day has no reasons');
  const stormy = mkD((date, hi) => date === DATES[1] ? { cond: 'storm', code: 95 } : null, true);
  eq(E.scoreDay('hike', DATES[1], stormy).reasons[0], 'storm', 'a stormy day lists storm first');
  const hotD = mkD(() => ({ t: 36, fl: 38 }), true);
  ok(E.scoreDay('hike', DATES[0], hotD).reasons.indexOf('hot') >= 0, 'a very hot day lists hot (hike)');
  ok(E.scoreDay('bbq', DATES[0], hotD).reasons.indexOf('hot') >= 0, 'a very hot day lists hot (bbq)');
}

console.log('scoreDays');
{
  E.setClock(DATES[0], 12 * 60);
  eq(E.scoreDays('hike', calm, 16).length, 3, 'scoreDays = number of days with rows (3, today first)');
  eq(E.scoreDays('hike', calm, 2).length, 2, 'scoreDays honours n');
  eq(E.scoreDays('hike', calm, 16)[0].date, DATES[0], 'scoreDays starts at today');
  E.setClock(DATES[1], 12 * 60);
  eq(E.scoreDays('hike', calm, 16).length, 2, 'scoreDays skips days before today');
  E.setClock(DATES[0], 12 * 60);
  const gap = mkD(null, true); gap.hrDay[DATES[1]] = [gap.hrDay[DATES[1]][0], gap.hrDay[DATES[1]][0]];
  eq(E.scoreDays('bbq', gap, 16).length, 2, 'a day with no rows is skipped');
  eq(E.scoreDays('bbq', {}, 5).length, 0, 'no hr -> empty array');
  eq(E.scoreDays('sea', calm, 16).length, 3, 'sea scores every day when coastal');
}

console.log('compact hr form (wd_last)');
{
  const d = mkD((date, hi) => hi === 3 ? { g: null, vis: null, uv: null, snow: null, mm: null, p: null } : (hi === 5 ? { night: true, code: 95, cond: 'storm', t: -2.5 } : null), true);
  const c = E.hrPack(d.hr);
  eq(c.ts.length, d.hr.length, 'hrPack: one entry per row');
  let same = true, firstBad = -1;
  for (let i = 0; i < d.hr.length; i++) { if (JSON.stringify(E.hrRow({ hrc: c }, i)) !== JSON.stringify(d.hr[i])) { same = false; firstBad = i; break; } }
  ok(same, 'hrRow(d,i) round-trips every row exactly (incl. nulls, night, cond)', 'row ' + firstBad);
  ok(JSON.stringify(c).length * 2 < JSON.stringify(d.hr).length, 'columnar form is less than half the size of the row objects', JSON.stringify(c).length + ' vs ' + JSON.stringify(d.hr).length);
  eq(E.hrPack([]), null, 'hrPack of nothing is null');
  /* saveLast -> readWdLast */
  const full = Object.assign({ mode: 'direct', loc: 'X', tz: { off: 3600, name: 'Europe/Zagreb' } }, d);
  E.saveLast('7|x', 'X', full);
  const raw = JSON.parse(fakeLS._m.wd_last);
  ok(raw.D.hrc && !raw.D.hr, 'saved snapshot holds hrc (columnar) and no hr');
  const o = E.readWdLast('X', '7|x');
  ok(o && Array.isArray(o.D.hr) && !o.D.hrc, 'readWdLast restores D.hr as row objects');
  eq(JSON.stringify(o && o.D.hr), JSON.stringify(d.hr), 'restored D.hr equals the original rows');
  eq(JSON.stringify(o && o.D.hrDay), JSON.stringify(d.hrDay), 'hrDay survives the snapshot');
  ok(full.hr && !full.hrc, 'saveLast does not mutate the live D (still has hr, no hrc)');
  E.setClock('2026-10-07', 12 * 60);
  eq(JSON.stringify(E.scoreDay('hike', DATES[1], o.D)), JSON.stringify(E.scoreDay('hike', DATES[1], d)), 'a restored snapshot scores identically');
}

console.log(passes + ' passed, ' + fails + ' failed');
if (fails) { console.log('SCORE TESTS FAILED'); process.exit(1); }
console.log('SCORE TESTS OK');
