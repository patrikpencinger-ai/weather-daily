/*
 * Patrik's weather daily - Cloudflare Worker (ES module).
 *
 * Serves the static site exactly as before (every non-/api/ request goes to env.ASSETS) and adds
 * three same-origin routes that front the "Ask about the weather" assistant:
 *
 *   GET  /api/ask/state   quota + availability for the current visitor (JSON, no-store)
 *   POST /api/ask         one question -> text/event-stream (meta, [tool, toolres]*, delta*, done | error);
 *                         the model may call get_forecast (geocode + Open-Meteo, max 2 tool rounds) for another place
 *   GET  /api/owner?t=... owner mode (cookie), then 302 to the Info view (max OWNER_ATTEMPTS per IP per day)
 *
 * Secrets (never in files): ANTHROPIC_API_KEY, OWNER_TOKEN - set with `wrangler secret put`.
 * Plain vars (wrangler.toml [vars]): ASK_MODEL, ASK_DAILY, ASK_DAILY_IP, ASK_DAILY_GLOBAL.
 * Optional test hooks: ASK_TIMEOUT_MS (whole-request budget, default 50000), ASK_LOOKUP_TIMEOUT_MS
 * (each place-lookup fetch, default 8000).
 * Quotas live in the `Quota` Durable Object (one object per key, KV-style storage API).
 *
 * Nothing here logs the question, the forecast context or any header value.
 */

const RULES =
  "You are the assistant of Patrik's weather daily. Answer ONLY from the DATA JSON. " +
  'If the answer is not in the data, say so. Answer in the language of the question ' +
  '(Croatian or English), briefly (at most ~6 sentences or a short list), with concrete ' +
  'times (location local time, 24 h clock) and numbers with units (°C, mm, km/h). ' +
  'Never invent data beyond the days in DATA. ' +
  'When the question concerns a place other than DATA.place, call get_forecast for it and answer from the tool result; say which place you answered for.';

const MAX_BODY_BYTES = 60000; // raw request body
const MAX_Q_CHARS = 500;
const MAX_CTX_CHARS = 40000; // serialized forecast context
const MAX_PLACE_CHARS = 120;
const COOKIE_MAX_AGE = 31536000;
const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';
const OWNER_REDIRECT = '/weather-dashboard.html#info';
const OWNER_ATTEMPTS = 10; // /api/owner attempts per client IP per Zagreb day

/* ---------- small helpers ---------- */

