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
const env = { APP_TOKEN: 'tok123', FINNHUB_KEY: 'fk', TWELVEDATA_KEY: 'tk', FRED_KEY: 'abcdefghijklmnopqrstuvwxyz012345', ALLOWED_ORIGIN: 'https://is1g60th-beep.github.io' };
const ctx = { waitUntil: p => p };
const call = async (path, headers = { 'X-App-Token': 'tok123', Origin: 'https://is1g60th-beep.github.io' }) => {
  store.clear();
  const r = await worker.fetch(new Request('https://w.example' + path, { headers }), env, ctx);
  return { status: r.status, body: await r.json(), headers: r.headers };
};

const FRED_OK = () => json({ observations: [{ date: '2026-11-20', value: '29.30' }, { date: '2026-11-19', value: '.' }, { date: '2026-11-18', value: '24.10' }] });

test('VIX: FREDの終値を取得（欠損日は飛ばす）', async () => {
  routes = { 'https://api.stlouisfed.org/': FRED_OK };
  calls.length = 0;
  const r = await call('/api/vix');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'FRED'); assert.equal(r.body.kind, 'close');
  assert.equal(r.body.vix, 29.3); assert.equal(r.body.asOf, '2026-11-20'); assert.equal(r.body.prevClose, 24.1);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://is1g60th-beep.github.io');
  assert.ok(calls.every(c => !c.url.includes('cboe.com')), 'Cboeは呼ばない');
});

test('VIX: FREDのエラー内容をそのまま表示', async () => {
  routes = { 'https://api.stlouisfed.org/': () => json({ error_code: 400, error_message: 'Bad Request.  The value for variable api_key is not registered.' }, 400) };
  const r = await call('/api/vix');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /FREDのエラー（HTTP 400：Bad Request.+not registered/);
  assert.ok(r.headers.get('Access-Control-Allow-Origin'));
});

test('VIX: FRED_KEYの未設定・形式違いを、FREDに問い合わせる前に知らせる', async () => {
  routes = { 'https://api.stlouisfed.org/': FRED_OK };
  const run = async key => { store.clear(); calls.length = 0; const r = await worker.fetch(new Request('https://w.example/api/vix', { headers: { 'X-App-Token': 'tok123' } }), { ...env, FRED_KEY: key }, ctx); return { body: await r.json(), n: calls.length }; };
  let x = await run(undefined); assert.match(x.body.error, /FRED_KEYが未設定/); assert.equal(x.n, 0);
  x = await run('ABCdef'); assert.match(x.body.error, /現在6文字・大文字を含む/); assert.equal(x.n, 0);
  x = await run('abcdefghijklmnopqrstuvwxyz01234５'); assert.match(x.body.error, /記号や全角文字を含む/);
  // 前後の空白・改行は取り除いて使う
  x = await run(' abcdefghijklmnopqrstuvwxyz012345\n'); assert.equal(x.body.vix, 29.3);
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
