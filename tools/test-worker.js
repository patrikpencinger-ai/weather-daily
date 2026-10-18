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
    eq(last.data, { in: 120, out: 17, cached: 80 }, 'done usage');
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

  /* ---- static checks on the source ---- */
  {
    ok(!/console\.(log|info|warn|error)\([^)]*(\.q\b|ctx|headers|cookie|apikey|ANTHROPIC|authorization)/i.test(src), 'no console call mentions question/context/headers/secrets');
    ok(!/sk-ant-/.test(src), 'no key material in worker.js');
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