function intVar(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Europe/Zagreb calendar date, YYYY-MM-DD (the quota "day").
function zagrebDate(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zagreb',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d || new Date());
}

// The Zagreb date after `date` (when the quota resets).
function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function toHex(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}

async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

// Constant-time string compare (length difference is folded into the result, not an early exit).
function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function randomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(name, value) {
  return name + '=' + value + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + COOKIE_MAX_AGE;
}

// Origin (or, without it, Referer) host must belong to the site (or be a local dev host).
function originOk(request) {
  const o = request.headers.get('origin');
  const src = o !== null ? o : request.headers.get('referer');
  if (!src) return false;
  let u;
  try {
    u = new URL(src);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'weath.er45.com' || h.endsWith('.er45.com') || h === 'localhost' || h === '127.0.0.1';
}

// Read at most `max` bytes of the body and parse JSON. -> {body} | {status:400|413}
async function parseBody(request, max) {
  max = max || MAX_BODY_BYTES;
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > max) return { status: 413 };
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch (e) {
      return { status: 400 };
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch (e) {}
      return { status: 413 };
    }
    chunks.push(r.value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch (e) {
    return { status: 400 };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400 };
  return { body };
}

// -> {q, lang, ctx, ctxStr, place} | {status}
function validateAsk(b) {
  if (typeof b.q !== 'string') return { status: 400 };
  const q = b.q.trim();
  if (!q || q.length > MAX_Q_CHARS) return { status: 400 };
  if (b.lang !== 'hr' && b.lang !== 'en') return { status: 400 };
  if (!b.ctx || typeof b.ctx !== 'object' || Array.isArray(b.ctx)) return { status: 400 };
  if (b.place !== undefined && typeof b.place !== 'string') return { status: 400 };
  const ctxStr = JSON.stringify(b.ctx);
  if (ctxStr.length > MAX_CTX_CHARS) return { status: 413 };
  return { q, lang: b.lang, ctx: b.ctx, ctxStr, place: (b.place || '').slice(0, MAX_PLACE_CHARS) };
}

// SSE writer over a WritableStreamDefaultWriter: write(event, data) -> Promise.
function sse(writer) {
  const enc = new TextEncoder();
  return (event, data) => writer.write(enc.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
}

/* ---------- identity and quota ---------- */

async function identify(request, env) {
  const cookies = parseCookies(request.headers.get('cookie'));
  let vid = cookies.wd_vid;
  let setVid = false;
  if (!vid || !/^[0-9a-f]{32}$/.test(vid)) {
    vid = randomId();
    setVid = true;
  }
  let owner = false;
  const tok = env.OWNER_TOKEN;
  if (tok && cookies.wd_owner) owner = timingSafeEqual(cookies.wd_owner, await hmacHex(tok, tok));
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipKey = 'ip:' + (await hmacHex('wd-ip', ip)).slice(0, 32);
  return { vid, setVid, owner, keys: { vid: 'vid:' + vid, ip: ipKey, global: 'global' } };
}

async function quotaCall(env, key, method, path, params) {
  const stub = env.QUOTA.get(env.QUOTA.idFromName(key));
  const res = await stub.fetch('https://quota' + path + '?' + new URLSearchParams(params).toString(), { method });
  return res.json();
}

function limitsOf(env) {
  return {
    vid: intVar(env.ASK_DAILY, 10),
    ip: intVar(env.ASK_DAILY_IP, 40),
    global: intVar(env.ASK_DAILY_GLOBAL, 400),
  };
}

// Give back the three quota hits of a request that failed before any SSE was sent (best-effort).
function refundHits(env, ctx, id, date) {
  const p = Promise.all(
    ['vid', 'ip', 'global'].map((k) => quotaCall(env, id.keys[k], 'POST', '/refund', { date }).catch(() => null))
  );
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

/* ---------- responses ---------- */

function jsonRes(obj, status, id, extra) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (extra) for (const k in extra) h.set(k, extra[k]);
  if (id && id.setVid) h.append('set-cookie', cookieHeader('wd_vid', id.vid));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

/* ---------- Anthropic relay ---------- */

// Reads Anthropic's SSE body, forwards text deltas through write('delta', {t}) and collects the
// content blocks of the response (text and tool_use) so a tool round can be replayed upstream.
// -> {ok:true, usage:{in,out,cached}, stop, content:[...]} | {ok:false, code, message}.
// `content` holds {type:'text',text} and {type:'tool_use',id,name,input} blocks in order; a tool_use
// whose arguments did not parse as JSON has `bad:true` and input {}. Throws on read/write failure.
async function relayAnthropic(res, write) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const usage = { in: 0, out: 0, cached: 0 };
  const blocks = new Map(); // content block index -> {type, text, id, name, json, input, bad}
  let buf = '';
  let stopped = false;
  let stop = null;
  let failure = null;

  function blockAt(i, type) {
    if (!blocks.has(i)) blocks.set(i, { type: type || 'text', text: '', id: '', name: '', json: '', input: null, bad: false });
    return blocks.get(i);
  }

  async function line(raw) {
    if (!raw.startsWith('data:')) return;
    const payload = raw.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch (e) {
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      if (cb.type === 'tool_use') {
        const b = blockAt(ev.index, 'tool_use');
        b.id = String(cb.id || '');
        b.name = String(cb.name || '');
      } else {
        blockAt(ev.index, 'text');
      }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        blockAt(ev.index, 'text').text += d.text;
        await write('delta', { t: d.text });
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        blockAt(ev.index, 'tool_use').json += d.partial_json;
      }
    } else if (ev.type === 'content_block_stop') {
      const b = blocks.get(ev.index);
      if (b && b.type === 'tool_use') {
        try {
          const v = b.json.trim() ? JSON.parse(b.json) : {};
          if (v && typeof v === 'object' && !Array.isArray(v)) b.input = v;
          else b.bad = true;
        } catch (e) {
          b.bad = true;
        }
        if (!b.input) b.input = {};
      }
    } else if (ev.type === 'message_start') {
      const u = (ev.message && ev.message.usage) || {};
      usage.in = u.input_tokens || 0;
      usage.out = u.output_tokens || 0;
      usage.cached = u.cache_read_input_tokens || 0;
    } else if (ev.type === 'message_delta') {
      const u = ev.usage || {};
      if (typeof u.output_tokens === 'number') usage.out = u.output_tokens;
      if (typeof u.input_tokens === 'number') usage.in = u.input_tokens;
      if (typeof u.cache_read_input_tokens === 'number') usage.cached = u.cache_read_input_tokens;
      if (ev.delta && typeof ev.delta.stop_reason === 'string') stop = ev.delta.stop_reason;
    } else if (ev.type === 'message_stop') {
      stopped = true;
    } else if (ev.type === 'error') {
      const e = ev.error || {};
      failure = {
        ok: false,
        code: String(e.type || 'upstream_error').slice(0, 60),
        message: String(e.message || 'Upstream error').slice(0, 200),
      };
    }
  }

  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      await line(raw);
      if (failure) {
        try {
          await reader.cancel();
        } catch (e) {}
        return failure;
      }
    }
  }
  buf += dec.decode();
  if (buf) await line(buf.replace(/\r$/, ''));
  if (failure) return failure;
  if (!stopped) return { ok: false, code: 'truncated', message: 'The answer was cut off' };
  const content = [];
  for (const i of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(i);
    if (b.type === 'text') {
      if (b.text) content.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use' && b.id) {
      const tu = { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
      if (b.bad) tu.bad = true;
      content.push(tu);
    }
  }
  return { ok: true, usage, stop, content };
}

/* ---------- Place lookup (tool get_forecast) ---------- */

const TOOLS = [
  {
    name: 'get_forecast',
    description:
      'Forecast for a place OTHER than the one in DATA. Use only when the question clearly concerns a different place (city, town, island, mountain). Pass the place name as written in the question; you may call it twice to compare two places.',
    input_schema: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] },
  },
];
const MAX_TOOL_ROUNDS = 2; // tool rounds per request (so at most 3 Anthropic calls)
const MAX_TOOLS_PER_ROUND = 2;
const MAX_CALLS = MAX_TOOL_ROUNDS + 1;
const LOOKUP_MS = 8000; // each external fetch
const ASK_BUDGET_MS = 50000; // whole request
const BRIEF_TTL_MS = 10 * 60 * 1000;
const BRIEF_MAX_ENTRIES = 50;
const BRIEF_MAX_CHARS = 6000;
const MAX_LOOKUP_PLACE = 100;
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FC_URL = 'https://api.open-meteo.com/v1/forecast';
const BRIEF_CACHE = new Map(); // lowercased place -> {t, res}; per isolate

