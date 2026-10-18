/*
 * Patrik's weather daily - Cloudflare Worker (ES module).
 *
 * Serves the static site exactly as before (every non-/api/ request goes to env.ASSETS) and adds
 * three same-origin routes that front the "Ask about the weather" assistant:
 *
 *   GET  /api/ask/state   quota + availability for the current visitor (JSON, no-store)
 *   POST /api/ask         one question -> text/event-stream (meta, delta*, done | error)
 *   GET  /api/owner?t=... owner mode (cookie), then 302 to the Info view
 *
 * Secrets (never in files): ANTHROPIC_API_KEY, OWNER_TOKEN - set with `wrangler secret put`.
 * Plain vars (wrangler.toml [vars]): ASK_MODEL, ASK_DAILY, ASK_DAILY_IP, ASK_DAILY_GLOBAL.
 * Optional test hook: ASK_TIMEOUT_MS (upstream timeout, default 30000).
 * Quotas live in the `Quota` Durable Object (one object per key, KV-style storage API).
 *
 * Nothing here logs the question, the forecast context or any header value.
 */

const RULES =
  "You are the assistant of Patrik's weather daily. Answer ONLY from the DATA JSON. " +
  'If the answer is not in the data, say so. Answer in the language of the question ' +
  '(Croatian or English), briefly (at most ~6 sentences or a short list), with concrete ' +
  'times (location local time, 24 h clock) and numbers with units (°C, mm, km/h). ' +
  'Never invent data beyond the days in DATA.';

const MAX_BODY_BYTES = 60000; // raw request body
const MAX_Q_CHARS = 500;
const MAX_CTX_CHARS = 40000; // serialized forecast context
const MAX_PLACE_CHARS = 120;
const COOKIE_MAX_AGE = 31536000;
const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';
const OWNER_REDIRECT = '/weather-dashboard.html#info';

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

/* ---------- responses ---------- */

function jsonRes(obj, status, id, extra) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (extra) for (const k in extra) h.set(k, extra[k]);
  if (id && id.setVid) h.append('set-cookie', cookieHeader('wd_vid', id.vid));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

/* ---------- Anthropic relay ---------- */

// Reads Anthropic's SSE body, forwards text deltas through write('delta', {t}).
// -> {ok:true, usage:{in,out,cached}} | {ok:false, code, message}. Throws on read/write failure.
async function relayAnthropic(res, write) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const usage = { in: 0, out: 0, cached: 0 };
  let buf = '';
  let stopped = false;
  let failure = null;

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
    if (ev.type === 'content_block_delta') {
      if (ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
        await write('delta', { t: ev.delta.text });
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
  return { ok: true, usage };
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
    system: [
      { type: 'text', text: RULES + '\n\nDATA:\n' + v.ctxStr, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Today is ' + nowLine },
    ],
    messages: [{ role: 'user', content: v.q }],
  };

  const ctrl = new AbortController();
  const timeoutMs = intVar(env.ASK_TIMEOUT_MS, 30000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  let up;
  try {
    up = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return jsonRes({ error: 'upstream', status: timedOut ? 504 : 0 }, 502, id);
  }
  if (!up.ok || !up.body) {
    clearTimeout(timer);
    try {
      if (up.body) await up.body.cancel();
    } catch (e) {}
    console.error('ask: upstream status', up.status);
    return jsonRes({ error: 'upstream', status: up.status }, 502, id);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const write = sse(writer);

  const pump = (async () => {
    try {
      await write('meta', { model, remaining });
      const r = await relayAnthropic(up, write);
      if (r.ok) await write('done', r.usage);
      else await write('error', { code: r.code, message: r.message });
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
 * One object per key (`vid:<id>`, `ip:<hash>`, `global`). Stores a single record {date, used}
 * with the KV-style storage API (get/put/delete). A record from an older date is dropped on
 * access. POST /hit?date=&limit= -> {used, allowed} (counts only when allowed);
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
    if (rec && rec.date !== date) {
      await st.delete('rec');
      rec = null;
    }
    const used = rec ? rec.used : 0;

    if (u.pathname === '/get' && request.method === 'GET') return Response.json({ used });

    if (u.pathname === '/hit' && request.method === 'POST') {
      const limit = parseInt(u.searchParams.get('limit'), 10);
      if (!Number.isFinite(limit) || limit < 1) return Response.json({ used, allowed: false });
      if (used >= limit) return Response.json({ used, allowed: false });
      await st.put('rec', { date, used: used + 1 });
      try {
        if (st.getAlarm && st.setAlarm && !(await st.getAlarm())) await st.setAlarm(Date.now() + 36 * 3600 * 1000);
      } catch (e) {}
      return Response.json({ used: used + 1, allowed: true });
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
