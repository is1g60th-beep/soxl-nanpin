/**
 * SOXLナンピン管理 — APIキー中継用 Cloudflare Worker
 *
 * APIキーはWorkerのシークレット(環境変数)にのみ保存し、ブラウザには渡さない。
 *   FINNHUB_KEY     … SOXL株価・米国市場の開場状況（Finnhub 無料: 60回/分）
 *   TWELVEDATA_KEY  … USD/JPY・SOXL週足（Twelve Data 無料: 8回/分・800回/日）
 *   APP_TOKEN       … 任意。設定するとアプリ側で同じトークンが必要（他人によるAPI枠消費を防止）
 *   ALLOWED_ORIGIN  … 例 https://<ユーザー名>.github.io （カンマ区切りで複数可）
 *
 * エンドポイント:
 *   GET /api/quote   SOXL最新価格  (キャッシュ15秒)
 *   GET /api/fx      USD/JPY       (キャッシュ60秒)
 *   GET /api/weekly  SOXL週足      (キャッシュ1時間)
 */

const TTL = { quote: 15, fx: 60, weekly: 3600 };

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
    if (env.APP_TOKEN && req.headers.get('X-App-Token') !== env.APP_TOKEN) {
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
      const body = kind === 'quote' ? await getQuote(env) : kind === 'fx' ? await getFx(env) : await getWeekly(env);
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

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function getJson(u) {
  const r = await fetch(u, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j && (j.status === 'error' || j.code >= 400)) throw new Error(j.message || 'APIエラー');
  return j;
}

async function getQuote(env) {
  let market = { isOpen: false, session: null, holiday: null };
  try {
    const m = await getJson(`https://finnhub.io/api/v1/stock/market-status?exchange=US&token=${env.FINNHUB_KEY}`);
    market = { isOpen: !!m.isOpen, session: m.session || null, holiday: m.holiday || null };
  } catch (_) { /* 開場状況が取れなくても価格は返す */ }

  // 1) Finnhub
  if (env.FINNHUB_KEY) {
    try {
      const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=SOXL&token=${env.FINNHUB_KEY}`);
      if (q.c > 0) {
        return { source: 'Finnhub', price: q.c, ask: null, bid: null, prevClose: q.pc, changePct: q.dp, ts: q.t * 1000, ...market };
      }
    } catch (_) { /* フォールバックへ */ }
  }
  // 2) Twelve Data（フォールバック）
  const t = await getJson(`https://api.twelvedata.com/quote?symbol=SOXL&prepost=true&apikey=${env.TWELVEDATA_KEY}`);
  const ts = (t.last_quote_at || t.timestamp) * 1000;
  return {
    source: 'Twelve Data', price: Number(t.close), ask: null, bid: null, prevClose: Number(t.previous_close),
    changePct: Number(t.percent_change), ts, ...market,
    isOpen: market.session ? market.isOpen : !!t.is_market_open,
    session: market.session || (t.is_market_open ? 'regular' : null),
  };
}

async function getFx(env) {
  const t = await getJson(`https://api.twelvedata.com/quote?symbol=USD/JPY&apikey=${env.TWELVEDATA_KEY}`);
  return {
    source: 'Twelve Data', market: Number(t.close),
    ts: (t.last_quote_at || t.timestamp) * 1000,
    marketClosed: t.is_market_open === false,
  };
}

async function getWeekly(env) {
  const t = await getJson(`https://api.twelvedata.com/time_series?symbol=SOXL&interval=1week&outputsize=120&order=ASC&apikey=${env.TWELVEDATA_KEY}`);
  const bars = (t.values || []).map(v => ({ date: v.datetime.slice(0, 10), close: Number(v.close) }));
  return { source: 'Twelve Data', bars };
}