// WMO weather_code -> short English word.
function wcWord(c) {
  if (c === 0) return 'clear';
  if (c === 1 || c === 2) return 'partly cloudy';
  if (c === 3) return 'overcast';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 51 && c <= 57) return 'drizzle';
  if (c >= 61 && c <= 67) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 80 && c <= 82) return 'showers';
  if (c >= 95 && c <= 99) return 'thunderstorm';
  return 'unknown';
}

function rnd(v, d) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const k = Math.pow(10, d || 0);
  return Math.round(v * k) / k;
}

// GET json with its own timeout (also aborted with the request). -> parsed json | null on any failure.
async function fetchJson(url, ms, outer) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  const onAbort = () => c.abort();
  if (outer) {
    if (outer.aborted) c.abort();
    else outer.addEventListener('abort', onAbort);
  }
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: c.signal });
    if (!r.ok) {
      try {
        if (r.body) await r.body.cancel();
      } catch (e) {}
      return null;
    }
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

// Compact forecast brief for the model (rounded numbers, at most BRIEF_MAX_CHARS serialized).
function buildBrief(g, j) {
  const cur = j.current || {};
  const hr = j.hourly || {};
  const dl = j.daily || {};
  const at = (o, k, i) => (o && Array.isArray(o[k]) ? o[k][i] : undefined);
  const times = Array.isArray(hr.time) ? hr.time : [];
  const nowSlot = String(cur.time || '').slice(0, 13) + ':00';
  let i0 = times.findIndex((t) => t >= nowSlot);
  if (i0 < 0) i0 = 0;
  const hourly = [];
  for (let i = i0; i < times.length && hourly.length < 48; i++) {
    hourly.push([
      String(times[i]).slice(5, 13).replace('T', ' '),
      rnd(at(hr, 'temperature_2m', i)),
      rnd(at(hr, 'apparent_temperature', i)),
      rnd(at(hr, 'precipitation_probability', i)),
      rnd(at(hr, 'precipitation', i), 1),
      rnd(at(hr, 'wind_speed_10m', i)),
      rnd(at(hr, 'wind_gusts_10m', i)),
      rnd(at(hr, 'uv_index', i), 1),
      wcWord(at(hr, 'weather_code', i)),
      at(hr, 'is_day', i) === 0 ? 1 : 0,
    ]);
  }
  const dtimes = Array.isArray(dl.time) ? dl.time : [];
  const hhmm = (v) => (typeof v === 'string' && v.length >= 16 ? v.slice(11, 16) : null);
  const daily = [];
  for (let i = 0; i < dtimes.length && daily.length < 7; i++) {
    daily.push([
      dtimes[i],
      rnd(at(dl, 'temperature_2m_max', i)),
      rnd(at(dl, 'temperature_2m_min', i)),
      rnd(at(dl, 'precipitation_probability_max', i)),
      rnd(at(dl, 'precipitation_sum', i), 1),
      rnd(at(dl, 'wind_speed_10m_max', i)),
      wcWord(at(dl, 'weather_code', i)),
      hhmm(at(dl, 'sunrise', i)),
      hhmm(at(dl, 'sunset', i)),
      rnd(at(dl, 'uv_index_max', i), 1),
    ]);
  }
  const brief = {
    place: g.name,
    admin: g.admin1 || null,
    country: g.country || null,
    tz: j.timezone || g.timezone || null,
    now_local: cur.time || null,
    now: {
      t: rnd(cur.temperature_2m, 1),
      fl: rnd(cur.apparent_temperature, 1),
      rh: rnd(cur.relative_humidity_2m),
      w: rnd(cur.wind_speed_10m),
      g: rnd(cur.wind_gusts_10m),
      mm: rnd(cur.precipitation, 1),
      wc: wcWord(cur.weather_code),
    },
    hourly_legend:
      'rows [hour "MM-DD HH" local, temp C, feels-like C, rain prob %, rain mm, wind km/h, gust km/h, UV, sky, night 1/0]; sky is one of clear, partly cloudy, overcast, fog, drizzle, rain, snow, showers, thunderstorm',
    hourly,
    daily_legend:
      'rows [date, high C, low C, rain prob %, rain mm, max wind km/h, sky, sunrise HH:MM, sunset HH:MM, max UV]; local time of the place',
    daily,
  };
  while (JSON.stringify(brief).length > BRIEF_MAX_CHARS && brief.hourly.length > 6) {
    brief.hourly.length = Math.max(6, brief.hourly.length - 6);
  }
  return brief;
}

