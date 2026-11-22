/**
 * SOXLナンピン管理 — APIキー中継用 Cloudflare Worker
 *
 * APIキーはWorkerのシークレット(環境変数)にのみ保存し、ブラウザには渡さない。
 *   FINNHUB_KEY     … SOXL株価・米国市場の開場状況（Finnhub 無料: 60回/分）
 *   TWELVEDATA_KEY  … USD/JPY・SOXL週足（Twelve Data 無料: 8回/分・800回/日）
 *   APP_TOKEN       … 必須。アプリ側の「アプリトークン」と同じ値（他人によるAPI枠消費を防止）
 *   ALLOWED_ORIGIN  … 例 https://<ユーザー名>.github.io （カンマ区切りで複数可）
 *
 * エンドポイント:
 *   GET /api/quote   SOXL最新価格  (キャッシュ15秒)
 *   GET /api/fx      USD/JPY       (キャッシュ60秒)
 *   GET /api/weekly  SOXL週足      (キャッシュ1時間)
 *   GET /api/market  相場環境：SPY日足・SOXX週足 (キャッシュ1時間)
 */

const TTL = { quote: 15, fx: 60, weekly: 3600, market: 3600 };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'X-App-Token',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.APP_TOKEN) {
      return json({ error: 'WorkerにAPP_TOKENが設定されていません（他人に利用枠を使われるのを防ぐため必須）' }, 500, cors);
    }
    if (!safeEqual(req.headers.get('X-App-Token') || '', env.APP_TOKEN)) {
      return json({ error: 'トークンが一致しません' }, 401, cors);
    }
    const kind = url.pathname.replace(/^\/api\//, '');
    if (!TTL[kind]) return json({ error: 'not found' }, 404, cors);

    // Worker側キャッシュ（API呼び出し回数制限への対策）
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.internal/${kind}`);
    const hit = await cache.match(cacheKey);
    if (hit && !url.searchParams.has('force')) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, cors);
    }
    try {
      const body = kind === 'quote' ? await getQuote(env) : kind === 'fx' ? await getFx(env) : kind === 'market' ? await getMarket(env) : await getWeekly(env);
      body.fetchedAt = Date.now();
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${TTL[kind]}` },
      })));
      return json(body, 200, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
  },
};

/** 文字列の比較時間から合言葉を推測されないよう、長さに関係なく全体を比較する */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/**
 * APIキーはURLに含めず、リクエストヘッダーで送る（各社のアクセスログ等にキーが残りにくくする）
 *   Finnhub     : X-Finnhub-Token ヘッダー
 *   Twelve Data : Authorization: apikey <キー>
 */
async function getJson(u, headers) {
  const r = await fetch(u, { headers, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`データ提供元の応答エラー（HTTP ${r.status}）`);
  const j = await r.json();
  if (j && (j.status === 'error' || j.code >= 400)) throw new Error('データ提供元のエラー: ' + String(j.message || '').slice(0, 120));
  return j;
}
const finnhub = (env, path) => getJson(`https://finnhub.io/api/v1/${path}`, { 'X-Finnhub-Token': env.FINNHUB_KEY });
const twelve = (env, path) => getJson(`https://api.twelvedata.com/${path}`, { Authorization: `apikey ${env.TWELVEDATA_KEY}` });

async function getQuote(env) {
  let market = { isOpen: false, session: null, holiday: null };
  try {
    const m = await finnhub(env, 'stock/market-status?exchange=US');
    market = { isOpen: !!m.isOpen, session: m.session || null, holiday: m.holiday || null };
  } catch (_) { /* 開場状況が取れなくても価格は返す */ }

  // 1) Finnhub
  if (env.FINNHUB_KEY) {
    try {
      const q = await finnhub(env, 'quote?symbol=SOXL');
      if (q.c > 0) {
        return { source: 'Finnhub', price: q.c, ask: null, bid: null, prevClose: q.pc, changePct: q.dp, ts: q.t * 1000, ...market };
      }
    } catch (_) { /* フォールバックへ */ }
  }
  // 2) Twelve Data（フォールバック）
  const t = await twelve(env, 'quote?symbol=SOXL&prepost=true');
  const ts = (t.last_quote_at || t.timestamp) * 1000;
  return {
    source: 'Twelve Data', price: Number(t.close), ask: null, bid: null, prevClose: Number(t.previous_close),
    changePct: Number(t.percent_change), ts, ...market,
    isOpen: market.session ? market.isOpen : !!t.is_market_open,
    session: market.session || (t.is_market_open ? 'regular' : null),
  };
}

async function getFx(env) {
  const t = await twelve(env, 'quote?symbol=USD/JPY');
  return {
    source: 'Twelve Data', market: Number(t.close),
    ts: (t.last_quote_at || t.timestamp) * 1000,
    marketClosed: t.is_market_open === false,
  };
}

async function getWeekly(env) {
  const t = await twelve(env, 'time_series?symbol=SOXL&interval=1week&outputsize=120&order=ASC');
  const bars = (t.values || []).map(v => ({ date: v.datetime.slice(0, 10), close: Number(v.close) }));
  return { source: 'Twelve Data', bars };
}

/** 相場環境（参考）: S&P500の代わりにSPY日足（高値からの下落率）、SOX指数の代わりにSOXX週足（RSI） */
async function getMarket(env) {
  const bars = t => (t.values || []).map(v => ({ date: v.datetime.slice(0, 10), close: Number(v.close) }));
  const [spy, soxx] = await Promise.allSettled([
    twelve(env, 'time_series?symbol=SPY&interval=1day&outputsize=300&order=ASC'),
    twelve(env, 'time_series?symbol=SOXX&interval=1week&outputsize=120&order=ASC'),
  ]);
  if (spy.status === 'rejected' && soxx.status === 'rejected') throw spy.reason;
  return {
    source: 'Twelve Data',
    spy: spy.status === 'fulfilled' ? bars(spy.value) : null, spyError: spy.status === 'rejected' ? String(spy.reason.message || spy.reason) : null,
    soxx: soxx.status === 'fulfilled' ? bars(soxx.value) : null, soxxError: soxx.status === 'rejected' ? String(soxx.reason.message || soxx.reason) : null,
  };
}
