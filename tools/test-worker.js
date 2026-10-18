#!/usr/bin/env node
/*
 * Tests for worker.js (same-origin AI proxy). Dependency-free, node >= 20.
 *
 * worker.js is an ES module in a folder without package.json "type":"module", so it is loaded by
 * reading the file and importing it through a base64 data: URL (works on every node >= 20).
 * The real exported Quota Durable Object class runs against an in-memory storage fake; the global
 * fetch is stubbed to return a fake Anthropic SSE stream. Prints "WORKER TESTS OK", exit 1 on failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    fails++;
    console.error('FAIL: ' + msg);
  }
}
function eq(a, b, msg) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, msg + (same ? '' : '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'));
}

const ORIGIN = 'https://weath.er45.com';
const REAL_FETCH = globalThis.fetch;

/* ---- fakes ---- */

function makeStorage() {
  const m = new Map();
  let alarm = null;
  return {
    async get(k) {
      return m.get(k);
    },
    async put(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      return m.delete(k);
    },
    async deleteAll() {
      m.clear();
      alarm = null;
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(t) {
      alarm = t;
    },
    _m: m,
  };
}

function makeQuotaNs(Quota) {
  const objs = new Map();
  return {
    _objs: objs,
    idFromName(n) {
      return n;
    },
    get(id) {
      if (!objs.has(id)) objs.set(id, new Quota({ storage: makeStorage() }, {}));
      const o = objs.get(id);
      return { fetch: (url, init) => o.fetch(new Request(url, init)) };
    },
  };
}

function anthropicSse(events) {
  const enc = new TextEncoder();
  const text = events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
  // split into awkward chunks to exercise the line buffer
  const chunks = [];
  for (let i = 0; i < text.length; i += 37) chunks.push(enc.encode(text.slice(i, i + 37)));
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

const GOOD_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sutra ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'je 24 °C.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 17 } },
  { type: 'message_stop' },
];

let upstreamCalls = [];
let upstreamMode = 'ok'; // ok | 401 | hang | midhang | errorevent | truncated
function installFetch() {
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    const signal = init && init.signal;
    if (upstreamMode === '401') return new Response('{"error":{"type":"authentication_error"}}', { status: 401 });
    if (upstreamMode === 'hang') {
      return new Promise((_, rej) => {
        signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    let body;
    if (upstreamMode === 'midhang') {
      const enc = new TextEncoder();
      body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: ' + JSON.stringify(GOOD_EVENTS[0]) + '\n\n'));
          c.enqueue(enc.encode('data: ' + JSON.stringify(GOOD_EVENTS[3]) + '\n\n'));
          signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
    } else if (upstreamMode === 'errorevent') {
      body = anthropicSse([GOOD_EVENTS[0], { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    } else if (upstreamMode === 'truncated') {
      body = anthropicSse(GOOD_EVENTS.slice(0, 4));
    } else {
      body = anthropicSse(GOOD_EVENTS);
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /^event: (.*)$/m.exec(b);
      const da = /^data: (.*)$/m.exec(b);
      return { event: ev && ev[1], data: da ? JSON.parse(da[1]) : null };
    });
}

function cookieOf(res, name) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return all.find((c) => c.startsWith(name + '='));
}
function cookieVal(setCookie) {
  return setCookie.split(';')[0];
}

async function main() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const worker = mod.default;
  const Quota = mod.Quota;
  ok(typeof worker.fetch === 'function', 'default export has fetch()');
  ok(typeof Quota === 'function', 'Quota class is exported');

  installFetch();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const drain = async () => {
    await Promise.all(pending.splice(0));
  };

  function mkEnv(over) {
    return Object.assign(
      {
        ASSETS: { fetch: async (req) => new Response('ASSET:' + new URL(req.url).pathname, { status: 200 }) },
        QUOTA: makeQuotaNs(Quota),
        ANTHROPIC_API_KEY: 'test-key-not-real',
        OWNER_TOKEN: 'owner-secret-token',
        ASK_MODEL: 'claude-sonnet-5',
        ASK_DAILY: '10',
        ASK_DAILY_IP: '40',
        ASK_DAILY_GLOBAL: '400',
      },
      over || {}
    );
  }
  const goodBody = (extra) => Object.assign({ q: 'Hoce li kisiti sutra?', lang: 'hr', ctx: { now_local: '2026-10-18T16:00', days: [{ d: '2026-10-19', hi: 24 }] }, place: 'Zagreb' }, extra || {});
  function askReq(body, headers, raw) {
    return new Request('https://weath.er45.com/api/ask', {
      method: 'POST',
      headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.5' }, headers || {}),
      body: raw !== undefined ? raw : JSON.stringify(body),
    });
  }
  function stateReq(headers) {
    return new Request('https://weath.er45.com/api/ask/state', { headers: Object.assign({ origin: ORIGIN, 'cf-connecting-ip': '203.0.113.5' }, headers || {}) });
  }

  /* ---- helper unit tests ---- */
  {
    const env = mkEnv();
    // static passthrough, byte-identical delegation
    for (const p of ['/', '/weather-dashboard.html', '/sw.js', '/api', '/apix']) {
      const r = await worker.fetch(new Request('https://weath.er45.com' + p), env, ctx);
      eq([r.status, await r.text()], [200, 'ASSET:' + p], 'static passthrough ' + p);
    }
    // unknown /api/ path and wrong methods
    let r = await worker.fetch(new Request('https://weath.er45.com/api/nope', { headers: { origin: ORIGIN } }), env, ctx);
    eq(r.status, 404, 'unknown /api/ path 404');
    r = await worker.fetch(new Request('https://weath.er45.com/api/ask', { headers: { origin: ORIGIN } }), env, ctx);
    eq(r.status, 405, 'GET /api/ask 405');
    r = await worker.fetch(new Request('https://weath.er45.com/api/ask/state', { method: 'POST', headers: { origin: ORIGIN } }), env, ctx);
    eq(r.status, 405, 'POST /api/ask/state 405');
  }

  /* ---- state ---- */
  {
    let env = mkEnv({ ANTHROPIC_API_KEY: undefined });
    let r = await worker.fetch(stateReq(), env, ctx);
    const j = await r.json();
    eq(r.status, 200, 'state 200');
    eq(j.enabled, false, 'state enabled:false without key');
    eq(r.headers.get('cache-control'), 'no-store', 'state no-store');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(j.resetAt), 'state resetAt is YYYY-MM-DD');
    const vid = cookieOf(r, 'wd_vid');
    ok(vid && /^wd_vid=[0-9a-f]{32}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=31536000$/.test(vid), 'state sets wd_vid cookie with the right flags: ' + vid);
    // with key: shape
    env = mkEnv();
    r = await worker.fetch(stateReq(), env, ctx);
    const s = await r.json();
    eq(
      s,
      { enabled: true, model: 'claude-sonnet-5', resetAt: s.resetAt, owner: false, limit: 10, used: 0, remaining: 10 },
      'state shape with key'
    );
    // existing cookie is not re-issued
    const v = cookieVal(cookieOf(r, 'wd_vid'));
    r = await worker.fetch(stateReq({ cookie: v }), env, ctx);
    ok(!cookieOf(r, 'wd_vid'), 'existing wd_vid not re-set');
    // malformed cookie replaced
    r = await worker.fetch(stateReq({ cookie: 'wd_vid=zzz' }), env, ctx);
    ok(!!cookieOf(r, 'wd_vid'), 'malformed wd_vid replaced');
    // reset date is the day after the Zagreb date
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
    ok(s.resetAt > today, 'resetAt is after today in Zagreb');
  }

  /* ---- origin check ---- */
  {
    const env = mkEnv();
    const call = (headers) => worker.fetch(new Request('https://weath.er45.com/api/ask/state', { headers }), env, ctx);
    eq((await call({})).status, 403, 'no Origin/Referer -> 403');
    eq((await call({ origin: 'https://evil.example' })).status, 403, 'foreign Origin -> 403');
    eq((await call({ origin: 'https://evil-er45.com' })).status, 403, 'look-alike host -> 403');
    eq((await call({ origin: 'https://weath.er45.com.evil.example' })).status, 403, 'suffix trick -> 403');
    eq((await call({ origin: 'null' })).status, 403, 'Origin null -> 403');
    eq((await call({ referer: 'https://evil.example/x' })).status, 403, 'foreign Referer -> 403');
    eq((await call({ origin: 'https://evil.example', referer: ORIGIN + '/' })).status, 403, 'bad Origin wins over good Referer');
    eq((await call({ origin: ORIGIN })).status, 200, 'weath.er45.com Origin ok');
    eq((await call({ origin: 'https://foo.er45.com' })).status, 200, '*.er45.com Origin ok');
    eq((await call({ referer: ORIGIN + '/weather-dashboard.html' })).status, 200, 'Referer fallback ok');
    eq((await call({ origin: 'http://localhost:8787' })).status, 200, 'localhost ok');
    eq((await call({ origin: 'http://127.0.0.1:8787' })).status, 200, '127.0.0.1 ok');
    const r = await worker.fetch(askReq(goodBody(), { origin: 'https://evil.example' }), env, ctx);
    eq(r.status, 403, 'POST /api/ask foreign Origin -> 403');
    eq((await r.json()).error, 'origin', 'origin error body');
    eq(upstreamCalls.length, 0, 'no upstream call for a refused origin');
  }

  /* ---- ask: validation ---- */
  {
    const env = mkEnv();
    let r = await worker.fetch(askReq(goodBody(), {}), mkEnv({ ANTHROPIC_API_KEY: '' }), ctx);
    eq([r.status, (await r.json()).error], [503, 'disabled'], 'ask without key -> 503 disabled');

    const bad = async (body, raw, label, status, error) => {
      const res = await worker.fetch(askReq(body, {}, raw), env, ctx);
      eq([res.status, (await res.json()).error], [status, error], label);
    };
    await bad(null, '{not json', 'invalid JSON -> 400', 400, 'bad_request');
    await bad(null, '[1,2]', 'array body -> 400', 400, 'bad_request');
    await bad(goodBody({ q: 123 }), undefined, 'non-string q -> 400', 400, 'bad_request');
    await bad(goodBody({ q: '   ' }), undefined, 'blank q -> 400', 400, 'bad_request');
    await bad(goodBody({ q: 'x'.repeat(501) }), undefined, 'q > 500 chars -> 400', 400, 'bad_request');
    await bad(goodBody({ lang: 'de' }), undefined, 'bad lang -> 400', 400, 'bad_request');
    await bad(goodBody({ ctx: 'str' }), undefined, 'non-object ctx -> 400', 400, 'bad_request');
    await bad(goodBody({ ctx: [1] }), undefined, 'array ctx -> 400', 400, 'bad_request');
    await bad(goodBody({ place: 5 }), undefined, 'non-string place -> 400', 400, 'bad_request');
    await bad(goodBody({ ctx: { blob: 'y'.repeat(40001) } }), undefined, 'ctx > 40000 chars -> 413', 413, 'too_large');
    await bad(goodBody({ ctx: { blob: 'y'.repeat(70000) } }), undefined, 'body > 60 kB -> 413', 413, 'too_large');
    // streamed body with no content-length > 60 kB
    {
      const big = new TextEncoder().encode(JSON.stringify(goodBody({ ctx: { blob: 'z'.repeat(80000) } })));
      const stream = new ReadableStream({
        start(c) {
          for (let i = 0; i < big.length; i += 8192) c.enqueue(big.slice(i, i + 8192));
          c.close();
        },
      });
      const res = await worker.fetch(
        new Request('https://weath.er45.com/api/ask', { method: 'POST', headers: { origin: ORIGIN }, body: stream, duplex: 'half' }),
        env,
        ctx
      );
      eq([res.status, (await res.json()).error], [413, 'too_large'], 'chunked body > 60 kB -> 413 without content-length');
    }
    eq(upstreamCalls.length, 0, 'invalid questions never reach upstream');
    // invalid questions are not counted
    const st = await (await worker.fetch(stateReq(), env, ctx)).json();
    eq(st.used, 0, 'invalid questions do not consume quota');
  }

  /* ---- ask: SSE relay ---- */
  {
    const env = mkEnv();
    upstreamCalls = [];
    upstreamMode = 'ok';
    const r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(r.status, 200, 'ask 200');
    ok((r.headers.get('content-type') || '').startsWith('text/event-stream'), 'ask content-type is text/event-stream');
    ok(!!cookieOf(r, 'wd_vid'), 'ask sets wd_vid on first call');
    const text = await r.text();
    await drain();
    const evs = parseSse(text);
    eq(evs[0].event, 'meta', 'first event is meta');
    eq(evs[0].data, { model: 'claude-sonnet-5', remaining: 9 }, 'meta payload');
    const deltas = evs.filter((e) => e.event === 'delta');
    eq(deltas.map((d) => d.data.t).join(''), 'Sutra je 24 °C.', 'delta texts reassemble the fake answer');
    ok(deltas.length >= 2, 'at least two delta events');
    const last = evs[evs.length - 1];
    eq(last.event, 'done', 'last event is done');
    eq(last.data, { in: 120, out: 17, cached: 80, places: [], calls: 1 }, 'done usage (with places and calls)');
    eq(
      evs.map((e) => e.event).filter((e) => e !== 'delta'),
      ['meta', 'done'],
      'no other event kinds'
    );

    // upstream request shape
    eq(upstreamCalls.length, 1, 'exactly one upstream call');
    const c = upstreamCalls[0];
    eq(c.url, 'https://api.anthropic.com/v1/messages', 'upstream URL');
    const h = new Headers(c.init.headers);
    eq(h.get('x-api-key'), 'test-key-not-real', 'upstream x-api-key');
    eq(h.get('anthropic-version'), '2023-06-01', 'upstream anthropic-version');
    eq(h.get('content-type'), 'application/json', 'upstream content-type');
    const b = JSON.parse(c.init.body);
    eq([b.model, b.max_tokens, b.stream], ['claude-sonnet-5', 600, true], 'upstream model/max_tokens/stream');
    eq(b.system.length, 2, 'two system blocks');
    ok(b.system[0].text.startsWith("You are the assistant of Patrik's weather daily."), 'RULES first');
    ok(b.system[0].text.includes('\n\nDATA:\n{"now_local":"2026-10-18T16:00"'), 'DATA json follows RULES');
    eq(b.system[0].cache_control, { type: 'ephemeral' }, 'cache_control on the data block');
    eq(b.system[1].text, 'Today is 2026-10-18T16:00', 'now_local used for the date line');
    eq(b.messages, [{ role: 'user', content: 'Hoce li kisiti sutra?' }], 'user message');
    ok(!('cache_control' in b.system[1]), 'no cache_control on the date block');
    ok(!/test-key-not-real/.test(c.init.body), 'key never in the request body');

    // without now_local the Worker uses UTC
    upstreamCalls = [];
    const r2 = await worker.fetch(askReq(goodBody({ ctx: { days: [] } }), {}), env, ctx);
    await r2.text();
    await drain();
    ok(/^Today is \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \(UTC\)$/.test(JSON.parse(upstreamCalls[0].init.body).system[1].text), 'UTC fallback date line');
  }

  /* ---- ask: upstream failure modes ---- */
  {
    let env = mkEnv();
    upstreamMode = '401';
    let r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(r.status, 502, 'upstream 401 -> 502');
    ok(!(r.headers.get('content-type') || '').includes('event-stream'), 'upstream 401 answered with JSON, not SSE');
    eq(await r.json(), { error: 'upstream', status: 401 }, 'upstream 401 body');

    upstreamMode = 'hang';
    env = mkEnv({ ASK_TIMEOUT_MS: '60' });
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(r.status, 502, 'upstream timeout before start -> 502');
    eq(await r.json(), { error: 'upstream', status: 504 }, 'timeout body (status 504)');

    upstreamMode = 'midhang';
    env = mkEnv({ ASK_TIMEOUT_MS: '80' });
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(r.status, 200, 'mid-stream timeout starts as SSE');
    let evs = parseSse(await r.text());
    await drain();
    eq(evs[0].event, 'meta', 'mid-stream timeout: meta first');
    ok(evs.some((e) => e.event === 'delta'), 'mid-stream timeout: got a delta before the hang');
    const err = evs[evs.length - 1];
    eq([err.event, err.data.code], ['error', 'timeout'], 'mid-stream timeout -> error event code timeout');

    upstreamMode = 'errorevent';
    env = mkEnv();
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    evs = parseSse(await r.text());
    await drain();
    const e2 = evs[evs.length - 1];
    eq([e2.event, e2.data.code], ['error', 'overloaded_error'], 'upstream error event relayed as error');

    upstreamMode = 'truncated';
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    evs = parseSse(await r.text());
    await drain();
    const e3 = evs[evs.length - 1];
    eq([e3.event, e3.data.code], ['error', 'truncated'], 'stream without message_stop -> error truncated');
    upstreamMode = 'ok';
  }

  /* ---- quotas ---- */
  {
    // per visitor: 10 ok, 11th 429
    const env = mkEnv();
    upstreamCalls = [];
    let cookie = null;
    let remainingSeq = [];
    for (let n = 1; n <= 10; n++) {
      const r = await worker.fetch(askReq(goodBody(), cookie ? { cookie } : {}), env, ctx);
      eq(r.status, 200, 'question ' + n + ' ok');
      if (!cookie) cookie = cookieVal(cookieOf(r, 'wd_vid'));
      const evs = parseSse(await r.text());
      remainingSeq.push(evs[0].data.remaining);
    }
    await drain();
    eq(remainingSeq, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0], 'remaining counts down 9..0');
    const r11 = await worker.fetch(askReq(goodBody(), { cookie }), env, ctx);
    eq(r11.status, 429, '11th question -> 429');
    const j11 = await r11.json();
    eq([j11.error, j11.limit, j11.used], ['limit', 10, 10], '429 body error/limit/used');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(j11.resetAt), '429 body has resetAt');
    eq(upstreamCalls.length, 10, 'the refused question never reached upstream');
    const st = await (await worker.fetch(stateReq({ cookie }), env, ctx)).json();
    eq([st.used, st.remaining, st.limit], [10, 0, 10], 'state after the limit');
    // a different visitor on the same IP is still fine (IP cap 40)
    const rOther = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(rOther.status, 200, 'other visitor, same IP still allowed');
    await rOther.text();
    await drain();
  }
  {
    // per IP cap: fresh visitors (no cookie) from one IP, ASK_DAILY_IP = 3
    const env = mkEnv({ ASK_DAILY_IP: '3' });
    const codes = [];
    for (let n = 0; n < 5; n++) {
      const r = await worker.fetch(askReq(goodBody(), { 'cf-connecting-ip': '198.51.100.7' }), env, ctx);
      codes.push(r.status);
      if (r.status === 200) await r.text();
      else eq((await r.json()).limit, 3, 'IP 429 reports the IP limit');
    }
    await drain();
    eq(codes, [200, 200, 200, 429, 429], 'IP cap: 3 then 429 across fresh visitors');
    const rOtherIp = await worker.fetch(askReq(goodBody(), { 'cf-connecting-ip': '198.51.100.8' }), env, ctx);
    eq(rOtherIp.status, 200, 'a different IP is unaffected');
    await rOtherIp.text();
    await drain();
  }
  {
    // global fuse, ASK_DAILY_GLOBAL = 2
    const env = mkEnv({ ASK_DAILY_GLOBAL: '2' });
    const codes = [];
    for (let n = 0; n < 4; n++) {
      const r = await worker.fetch(askReq(goodBody(), { 'cf-connecting-ip': '192.0.2.' + (10 + n) }), env, ctx);
      codes.push(r.status);
      if (r.status === 200) await r.text();
      else eq((await r.json()).limit, 2, 'global 429 reports the global limit');
    }
    await drain();
    eq(codes, [200, 200, 429, 429], 'global fuse: 2 then 429 across visitors and IPs');
    const st = await (await worker.fetch(stateReq({ 'cf-connecting-ip': '192.0.2.99' }), env, ctx)).json();
    eq(st.remaining, 0, 'state remaining reflects the exhausted global fuse');
  }
  {
    // a refused (429) question must not burn the other counters
    const env = mkEnv({ ASK_DAILY_IP: '1' });
    const r1 = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    await r1.text();
    await drain();
    const cookie = cookieVal(cookieOf(r1, 'wd_vid'));
    const r2 = await worker.fetch(askReq(goodBody(), { cookie, 'cf-connecting-ip': '203.0.113.5' }), env, ctx);
    eq(r2.status, 429, 'IP cap refuses the second question');
    const st = await (await worker.fetch(stateReq({ cookie, 'cf-connecting-ip': '203.0.113.99' }), env, ctx)).json();
    eq(st.used, 1, 'refused question did not increment the visitor counter');
  }

  /* ---- owner ---- */
  {
    const env = mkEnv();
    const own = (t) => worker.fetch(new Request('https://weath.er45.com/api/owner' + (t === undefined ? '' : '?t=' + encodeURIComponent(t))), env, ctx);
    let r = await own('wrong');
    eq(r.status, 403, 'owner wrong token -> 403');
    ok(!cookieOf(r, 'wd_owner'), 'wrong token sets no wd_owner');
    eq((await own()).status, 403, 'owner missing token -> 403');
    eq((await own('')).status, 403, 'owner empty token -> 403');
    r = await worker.fetch(new Request('https://weath.er45.com/api/owner?t=anything'), mkEnv({ OWNER_TOKEN: undefined }), ctx);
    eq(r.status, 403, 'owner route with no OWNER_TOKEN configured -> 403');
    r = await own('owner-secret-token');
    eq(r.status, 302, 'owner right token -> 302');
    eq(r.headers.get('location'), '/weather-dashboard.html#info', 'owner redirect target');
    const oc = cookieOf(r, 'wd_owner');
    ok(oc && /^wd_owner=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=31536000$/.test(oc), 'wd_owner cookie flags: ' + oc);
    ok(!oc.includes('owner-secret-token'), 'wd_owner cookie does not contain the token');
    const ownerCookie = cookieVal(oc);

    // owner state: unlimited
    let s = await (await worker.fetch(stateReq({ cookie: ownerCookie }), env, ctx)).json();
    eq([s.owner, s.limit, s.remaining, s.used], [true, 0, -1, 0], 'owner state: limit 0, remaining -1');
    // forged / stale owner cookie is not owner
    s = await (await worker.fetch(stateReq({ cookie: 'wd_owner=' + '0'.repeat(64) }), env, ctx)).json();
    eq(s.owner, false, 'forged wd_owner is not owner');
    s = await (await worker.fetch(stateReq({ cookie: ownerCookie }), mkEnv({ OWNER_TOKEN: 'rotated-token' }), ctx)).json();
    eq(s.owner, false, 'wd_owner stops working after the token is rotated');

    // rate limit: 10 attempts per IP per day (a successful login counts), the 11th is 429
    {
      const env2 = mkEnv();
      const ownIp = (ip, t) => worker.fetch(new Request('https://weath.er45.com/api/owner?t=' + encodeURIComponent(t), { headers: { 'cf-connecting-ip': ip } }), env2, ctx);
      const codes2 = [];
      for (let n = 0; n < 9; n++) codes2.push((await ownIp('198.51.100.50', 'wrong-' + n)).status);
      eq(codes2, [403, 403, 403, 403, 403, 403, 403, 403, 403], 'owner: 9 wrong attempts -> 403');
      const tenth = await ownIp('198.51.100.50', 'owner-secret-token');
      eq(tenth.status, 302, 'owner: 10th attempt (right token) still works');
      const eleventh = await ownIp('198.51.100.50', 'owner-secret-token');
      eq(eleventh.status, 429, 'owner: 11th attempt -> 429 even with the right token');
      eq(await eleventh.json(), { error: 'limit' }, 'owner: 429 body');
      ok(!cookieOf(eleventh, 'wd_owner'), 'owner: refused attempt sets no wd_owner');
      const other = await ownIp('198.51.100.51', 'owner-secret-token');
      eq(other.status, 302, 'owner: a different IP has its own budget');
      const ownKeys = [...env2.QUOTA._objs.keys()].filter((k) => k.startsWith('own:'));
      eq(ownKeys.length, 2, 'owner: attempts are counted under own:<ipHash> keys');
      ok(ownKeys.every((k) => /^own:[0-9a-f]{32}$/.test(k)), 'owner: key is own:<32 hex> (hashed IP, no raw IP)');
    }

    // owner bypasses every limit
    const tight = mkEnv({ ASK_DAILY: '1', ASK_DAILY_IP: '1', ASK_DAILY_GLOBAL: '1' });
    const codes = [];
    for (let n = 0; n < 4; n++) {
      const rr = await worker.fetch(askReq(goodBody(), { cookie: ownerCookie }), tight, ctx);
      codes.push(rr.status);
      const evs = parseSse(await rr.text());
      if (n === 0) eq(evs[0].data.remaining, -1, 'owner meta remaining -1');
    }
    await drain();
    eq(codes, [200, 200, 200, 200], 'owner is never limited');
    // and a normal visitor is still limited by the same env (owner did not use it up, but 1 is 1)
    const v1 = await worker.fetch(askReq(goodBody(), {}), tight, ctx);
    eq(v1.status, 200, 'owner traffic did not consume the visitor quota');
    await v1.text();
    await drain();
    const v2 = await worker.fetch(askReq(goodBody(), { cookie: cookieVal(cookieOf(v1, 'wd_vid')) }), tight, ctx);
    eq(v2.status, 429, 'normal visitor limited under the tight env');
  }

  /* ---- refund on a pre-stream upstream failure ---- */
  {
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
    const keys = (env) => [...env.QUOTA._objs.keys()].filter((k) => !k.startsWith('own:'));
    const usedOf = async (env) => {
      const out = {};
      for (const k of keys(env)) out[k.split(':')[0]] = (await env.QUOTA.get(k).fetch('https://q/get?date=' + today()).then((x) => x.json())).used;
      return out;
    };

    // upstream 401 -> 502, all three counters back to 0
    let env = mkEnv();
    upstreamMode = '401';
    let r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(r.status, 502, 'refund: upstream 401 -> 502');
    await r.json();
    await drain();
    eq(await usedOf(env), { vid: 0, ip: 0, global: 0 }, 'refund: 401 gives back visitor, IP and global hits');

    // timeout before stream (504) -> refunded
    env = mkEnv({ ASK_TIMEOUT_MS: '60' });
    upstreamMode = 'hang';
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq((await r.json()).status, 504, 'refund: timeout answers 502/504');
    await drain();
    eq(await usedOf(env), { vid: 0, ip: 0, global: 0 }, 'refund: timeout gives back all three hits');

    // network failure (status 0) -> refunded
    env = mkEnv();
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('network down');
    };
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    eq(await r.json(), { error: 'upstream', status: 0 }, 'refund: network failure body (status 0)');
    await drain();
    eq(await usedOf(env), { vid: 0, ip: 0, global: 0 }, 'refund: network failure gives back all three hits');
    globalThis.fetch = savedFetch;

    // earlier successful question stays counted; only the failing one is refunded
    env = mkEnv();
    upstreamMode = 'ok';
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    const cookie = cookieVal(cookieOf(r, 'wd_vid'));
    await r.text();
    await drain();
    upstreamMode = '401';
    r = await worker.fetch(askReq(goodBody(), { cookie }), env, ctx);
    eq(r.status, 502, 'refund: second question fails upstream');
    await r.json();
    await drain();
    eq(await usedOf(env), { vid: 1, ip: 1, global: 1 }, 'refund: only the failed question is given back');
    const st = await (await worker.fetch(stateReq({ cookie }), env, ctx)).json();
    eq([st.used, st.remaining], [1, 9], 'refund: state shows 1 used after a success and a refunded failure');

    // mid-stream failure is NOT refunded
    env = mkEnv({ ASK_TIMEOUT_MS: '80' });
    upstreamMode = 'midhang';
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    await r.text();
    await drain();
    eq(await usedOf(env), { vid: 1, ip: 1, global: 1 }, 'refund: mid-stream timeout keeps the hits');
    env = mkEnv();
    upstreamMode = 'errorevent';
    r = await worker.fetch(askReq(goodBody(), {}), env, ctx);
    await r.text();
    await drain();
    eq(await usedOf(env), { vid: 1, ip: 1, global: 1 }, 'refund: upstream error event keeps the hits');

    // owner is never charged, so there is nothing to refund and no ask counters exist
    env = mkEnv();
    const oc = cookieVal(cookieOf(await worker.fetch(new Request('https://weath.er45.com/api/owner?t=owner-secret-token'), env, ctx), 'wd_owner'));
    upstreamMode = '401';
    r = await worker.fetch(askReq(goodBody(), { cookie: oc }), env, ctx);
    eq(r.status, 502, 'refund: owner upstream failure -> 502');
    await r.json();
    await drain();
    eq(keys(env), [], 'refund: owner touches no ask counters');
    upstreamMode = 'ok';
  }

  /* ---- Quota Durable Object directly ---- */
  {
    const storage = makeStorage();
    const q = new Quota({ storage }, {});
    const hit = async (date, limit) => (await q.fetch(new Request('https://q/hit?date=' + date + '&limit=' + limit, { method: 'POST' }))).json();
    const get = async (date) => (await q.fetch(new Request('https://q/get?date=' + date))).json();
    eq(await get('2026-10-18'), { used: 0 }, 'DO fresh get');
    eq(await hit('2026-10-18', 2), { used: 1, allowed: true }, 'DO hit 1');
    eq(await hit('2026-10-18', 2), { used: 2, allowed: true }, 'DO hit 2');
    eq(await hit('2026-10-18', 2), { used: 2, allowed: false }, 'DO hit 3 refused, not incremented');
    eq(await get('2026-10-18'), { used: 2 }, 'DO get after hits');
    ok((await storage.getAlarm()) > Date.now(), 'DO sets a cleanup alarm');
    eq(await get('2026-10-19'), { used: 0 }, 'DO new date resets');
    ok(!storage._m.has('rec'), 'DO old-date record deleted on access');
    eq(await hit('2026-10-19', 2), { used: 1, allowed: true }, 'DO hit on the new date');
    eq((await q.fetch(new Request('https://q/get?date=bogus'))).status, 400, 'DO rejects a bad date');
    eq(await hit('2026-10-19', 'abc'), { used: 1, allowed: false }, 'DO refuses a non-numeric limit');
    // refund: decrements, never below 0
    const refund = async (date) => (await q.fetch(new Request('https://q/refund?date=' + date, { method: 'POST' }))).json();
    eq(await hit('2026-10-19', 1), { used: 1, allowed: false }, 'DO limit 1 is already used up on 10-19 (setup for refund)');
    eq(await refund('2026-10-19'), { used: 0 }, 'DO refund restores used');
    eq(await refund('2026-10-19'), { used: 0 }, 'DO refund never goes below 0');
    eq(await get('2026-10-19'), { used: 0 }, 'DO get after refund');
    eq(await hit('2026-10-19', 1), { used: 1, allowed: true }, 'DO hit after refund');
    eq((await q.fetch(new Request('https://q/refund?date=bogus', { method: 'POST' }))).status, 400, 'DO refund rejects a bad date');
    eq((await q.fetch(new Request('https://q/refund?date=2026-10-19'))).status, 404, 'DO refund needs POST');
    // midnight race: a late request carrying the OLD date must not reset a newer record
    eq(await hit('2026-10-19', 5), { used: 2, allowed: true }, 'DO newer record at 2 before the late request');
    eq(await get('2026-10-18'), { used: 2 }, 'DO stale-date get returns the newer record used');
    eq(storage._m.get('rec'), { date: '2026-10-19', used: 2 }, 'DO stale-date get does not reset or rewrite the newer record');
    eq(await hit('2026-10-18', 5), { used: 3, allowed: true }, 'DO stale-date hit counts toward the newer record');
    eq(storage._m.get('rec'), { date: '2026-10-19', used: 3 }, 'DO stale-date hit keeps the newer date');
    eq(await refund('2026-10-18'), { used: 2 }, 'DO stale-date refund decrements the newer record');
    eq(storage._m.get('rec'), { date: '2026-10-19', used: 2 }, 'DO newer record intact after stale refund');
    eq(await hit('2026-10-18', 2), { used: 2, allowed: false }, 'DO stale-date hit respects the limit of the newer record');
    // a record whose date is older than the request is still dropped
    eq(await get('2026-10-20'), { used: 0 }, 'DO older record dropped for a later date');
    ok(!storage._m.has('rec'), 'DO older record deleted for a later date');
    // alarm: stale record -> wiped; today record -> rescheduled
    await storage.put('rec', { date: '2000-01-01', used: 3 });
    await q.alarm();
    ok(!storage._m.has('rec'), 'DO alarm wipes a stale record');
    await storage.put('rec', { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date()), used: 1 });
    await q.alarm();
    ok(storage._m.has('rec') && (await storage.getAlarm()) > Date.now(), 'DO alarm keeps today and reschedules');
  }

  /* ---- ask: get_forecast tool loop (W3) ---- */
  {
    const tstate = async (env, cookie) => (await worker.fetch(stateReq(cookie ? { cookie } : {}), env, ctx)).json();
    const sseResp = (events) => new Response(anthropicSse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const jsonResp = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });
    const hang = (init) =>
      new Promise((_, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const msgStart = (i, o, c) => ({ type: 'message_start', message: { usage: { input_tokens: i, output_tokens: 1, cache_read_input_tokens: c || 0 } } });
    // a response that asks for tools: uses = [{id, json: [pieces of the arguments JSON]}]
    const toolUseEvents = (uses, opt) => {
      opt = opt || {};
      const ev = [msgStart(100, 1, 0)];
      let idx = 0;
      if (opt.text) {
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
        ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: opt.text } });
        ev.push({ type: 'content_block_stop', index: idx });
        idx++;
      }
      for (const u of uses) {
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: u.id, name: u.name || 'get_forecast', input: {} } });
        for (const pj of u.json) ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: pj } });
        ev.push({ type: 'content_block_stop', index: idx });
        idx++;
      }
      ev.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
      ev.push({ type: 'message_stop' });
      return ev;
    };
    const placeUse = (id, place) => {
      const j = JSON.stringify({ place });
      return { id, json: [j.slice(0, 5), j.slice(5)] };
    };
    const geoHit = (name, lat, lon) =>
      jsonResp({ results: [{ id: 1, name, latitude: lat, longitude: lon, country: 'Hrvatska', admin1: 'Splitsko-dalmatinska', timezone: 'Europe/Zagreb' }] });
    const forecastJson = (tz) => {
      const time = [];
      const mk = (f) => Array.from({ length: 168 }, (_, i) => f(i));
      for (let i = 0; i < 168; i++) time.push('2026-10-' + String(18 + Math.floor(i / 24)).padStart(2, '0') + 'T' + String(i % 24).padStart(2, '0') + ':00');
      const days = Array.from({ length: 7 }, (_, i) => '2026-10-' + String(18 + i).padStart(2, '0'));
      return {
        timezone: tz || 'Europe/Zagreb',
        current: { time: '2026-10-18T16:00', temperature_2m: 17.34, apparent_temperature: 16.12, relative_humidity_2m: 61, wind_speed_10m: 12.4, wind_gusts_10m: 25.7, weather_code: 2, precipitation: 0 },
        hourly: {
          time,
          temperature_2m: mk((i) => 10 + (i % 24) * 0.4321),
          apparent_temperature: mk((i) => 9 + (i % 24) * 0.4123),
          precipitation_probability: mk((i) => (i * 7) % 100),
          precipitation: mk((i) => ((i * 3) % 10) / 10),
          wind_speed_10m: mk((i) => 8 + (i % 9) * 1.234),
          wind_gusts_10m: mk((i) => 15 + (i % 9) * 2.345),
          uv_index: mk((i) => ((i % 24) > 6 && (i % 24) < 18 ? 3.456 : 0)),
          weather_code: mk((i) => [0, 1, 3, 45, 53, 63, 73, 81, 95][i % 9]),
          is_day: mk((i) => ((i % 24) > 6 && (i % 24) < 18 ? 1 : 0)),
        },
        daily: {
          time: days,
          temperature_2m_max: days.map((_, i) => 20.1 + i),
          temperature_2m_min: days.map((_, i) => 11.2 + i),
          precipitation_probability_max: days.map((_, i) => 10 * i),
          precipitation_sum: days.map((_, i) => 0.55 * i),
          wind_speed_10m_max: days.map((_, i) => 20.5 + i),
          weather_code: days.map((_, i) => [0, 2, 3, 61, 80, 95, 71][i]),
          sunrise: days.map((d) => d + 'T06:58'),
          sunset: days.map((d) => d + 'T17:49'),
          uv_index_max: days.map((_, i) => 4.44 - i / 2),
        },
      };
    };
    // scripted network: anth(n, body, init) -> Response; geo(url, init), fc(url, init) default to a hit / a forecast
    const script = (cfg) => {
      const log = { anth: [], geo: [], fc: [] };
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.startsWith('https://api.anthropic.com/')) {
          const body = JSON.parse(init.body);
          log.anth.push(body);
          return cfg.anth(log.anth.length, body, init);
        }
        if (u.startsWith('https://geocoding-api.open-meteo.com/')) {
          log.geo.push({ url: u, init });
          return cfg.geo ? cfg.geo(u, init) : geoHit('Split', 43.5081, 16.4402);
        }
        if (u.startsWith('https://api.open-meteo.com/')) {
          log.fc.push({ url: u, init });
          return cfg.fc ? cfg.fc(u, init) : jsonResp(forecastJson());
        }
        throw new Error('unexpected fetch ' + u);
      };
      return log;
    };
    const plain = (text) => [msgStart(120, 1, 80), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 17 } }, { type: 'message_stop' }];
    const ask = async (env, q, extra, headers) => {
      const r = await worker.fetch(askReq(goodBody(Object.assign({ q }, extra || {})), headers || {}), env, ctx);
      const text = await r.text();
      await drain();
      return { r, evs: r.status === 200 ? parseSse(text) : [], text };
    };
    const kinds = (evs) => evs.map((e) => e.event).filter((e, i, a) => !(e === 'delta' && a[i - 1] === 'delta'));

    // --- happy path: Split ---
    {
      const env = mkEnv();
      const log = script({
        anth: (n) => (n % 2 === 1 ? sseResp(toolUseEvents([placeUse('toolu_0' + n, 'Split')])) : sseResp(plain('U Splitu je 17 °C.'))),
      });
      const { r, evs } = await ask(env, 'Kakvo je vrijeme u Splitu?');
      eq(r.status, 200, 'tool: ask 200');
      eq(kinds(evs), ['meta', 'tool', 'toolres', 'delta', 'done'], 'tool: events meta, tool, toolres, delta, done');
      eq(evs[1].data, { place: 'Split' }, 'tool: tool event carries the place');
      eq(evs[2].data, { place: 'Split', ok: true, name: 'Split', lat: 43.5081, lon: 16.4402, tz: 'Europe/Zagreb' }, 'tool: toolres payload');
      eq(evs.filter((e) => e.event === 'delta').map((d) => d.data.t).join(''), 'U Splitu je 17 °C.', 'tool: final answer relayed');
      const done = evs[evs.length - 1].data;
      eq(done, { in: 220, out: 37, cached: 80, places: [{ name: 'Split', lat: 43.5081, lon: 16.4402 }], calls: 2 }, 'tool: done sums usage over both calls, lists places, calls:2');
      eq(log.anth.length, 2, 'tool: two Anthropic calls');
      // first request declares the tool
      const b1 = log.anth[0];
      eq(b1.tools.length, 1, 'tool: one tool declared');
      eq(b1.tools[0].name, 'get_forecast', 'tool: tool name');
      eq(b1.tools[0].input_schema, { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] }, 'tool: input_schema');
      ok(b1.tools[0].description.startsWith('Forecast for a place OTHER than the one in DATA.'), 'tool: description');
      ok(b1.system[0].text.includes('call get_forecast for it and answer from the tool result; say which place you answered for.'), 'tool: RULES mention get_forecast');
      ok(!('tool_choice' in b1), 'tool: first call lets the model choose');
      // second request replays the assistant tool_use and the user tool_result
      const b2 = log.anth[1];
      eq(b2.messages.length, 3, 'tool: second call has 3 messages');
      eq(b2.messages[0], { role: 'user', content: 'Kakvo je vrijeme u Splitu?' }, 'tool: original question kept');
      eq(b2.messages[1], { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_forecast', input: { place: 'Split' } }] }, 'tool: assistant tool_use block replayed with parsed input');
      eq(b2.messages[2].role, 'user', 'tool: tool_result is a user message');
      eq(b2.messages[2].content.length, 1, 'tool: one tool_result');
      const tr = b2.messages[2].content[0];
      eq([tr.type, tr.tool_use_id, 'is_error' in tr], ['tool_result', 'toolu_01', false], 'tool: tool_result shape');
      const brief = JSON.parse(tr.content);
      eq([brief.place, brief.country, brief.tz, brief.now_local], ['Split', 'Hrvatska', 'Europe/Zagreb', '2026-10-18T16:00'], 'tool: brief identifies the place');
      ok(tr.content.length <= 6000, 'tool: brief is at most 6000 chars (' + tr.content.length + ')');
      eq(brief.hourly.length, 48, 'tool: 48 hourly rows');
      eq(brief.daily.length, 7, 'tool: 7 daily rows');
      eq(brief.hourly[0].length, 10, 'tool: hourly rows have 10 fields');
      eq(brief.daily[0].length, 10, 'tool: daily rows have 10 fields');
      eq(brief.hourly[0][0], '10-18 16', 'tool: hourly starts at the current hour (local)');
      ok(typeof brief.hourly_legend === 'string' && /thunderstorm/.test(brief.hourly_legend) && typeof brief.daily_legend === 'string', 'tool: legends present');
      ok(brief.hourly.every((row) => typeof row[8] === 'string') && brief.daily.every((row) => typeof row[6] === 'string'), 'tool: sky is a word');
      ok(brief.daily.every((row) => /^\d\d:\d\d$/.test(row[7]) && /^\d\d:\d\d$/.test(row[8])), 'tool: sunrise/sunset HH:MM');
      eq(brief.now, { t: 17.3, fl: 16.1, rh: 61, w: 12, g: 26, mm: 0, wc: 'partly cloudy' }, 'tool: now block rounded');
      // system blocks and tools unchanged on the second call
      eq(b2.system, b1.system, 'tool: same system blocks (cache_control kept) on call 2');
      eq(b2.tools, b1.tools, 'tool: same tools on call 2');
      eq(b2.system[0].cache_control, { type: 'ephemeral' }, 'tool: cache_control on call 2');
      ok(!('tool_choice' in b2), 'tool: second call still free');
      // external fetches
      eq(log.geo.length, 1, 'tool: one geocoding fetch');
      eq(log.geo[0].url, 'https://geocoding-api.open-meteo.com/v1/search?name=Split&count=1&language=hr', 'tool: geocoding URL');
      eq(log.fc.length, 1, 'tool: one forecast fetch');
      ok(log.fc[0].url.startsWith('https://api.open-meteo.com/v1/forecast?latitude=43.5081&longitude=16.4402&timezone=auto&forecast_days=7&current=temperature_2m,'), 'tool: forecast URL');
      ok(/&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,uv_index,weather_code,is_day&daily=temperature_2m_max,.*uv_index_max$/.test(log.fc[0].url), 'tool: forecast hourly and daily fields');
      ok(!JSON.stringify(log.geo[0].init.headers || {}).includes('Split') && !JSON.stringify(log.fc[0].init.headers || {}).includes('Split'), 'tool: place never in a header');
      // quota: one hit for the whole request
      await drain();
      const st = await tstate(env, cookieVal(cookieOf(r, 'wd_vid')));
      eq(st.used, 1, 'tool: quota hit once for a two-call request');
      // cache hit: same place again does not touch the network
      const again = await ask(env, 'A sutra u Splitu?', {}, { cookie: cookieVal(cookieOf(r, 'wd_vid')) });
      eq(again.evs[again.evs.length - 1].data.places, [{ name: 'Split', lat: 43.5081, lon: 16.4402 }], 'cache: second request still reports the place');
      eq([log.geo.length, log.fc.length], [1, 1], 'cache: no new geocoding/forecast fetch within 10 minutes');
      eq(log.anth.length, 4, 'cache: the model was still called twice more');
      // expiry: after 10 minutes the brief is fetched again
      const realNow = Date.now;
      Date.now = () => realNow() + 11 * 60 * 1000;
      try {
        await ask(env, 'Opet Split?');
      } finally {
        Date.now = realNow;
      }
      eq([log.geo.length, log.fc.length], [2, 2], 'cache: expired after 10 minutes, fetched again');
    }

    // --- URL encoding of an awkward place name, and case-insensitive cache key ---
    {
      const env = mkEnv();
      const log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_h', 'Hvar (otok) & co?')])) : sseResp(plain('Hvar.'))),
        geo: () => geoHit('Hvar', 43.17, 16.44),
      });
      const { evs } = await ask(env, 'Hvar?', { lang: 'en' });
      eq(log.geo[0].url, 'https://geocoding-api.open-meteo.com/v1/search?name=Hvar%20(otok)%20%26%20co%3F&count=1&language=en', 'encoding: place URL-encoded, language=en for an English question');
      eq(evs.find((e) => e.event === 'toolres').data.place, 'Hvar (otok) & co?', 'encoding: toolres echoes the place as asked');
      // same name in other case: cache hit
      script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_h2', 'HVAR (OTOK) & CO?')])) : sseResp(plain('Hvar.'))),
        geo: () => {
          throw new Error('geocoding must not be called');
        },
      });
      const { evs: e2 } = await ask(env, 'Hvar?');
      eq(e2.find((e) => e.event === 'toolres').data.ok, true, 'cache: key is the lower-cased place');
    }

    // --- place not found: toolres ok:false, the model still finishes ---
    {
      const env = mkEnv();
      const log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_nf', 'Zzzzville')])) : sseResp(plain('Nisam našao to mjesto.'))),
        geo: () => jsonResp({ generationtime_ms: 0.5 }),
      });
      const { r, evs } = await ask(env, 'Vrijeme u Zzzzvilleu?');
      eq(kinds(evs), ['meta', 'tool', 'toolres', 'delta', 'done'], 'not found: still ends with done');
      eq(evs[2].data, { place: 'Zzzzville', ok: false, reason: 'not_found' }, 'not found: toolres reason');
      eq(evs[evs.length - 1].data.places, [], 'not found: places empty');
      eq(evs[evs.length - 1].data.calls, 2, 'not found: calls 2');
      const tr = log.anth[1].messages[2].content[0];
      eq([tr.tool_use_id, tr.is_error, typeof tr.content], ['toolu_nf', true, 'string'], 'not found: tool_result is an error');
      eq(log.fc.length, 0, 'not found: no forecast fetch');
      void r;
    }

    // --- geocoding timeout and forecast failure -> fetch_failed ---
    {
      const env = mkEnv({ ASK_LOOKUP_TIMEOUT_MS: '40' });
      let log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_to', 'Slowtown')])) : sseResp(plain('Ne mogu dohvatiti.'))),
        geo: (u, init) => hang(init),
      });
      let { evs } = await ask(env, 'Vrijeme u Slowtownu?');
      eq(evs[2].data, { place: 'Slowtown', ok: false, reason: 'fetch_failed' }, 'timeout: geocoding timeout -> fetch_failed');
      eq(kinds(evs), ['meta', 'tool', 'toolres', 'delta', 'done'], 'timeout: request still finishes');
      eq(log.anth[1].messages[2].content[0].is_error, true, 'timeout: tool_result is an error');
      // forecast times out
      log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_to2', 'Slowcast')])) : sseResp(plain('Ne mogu.'))),
        geo: () => geoHit('Slowcast', 45, 16),
        fc: (u, init) => hang(init),
      });
      evs = (await ask(env, 'Vrijeme u Slowcastu?')).evs;
      eq(evs[2].data, { place: 'Slowcast', ok: false, reason: 'fetch_failed' }, 'timeout: forecast timeout -> fetch_failed');
      // forecast HTTP 500
      log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_5', 'Brokenburg')])) : sseResp(plain('Ne mogu.'))),
        geo: () => geoHit('Brokenburg', 45, 16),
        fc: () => new Response('boom', { status: 500 }),
      });
      evs = (await ask(env, 'Vrijeme u Brokenburgu?')).evs;
      eq(evs[2].data, { place: 'Brokenburg', ok: false, reason: 'fetch_failed' }, 'fetch_failed: forecast HTTP 500');
      // geocoding network error
      log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_6', 'Netless')])) : sseResp(plain('Ne mogu.'))),
        geo: () => {
          throw new TypeError('network down');
        },
      });
      evs = (await ask(env, 'Vrijeme u Netlessu?')).evs;
      eq(evs[2].data, { place: 'Netless', ok: false, reason: 'fetch_failed' }, 'fetch_failed: geocoding network error');
      void log;
    }

    // --- two places in one round (compare), de-duplicated places list ---
    {
      const env = mkEnv();
      const log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('toolu_a', 'Rijeka'), placeUse('toolu_b', 'Osijek')], { text: 'Provjeravam. ' })) : sseResp(plain('Rijeka je toplija.'))),
        geo: (u) => (u.includes('name=Rijeka') ? geoHit('Rijeka', 45.33, 14.44) : geoHit('Osijek', 45.55, 18.69)),
      });
      const { evs } = await ask(env, 'Gdje je toplije, Rijeka ili Osijek?');
      eq(kinds(evs), ['meta', 'delta', 'tool', 'tool', 'toolres', 'toolres', 'delta', 'done'], 'compare: events meta, delta, tool x2, toolres x2, delta, done');
      eq(evs.filter((e) => e.event === 'tool').map((e) => e.data.place), ['Rijeka', 'Osijek'], 'compare: two tool events');
      eq(evs.filter((e) => e.event === 'toolres').map((e) => e.data.name), ['Rijeka', 'Osijek'], 'compare: two toolres events');
      const iFirstToolres = evs.findIndex((e) => e.event === 'toolres');
      ok(evs.filter((e, i) => e.event === 'tool' && i > iFirstToolres).length === 0, 'compare: both tool events precede the lookups');
      eq(evs[evs.length - 1].data.places.map((p) => p.name), ['Rijeka', 'Osijek'], 'compare: both places in done');
      const m = log.anth[1].messages;
      eq(m[1].content.map((b) => b.type), ['text', 'tool_use', 'tool_use'], 'compare: assistant message keeps text + both tool_use blocks');
      eq(m[1].content[0], { type: 'text', text: 'Provjeravam. ' }, 'compare: assistant text block kept');
      eq(m[2].content.map((b) => b.tool_use_id), ['toolu_a', 'toolu_b'], 'compare: one tool_result per tool_use, in order');
      eq(JSON.parse(m[2].content[1].content).place, 'Osijek', 'compare: second brief is Osijek');
      eq(evs.filter((e) => e.event === 'delta')[0].data.t, 'Provjeravam. ', 'compare: text before the tool call is relayed');
    }

    // --- more than two tool_use blocks in a round: the extras get a "limit" error ---
    {
      const env = mkEnv();
      const log = script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('t1', 'Pula'), placeUse('t2', 'Zadar'), placeUse('t3', 'Sisak')])) : sseResp(plain('ok'))),
        geo: (u) => geoHit(decodeURIComponent(/name=([^&]*)/.exec(u)[1]), 44.5, 15.5),
      });
      const { evs } = await ask(env, 'Pula, Zadar, Sisak?');
      eq(evs.filter((e) => e.event === 'tool').length, 2, 'limit: only two lookups announced');
      eq(log.geo.length, 2, 'limit: only two geocoding fetches');
      const res = log.anth[1].messages[2].content;
      eq(res.length, 3, 'limit: every tool_use still gets a tool_result');
      eq([res[2].tool_use_id, res[2].is_error, res[2].content], ['t3', true, 'limit'], 'limit: third tool answered with a limit error');
    }

    // --- 2-round cap: a model that keeps asking is stopped at 3 calls ---
    {
      const env = mkEnv();
      let n = 0;
      const log = script({
        anth: () => sseResp(toolUseEvents([placeUse('loop' + ++n, 'Loopville' + n)], { text: 'Hm. ' })),
        geo: (u) => geoHit(decodeURIComponent(/name=([^&]*)/.exec(u)[1]), 40 + n, 10 + n),
      });
      const { r, evs } = await ask(env, 'Beskonačno?');
      eq(r.status, 200, 'cap: request answered');
      eq(log.anth.length, 3, 'cap: at most 3 Anthropic calls');
      eq(evs.filter((e) => e.event === 'tool').length, 2, 'cap: only two tool rounds executed');
      ok(!('tool_choice' in log.anth[0]) && !('tool_choice' in log.anth[1]), 'cap: calls 1 and 2 may use tools');
      eq(log.anth[2].tool_choice, { type: 'none' }, 'cap: the last call is told not to use tools');
      eq(log.anth[2].tools.length, 1, 'cap: tools still declared on the last call (history has tool_use)');
      const last = evs[evs.length - 1];
      eq(last.event, 'done', 'cap: ends with done, not an error');
      eq(last.data.calls, 3, 'cap: done.calls is 3');
      eq(last.data.places.length, 2, 'cap: two places looked up');
      eq(last.data.in, 300, 'cap: usage summed over 3 calls');
      const st = await tstate(env, cookieVal(cookieOf(r, 'wd_vid')));
      eq(st.used, 1, 'cap: still one quota hit');
    }

    // --- bad tool arguments / unknown tool: error results, no lookups ---
    {
      const env = mkEnv();
      const log = script({
        anth: (n) =>
          n === 1
            ? sseResp(toolUseEvents([{ id: 'b1', json: ['{"place": '] }, { id: 'b2', name: 'delete_all', json: ['{}'] }]))
            : sseResp(plain('ok')),
      });
      const { evs } = await ask(env, 'Loš alat?');
      eq(kinds(evs), ['meta', 'delta', 'done'], 'bad args: no tool events for unusable calls');
      eq(log.geo.length, 0, 'bad args: no network lookups');
      const res = log.anth[1].messages[2].content;
      eq(res.map((x) => [x.tool_use_id, x.is_error]), [['b1', true], ['b2', true]], 'bad args: both answered with errors');
      eq(log.anth[1].messages[1].content[0].input, {}, 'bad args: unparsable arguments replayed as {}');
    }

    // --- plain answers are unchanged: no tool use, calls 1, places [] ---
    {
      const env = mkEnv();
      const log = script({ anth: () => sseResp(plain('Sutra je 24 °C.')) });
      const { evs } = await ask(env, 'Sutra?');
      eq(kinds(evs), ['meta', 'delta', 'done'], 'plain: meta, delta, done');
      eq(evs[evs.length - 1].data, { in: 120, out: 17, cached: 80, places: [], calls: 1 }, 'plain: done has empty places and calls:1');
      eq(log.anth.length, 1, 'plain: one Anthropic call');
    }

    // --- failure of a later Anthropic call: error event, hit not refunded ---
    {
      const env = mkEnv();
      script({ anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('e1', 'Split')])) : new Response('{"error":{}}', { status: 529 })) });
      const { r, evs } = await ask(env, 'Split?');
      eq(r.status, 200, 'late failure: SSE already started');
      const last = evs[evs.length - 1];
      eq([last.event, last.data.code], ['error', 'upstream'], 'late failure: error event');
      const st = await tstate(env, cookieVal(cookieOf(r, 'wd_vid')));
      eq(st.used, 1, 'late failure: the hit stays counted');
      // stream error event during the second call
      script({
        anth: (n) => (n === 1 ? sseResp(toolUseEvents([placeUse('e2', 'Split')])) : sseResp([msgStart(10, 1), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])),
      });
      const o = await ask(env, 'Split?');
      const l2 = o.evs[o.evs.length - 1];
      eq([l2.event, l2.data.code], ['error', 'overloaded_error'], 'late failure: upstream error event of call 2 relayed');
    }

    // --- request budget: a hanging second call ends with a timeout error ---
    {
      const env = mkEnv({ ASK_TIMEOUT_MS: '120' });
      script({ anth: (n, b, init) => (n === 1 ? sseResp(toolUseEvents([placeUse('h1', 'Split')])) : hang(init)) });
      const { evs } = await ask(env, 'Split?');
      const last = evs[evs.length - 1];
      eq([last.event, last.data.code], ['error', 'timeout'], 'budget: whole-request timeout covers the second call');
    }

    // --- brief cache is bounded to 50 entries ---
    {
      const env = mkEnv({ ASK_DAILY: '1000', ASK_DAILY_IP: '1000', ASK_DAILY_GLOBAL: '1000' });
      let turn = 0;
      let who = '';
      const log = script({
        anth: (n) => (n % 2 === 1 ? sseResp(toolUseEvents([placeUse('c' + n, who)])) : sseResp(plain('ok'))),
        geo: () => geoHit(who, 44, 16),
      });
      for (turn = 0; turn < 52; turn++) {
        who = 'Boundtown' + turn;
        await ask(env, 'q' + turn);
      }
      eq(log.geo.length, 52, 'bound: 52 distinct places fetched');
      who = 'Boundtown51';
      await ask(env, 'again');
      eq(log.geo.length, 52, 'bound: the newest entry is still cached');
      who = 'Boundtown0';
      await ask(env, 'again');
      eq(log.geo.length, 53, 'bound: the oldest entry was evicted (cache holds at most 50)');
    }

    installFetch();
    upstreamMode = 'ok';
  }

  /* ---- static checks on the source ---- */
  {
    ok(!/console\.(log|info|warn|error)\([^)]*(\.q\b|ctx|headers|cookie|apikey|ANTHROPIC|authorization)/i.test(src), 'no console call mentions question/context/headers/secrets');
    ok(!/sk-ant-/.test(src), 'no key material in worker.js');
    ok(!/console\.[a-z]+\([^)]*(place|brief|tool_use|input)/i.test(src), 'no console call mentions the looked-up place or brief');
    ok(!/\bimport\s.+from\s/.test(src), 'worker.js has no imports (no dependencies)');
  }

  globalThis.fetch = REAL_FETCH;
  if (fails) {
    console.error(fails + ' of ' + checks + ' checks FAILED');
    process.exit(1);
  }
  console.log('WORKER TESTS OK (' + checks + ' checks)');
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e && e.stack ? e.stack : e);
  process.exit(1);
});