// Geocode a place name, fetch its forecast, build the brief.
// -> {ok:true, name, lat, lon, tz, brief} | {ok:false, reason:'not_found'|'fetch_failed'}
async function lookupPlace(place, lang, outer, ms) {
  const key = place.toLowerCase();
  const hit = BRIEF_CACHE.get(key);
  if (hit && Date.now() - hit.t < BRIEF_TTL_MS) return hit.res;
  if (hit) BRIEF_CACHE.delete(key);
  ms = ms || LOOKUP_MS;
  const gj = await fetchJson(
    GEO_URL + '?name=' + encodeURIComponent(place) + '&count=1&language=' + (lang === 'hr' ? 'hr' : 'en'),
    ms,
    outer
  );
  if (!gj) return { ok: false, reason: 'fetch_failed' };
  const g = Array.isArray(gj.results) ? gj.results[0] : null;
  if (!g || typeof g.latitude !== 'number' || typeof g.longitude !== 'number') return { ok: false, reason: 'not_found' };
  const fj = await fetchJson(
    FC_URL +
      '?latitude=' + encodeURIComponent(g.latitude) +
      '&longitude=' + encodeURIComponent(g.longitude) +
      '&timezone=auto&forecast_days=7' +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code,precipitation' +
      '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,uv_index,weather_code,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,weather_code,sunrise,sunset,uv_index_max',
    ms,
    outer
  );
  if (!fj || !fj.current || !fj.hourly || !fj.daily) return { ok: false, reason: 'fetch_failed' };
  const name = String(g.name || place).slice(0, 80);
  const brief = buildBrief({ ...g, name }, fj);
  const res = { ok: true, name, lat: rnd(g.latitude, 4), lon: rnd(g.longitude, 4), tz: brief.tz, brief };
  if (BRIEF_CACHE.size >= BRIEF_MAX_ENTRIES) BRIEF_CACHE.delete(BRIEF_CACHE.keys().next().value);
  BRIEF_CACHE.set(key, { t: Date.now(), res });
  return res;
}

