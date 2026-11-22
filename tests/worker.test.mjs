// Worker の動作確認（外部APIはモック）。実行: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

// Cloudflare の caches.default を最小限に模擬
const store = new Map();
globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
const worker = (await import('../worker/worker.js')).default;

let routes = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: init.headers || {} });
  for (const [prefix, fn] of Object.entries(routes)) if (String(url).startsWith(prefix)) return fn(url, init);
  return new Response('not mocked', { status: 500 });
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const env = { APP_TOKEN: 'tok123', FINNHUB_KEY: 'fk', TWELVEDATA_KEY: 'tk', FRED_KEY: 'frk', ALLOWED_ORIGIN: 'https://is1g60th-beep.github.io' };
const ctx = { waitUntil: p => p };
const call = async (path, headers = { 'X-App-Token': 'tok123', Origin: 'https://is1g60th-beep.github.io' }) => {
  store.clear();
  const r = await worker.fetch(new Request('https://w.example' + path, { headers }), env, ctx);
  return { status: r.status, body: await r.json(), headers: r.headers };
};

test('VIX: Cboeから取得（約15分遅れ）', async () => {
  routes = { 'https://cdn.cboe.com/': () => json({ timestamp: '2026-11-20 16:15:07', data: { symbol: '^VIX', current_price: 29.62, prev_day_close: 25.1, last_trade_time: '2026-11-20T16:14:59' } }) };
  const r = await call('/api/vix');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'Cboe'); assert.equal(r.body.vix, 29.62); assert.equal(r.body.asOf, '2026-11-20T16:14:59');
  assert.ok(Math.abs(r.body.changePct - (29.62 / 25.1 - 1) * 100) < 1e-9);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://is1g60th-beep.github.io');
});

test('VIX: Cboeが失敗・形式変更ならFREDの終値に切り替え', async () => {
  for (const cboe of [() => new Response('', { status: 403 }), () => json({ data: { foo: 1 } })]) {
    routes = {
      'https://cdn.cboe.com/': cboe,
      'https://api.stlouisfed.org/': () => json({ observations: [{ date: '2026-11-20', value: '29.30' }, { date: '2026-11-19', value: '.' }, { date: '2026-11-18', value: '24.10' }] }),
    };
    const r = await call('/api/vix');
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'FRED'); assert.equal(r.body.kind, 'close');
    assert.equal(r.body.vix, 29.3); assert.equal(r.body.asOf, '2026-11-20'); assert.equal(r.body.prevClose, 24.1);
    assert.ok(r.body.cboeError);
  }
});

test('VIX: 両方失敗すると原因つきエラー（CORSヘッダーは付く）', async () => {
  routes = { 'https://cdn.cboe.com/': () => new Response('', { status: 403 }), 'https://api.stlouisfed.org/': () => new Response('', { status: 400 }) };
  const r = await call('/api/vix');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Cboe: HTTP 403/); assert.match(r.body.error, /FRED: HTTP 400/);
  assert.ok(r.headers.get('Access-Control-Allow-Origin'));
});

test('VIX: FRED_KEY未設定でCboe失敗', async () => {
  routes = { 'https://cdn.cboe.com/': () => new Response('', { status: 403 }) };
  store.clear();
  const r = await worker.fetch(new Request('https://w.example/api/vix', { headers: { 'X-App-Token': 'tok123' } }), { ...env, FRED_KEY: undefined }, ctx);
  const b = await r.json();
  assert.equal(r.status, 502); assert.match(b.error, /FRED_KEYも未設定/);
});

test('トークンが違えば401、外部APIは呼ばない', async () => {
  calls.length = 0;
  const r = await call('/api/vix', { 'X-App-Token': 'wrong' });
  assert.equal(r.status, 401); assert.equal(calls.length, 0);
});

test('APIキーはURLに含めずヘッダーで送る（Finnhub・Twelve Data）', async () => {
  routes = {
    'https://finnhub.io/api/v1/stock/market-status': () => json({ isOpen: false, session: null }),
    'https://finnhub.io/api/v1/quote': () => json({ c: 30.88, pc: 45.3, dp: -31.8, t: 1795208400 }),
  };
  calls.length = 0;
  const r = await call('/api/quote');
  assert.equal(r.body.price, 30.88);
  for (const c of calls) { assert.ok(!c.url.includes('fk')); assert.equal(c.headers['X-Finnhub-Token'], 'fk'); }
});