// One tool round: run the get_forecast calls (max MAX_TOOLS_PER_ROUND), emitting tool/toolres events.
// Every tool_use gets a tool_result. -> {results:[tool_result blocks], places:[{name,lat,lon}]}
async function runTools(tools, lang, write, outer, ms) {
  const jobs = tools.map((tu, n) => {
    if (tu.name !== 'get_forecast') return { tu, err: 'Unknown tool' };
    const raw = !tu.bad && tu.input && typeof tu.input.place === 'string' ? tu.input.place : '';
    // control chars -> space; drop lone surrogates (encodeURIComponent would throw on them); cap the length, then
    // drop a high surrogate the cap may have split off.
    const place = raw
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
      .replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1')
      .trim()
      .slice(0, MAX_LOOKUP_PLACE)
      .replace(/[\ud800-\udbff]$/, '');
    if (!place) return { tu, err: 'Missing place' };
    if (n >= MAX_TOOLS_PER_ROUND) return { tu, err: 'limit', place };
    return { tu, place };
  });
  for (const jb of jobs) if (jb.place && !jb.err) await write('tool', { place: jb.place });
  await Promise.all(
    jobs.map(async (jb) => {
      if (!jb.err) jb.res = await lookupPlace(jb.place, lang, outer, ms);
    })
  );
  const results = [];
  const places = [];
  for (const jb of jobs) {
    const id = jb.tu.id;
    if (jb.err) {
      results.push({ type: 'tool_result', tool_use_id: id, is_error: true, content: jb.err });
      continue;
    }
    const r = jb.res;
    if (r.ok) {
      await write('toolres', { place: jb.place, ok: true, name: r.name, lat: r.lat, lon: r.lon, tz: r.tz });
      places.push({ name: r.name, lat: r.lat, lon: r.lon });
      results.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(r.brief) });
    } else {
      await write('toolres', { place: jb.place, ok: false, reason: r.reason });
      results.push({
        type: 'tool_result',
        tool_use_id: id,
        is_error: true,
        content: r.reason === 'not_found' ? 'Place not found' : 'Forecast lookup failed',
      });
    }
  }
  return { results, places };
}

/* ---------- route handlers ---------- */

async function handleState(request, env) {
  const id = await identify(request, env);
  const lim = limitsOf(env);
  const date = zagrebDate();
  const resetAt = nextDate(date);
  const base = {
    enabled: !!env.ANTHROPIC_API_KEY,
    model: env.ASK_MODEL || 'claude-sonnet-5',
    resetAt,
    owner: id.owner,
  };
  if (id.owner) return jsonRes({ ...base, limit: 0, used: 0, remaining: -1 }, 200, id);
  const [v, i, g] = await Promise.all([
    quotaCall(env, id.keys.vid, 'GET', '/get', { date }),
    quotaCall(env, id.keys.ip, 'GET', '/get', { date }),
    quotaCall(env, id.keys.global, 'GET', '/get', { date }),
  ]);
  const remaining = Math.max(0, Math.min(lim.vid - v.used, lim.ip - i.used, lim.global - g.used));
  return jsonRes({ ...base, limit: lim.vid, used: v.used, remaining }, 200, id);
}

function callUpstream(env, body, signal) {
  return fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function handleAsk(request, env, ctx) {
  const id = await identify(request, env);
  if (!env.ANTHROPIC_API_KEY) return jsonRes({ error: 'disabled' }, 503, id);

  const pb = await parseBody(request, MAX_BODY_BYTES);
  if (!pb.body) return jsonRes({ error: pb.status === 413 ? 'too_large' : 'bad_request' }, pb.status, id);
  const v = validateAsk(pb.body);
  if (!v.q) return jsonRes({ error: v.status === 413 ? 'too_large' : 'bad_request' }, v.status, id);

  // Quota: check every key first (so a refused question burns nothing), then count atomically.
  const lim = limitsOf(env);
  const date = zagrebDate();
  const resetAt = nextDate(date);
  let remaining = -1;
  if (!id.owner) {
    const order = [
      ['vid', lim.vid],
      ['ip', lim.ip],
      ['global', lim.global],
    ];
    const seen = await Promise.all(order.map(([k]) => quotaCall(env, id.keys[k], 'GET', '/get', { date })));
    for (let n = 0; n < order.length; n++) {
      if (seen[n].used >= order[n][1]) {
        return jsonRes({ error: 'limit', limit: order[n][1], used: seen[n].used, resetAt }, 429, id);
      }
    }
    remaining = Infinity;
    for (let n = 0; n < order.length; n++) {
      const [k, limit] = order[n];
      const hit = await quotaCall(env, id.keys[k], 'POST', '/hit', { date, limit: String(limit) });
      if (!hit.allowed) return jsonRes({ error: 'limit', limit, used: hit.used, resetAt }, 429, id);
      remaining = Math.min(remaining, limit - hit.used);
    }
  }

  const model = env.ASK_MODEL || 'claude-sonnet-5';
  const nowLine =
    typeof v.ctx.now_local === 'string' && v.ctx.now_local.trim()
      ? v.ctx.now_local.replace(/[\r\n]+/g, ' ').slice(0, 64)
      : new Date().toISOString().slice(0, 16) + 'Z (UTC)';
  const upstreamBody = {
    model,
    max_tokens: 600,
    stream: true,
    tools: TOOLS,
    system: [
      { type: 'text', text: RULES + '\n\nDATA:\n' + v.ctxStr, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Today is ' + nowLine },
    ],
    messages: [{ role: 'user', content: v.q }],
  };

  const ctrl = new AbortController();
  const timeoutMs = intVar(env.ASK_TIMEOUT_MS, ASK_BUDGET_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  let up;
  try {
    up = await callUpstream(env, upstreamBody, ctrl.signal);
  } catch (e) {
    clearTimeout(timer);
    if (!id.owner) refundHits(env, ctx, id, date);
    return jsonRes({ error: 'upstream', status: timedOut ? 504 : 0 }, 502, id);
  }
  if (!up.ok || !up.body) {
    clearTimeout(timer);
    try {
      if (up.body) await up.body.cancel();
    } catch (e) {}
    console.error('ask: upstream status', up.status);
    if (!id.owner) refundHits(env, ctx, id, date);
    return jsonRes({ error: 'upstream', status: up.status }, 502, id);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const write = sse(writer);

  const pump = (async () => {
    try {
      await write('meta', { model, remaining });
      const total = { in: 0, out: 0, cached: 0 };
      const places = [];
      const lookupMs = intVar(env.ASK_LOOKUP_TIMEOUT_MS, LOOKUP_MS);
      let messages = upstreamBody.messages;
      let calls = 1;
      let res = up;
      let failed = null;
      for (;;) {
        const r = await relayAnthropic(res, write);
        if (!r.ok) {
          failed = r;
          break;
        }
        total.in += r.usage.in;
        total.out += r.usage.out;
        total.cached += r.usage.cached;
        const tools = r.content.filter((b) => b.type === 'tool_use');
        if (r.stop !== 'tool_use' || !tools.length || calls >= MAX_CALLS) break;
        const round = await runTools(tools, v.lang, write, ctrl.signal, lookupMs);
        for (const p of round.places) {
          if (!places.some((q) => q.lat === p.lat && q.lon === p.lon)) places.push(p);
        }
        messages = messages.concat([
          {
            role: 'assistant',
            content: r.content.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b)),
          },
          { role: 'user', content: round.results },
        ]);
        calls++;
        const nextBody = { ...upstreamBody, messages };
        // the last allowed call must answer, not ask again
        if (calls >= MAX_CALLS) nextBody.tool_choice = { type: 'none' };
        res = await callUpstream(env, nextBody, ctrl.signal);
        if (!res.ok || !res.body) {
          try {
            if (res.body) await res.body.cancel();
          } catch (e) {}
          failed = { code: 'upstream', message: 'Upstream status ' + res.status };
          break;
        }
      }
      if (failed) await write('error', { code: failed.code, message: failed.message });
      else await write('done', { in: total.in, out: total.out, cached: total.cached, places, calls });
    } catch (e) {
      // Read failure (timeout / network) or the client went away; tell it if anyone is listening.
      try {
        await write('error', {
          code: timedOut ? 'timeout' : 'stream',
          message: timedOut ? 'The request timed out' : 'The connection was interrupted',
        });
      } catch (e2) {}
    } finally {
      clearTimeout(timer);
      try {
        ctrl.abort();
      } catch (e) {}
      try {
        await writer.close();
      } catch (e) {}
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);

  const h = new Headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  if (id.setVid) h.append('set-cookie', cookieHeader('wd_vid', id.vid));
  return new Response(readable, { status: 200, headers: h });
}

async function handleOwner(request, env) {
  const id = await identify(request, env);
  // Brute-force guard: every attempt (also a successful one) counts toward a per-IP daily cap.
  const attempt = await quotaCall(env, 'own:' + id.keys.ip.slice(3), 'POST', '/hit', {
    date: zagrebDate(),
    limit: String(OWNER_ATTEMPTS),
  });
  if (!attempt.allowed) return jsonRes({ error: 'limit' }, 429, id);
  const t = new URL(request.url).searchParams.get('t');
  const tok = env.OWNER_TOKEN;
  if (!tok || !t || !timingSafeEqual(t, tok)) return jsonRes({ error: 'forbidden' }, 403, id);
  const h = new Headers({ location: OWNER_REDIRECT, 'cache-control': 'no-store' });
  h.append('set-cookie', cookieHeader('wd_owner', await hmacHex(tok, tok)));
  if (id.setVid) h.append('set-cookie', cookieHeader('wd_vid', id.vid));
  return new Response(null, { status: 302, headers: h });
}

/* ---------- Worker entry ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (p === '/api/owner') {
        if (request.method !== 'GET') return jsonRes({ error: 'method' }, 405, null, { allow: 'GET' });
        return await handleOwner(request, env);
      }
      if (p === '/api/ask/state' || p === '/api/ask') {
        if (!originOk(request)) return jsonRes({ error: 'origin' }, 403, null);
        if (p === '/api/ask/state') {
          if (request.method !== 'GET') return jsonRes({ error: 'method' }, 405, null, { allow: 'GET' });
          return await handleState(request, env);
        }
        if (request.method !== 'POST') return jsonRes({ error: 'method' }, 405, null, { allow: 'POST' });
        return await handleAsk(request, env, ctx);
      }
      return jsonRes({ error: 'not_found' }, 404, null);
    } catch (e) {
      console.error('api: internal error');
      return jsonRes({ error: 'internal' }, 500, null);
    }
  },
};

/* ---------- Quota Durable Object ---------- */
/*
 * One object per key (`vid:<id>`, `ip:<hash>`, `own:<ipHash>`, `global`). Stores a single record
 * {date, used} with the KV-style storage API (get/put/delete). A record from an OLDER date than
 * the request's is dropped on access; a record from a NEWER date (a late request from before
 * midnight) is kept and served as is, so it counts toward the new day and never resets it.
 * POST /hit?date=&limit= -> {used, allowed} (counts only when allowed);
 * POST /refund?date= -> {used} (decrements, never below 0);
 * GET /get?date= -> {used}. An alarm wipes the object once its record is no longer today's.
 */
export class Quota {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const u = new URL(request.url);
    const date = u.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'bad_date' }, { status: 400 });
    const st = this.ctx.storage;
    let rec = await st.get('rec');
    if (rec && rec.date < date) {
      await st.delete('rec');
      rec = null;
    }
    const recDate = rec ? rec.date : date; // a newer stored date wins over the request's date
    const used = rec ? rec.used : 0;

    if (u.pathname === '/get' && request.method === 'GET') return Response.json({ used });

    if (u.pathname === '/hit' && request.method === 'POST') {
      const limit = parseInt(u.searchParams.get('limit'), 10);
      if (!Number.isFinite(limit) || limit < 1) return Response.json({ used, allowed: false });
      if (used >= limit) return Response.json({ used, allowed: false });
      await st.put('rec', { date: recDate, used: used + 1 });
      try {
        if (st.getAlarm && st.setAlarm && !(await st.getAlarm())) await st.setAlarm(Date.now() + 36 * 3600 * 1000);
      } catch (e) {}
      return Response.json({ used: used + 1, allowed: true });
    }

    if (u.pathname === '/refund' && request.method === 'POST') {
      if (!rec || used < 1) return Response.json({ used });
      await st.put('rec', { date: recDate, used: used - 1 });
      return Response.json({ used: used - 1 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  async alarm() {
    const st = this.ctx.storage;
    const rec = await st.get('rec');
    if (rec && rec.date === zagrebDate()) {
      await st.setAlarm(Date.now() + 36 * 3600 * 1000);
    } else {
      await st.deleteAll();
    }
  }
}
