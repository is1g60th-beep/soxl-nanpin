/* SOXLナンピン管理 — 画面・データ取得・保存 */
(() => {
  'use strict';
  const C = window.Core;
  const KEY = 'soxl-nanpin-v1';
  const SNAP_KEY = 'soxl-nanpin-snapshots';
  const $ = (s, el = document) => el.querySelector(s);
  const main = $('#main');
  const dlg = $('#dlg');

  // ================= 保存 =================
  function blankState() {
    return {
      version: 1, settings: C.defaultSettings(), entries: [], touches: [], touchFlags: {},
      notifs: [], notifKeys: {}, audit: [],
      manual: { price: null, priceAt: null, applied: null, appliedAt: null, market: null, marketAt: null, rsi: null, rsiAt: null },
      cache: { quote: null, fx: null, weekly: null, market: null },
      envManual: { vix: null, vixAt: null, zbt: null, zbtFired: false, zbtAt: null, divergence: null, divAt: null },
      checklist: { week: null, items: {} },
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blankState();
      const st = JSON.parse(raw);
      const b = blankState();
      return { ...b, ...C.sanitizeState(st), manual: sanitizeManual(st.manual), cache: { ...b.cache, ...(st.cache && typeof st.cache === 'object' ? st.cache : {}) } };
    } catch (e) {
      alert('保存データの読み込みに失敗しました。バックアップから復元してください。\n' + e.message);
      return blankState();
    }
  }
  function sanitizeManual(m) {
    const b = blankState().manual;
    if (!m || typeof m !== 'object') return b;
    const out = {};
    for (const k of Object.keys(b)) { const v = m[k]; out[k] = typeof v === 'number' && isFinite(v) ? v : null; }
    return out;
  }
  /** 外部データで置き換えるとき、中継URLとトークンは端末の現在値を維持（偽の中継先に差し替えられるのを防ぐ） */
  function adoptState(raw, keepCache) {
    const clean = C.sanitizeState(raw);
    clean.settings.workerUrl = S.settings.workerUrl;
    clean.settings.appToken = S.settings.appToken;
    return { ...blankState(), ...clean, cache: keepCache ? S.cache : blankState().cache };
  }
  let S = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('保存に失敗しました: ' + e.message); }
  }
  function snapshot(reason) {
    try {
      const list = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
      list.unshift({ at: new Date().toISOString(), reason, data: C.exportState(S) });
      localStorage.setItem(SNAP_KEY, JSON.stringify(list.slice(0, 10)));
    } catch (_) { /* 容量不足時はスキップ */ }
  }
  function audit(action, detail) {
    S.audit.unshift({ at: new Date().toISOString(), action, detail: C.stripSecrets(detail) });
    S.audit = S.audit.slice(0, 300);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ================= 書式 =================
  const nf0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
  const yen = n => n == null || !isFinite(n) ? '—' : nf0.format(Math.round(n)) + '円';
  const usd = (n, d = 2) => n == null || !isFinite(n) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (n, d = 2) => n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jst = ms => {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const todayJst = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  function nowNyIso() {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
  }
  const badge = (code, label) => `<span class="badge b-${code}">${esc(label)}</span>`;

  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  // ================= データ取得 =================
  const live = { loading: {}, errors: {} };
  async function api(kind, force) {
    const base = (S.settings.workerUrl || '').replace(/\/$/, '');
    if (!base) throw new Error('API中継URLが未設定です（設定画面）');
    const tok = S.settings.appToken || '';
    if (tok && !/^[\x21-\x7E]+$/.test(tok)) throw new Error('アプリトークンに全角文字・空白・改行が含まれています。半角英数字と記号だけにしてください');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(`${base}/api/${kind}${force ? '?force=1' : ''}`, {
        headers: S.settings.appToken ? { 'X-App-Token': S.settings.appToken } : {}, signal: ctl.signal, cache: 'no-store',
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404 && kind === 'market') throw new Error('Workerが古い版です。最新の worker.js をCloudflareに貼り直してください');
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('タイムアウト（Workerから応答がありません）');
      if (e.name === 'TypeError') throw new Error('Workerに接続できません。①URLの誤り ②Workerのコードが未反映（Hello Worldのまま） ③ALLOWED_ORIGINの不一致 のいずれかです');
      throw e;
    } finally { clearTimeout(t); }
  }
  async function refresh(kind, force) {
    if (live.loading[kind]) return;
    live.loading[kind] = true; renderHeader();
    try {
      const j = await api(kind, force);
      S.cache[kind] = j; live.errors[kind] = null;
    } catch (e) {
      live.errors[kind] = e.message;
    } finally {
      live.loading[kind] = false;
      save(); tick();
    }
  }
  function refreshAll(force) {
    if (!S.settings.workerUrl) { toast('API中継URLが未設定のため、手入力の値で計算します'); tick(); return; }
    refresh('quote', force); refresh('fx', force);
    const w = S.cache.weekly;
    if (force || !w || Date.now() - (w.fetchedAt || 0) > S.settings.refreshMinRsi * 60000) refresh('weekly', force);
    const mk = S.cache.market;
    if (force || !mk || Date.now() - (mk.fetchedAt || 0) > S.settings.refreshMinRsi * 60000) refresh('market', force);
  }
  let timers = [];
  function schedule() {
    timers.forEach(clearInterval); timers = [];
    if (!S.settings.workerUrl) return;
    const s = S.settings;
    timers.push(setInterval(() => !document.hidden && refresh('quote'), Math.max(10, s.refreshSecQuote) * 1000));
    timers.push(setInterval(() => !document.hidden && refresh('fx'), Math.max(30, s.refreshSecFx) * 1000));
    timers.push(setInterval(() => !document.hidden && refresh('weekly'), Math.max(15, s.refreshMinRsi) * 60000));
    timers.push(setInterval(() => !document.hidden && refresh('market'), Math.max(15, s.refreshMinRsi) * 60000));
    timers.push(setInterval(() => !document.hidden && tick(), 15000)); // 鮮度表示の更新
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(false); });

  // ================= 現在値の組み立て =================
  const MANUAL_EXPIRE_MIN = 120;
  function current() {
    const s = S.settings, now = Date.now(), m = S.manual;
    // --- 株価 ---
    let price = { value: null, usable: false, code: 'error', label: '未取得', at: null, source: '' };
    const q = S.cache.quote;
    const qf = C.quoteFreshness(live.errors.quote ? { error: live.errors.quote } : q, now, s);
    const manualPriceOk = m.price > 0 && (now - m.priceAt) / 60000 <= MANUAL_EXPIRE_MIN;
    if (manualPriceOk) {
      price = { value: m.price, usable: true, code: 'manual', label: '手入力', at: m.priceAt, source: '手入力' };
    } else if (q && q.price > 0) {
      const v = s.useAskIfAvailable && q.ask > 0 ? q.ask : q.price;
      price = { value: v, usable: qf.usable, code: qf.code, label: qf.label, at: q.ts, source: q.source + (q.ask > 0 && s.useAskIfAvailable ? '（売気配）' : ''), reason: qf.reason, session: q.session, prevClose: q.prevClose, changePct: q.changePct, holiday: q.holiday };
      if (live.errors.quote) { price.usable = false; price.code = 'error'; price.label = 'エラー'; price.reason = live.errors.quote; }
    } else if (live.errors.quote) {
      price.reason = live.errors.quote;
    }
    // --- 為替 ---
    const f = S.cache.fx;
    const ff = C.fxFreshness(live.errors.fx ? { error: live.errors.fx } : f, now, s);
    const manualMarketOk = m.market > 0 && (now - m.marketAt) / 60000 <= MANUAL_EXPIRE_MIN;
    const manualAppliedOk = m.applied > 0 && (now - m.appliedAt) / 60000 <= MANUAL_EXPIRE_MIN;
    let fx = { market: null, applied: manualAppliedOk ? m.applied : null, appliedAt: m.appliedAt, code: 'error', label: '未取得', at: null, usable: false };
    if (manualMarketOk) Object.assign(fx, { market: m.market, code: 'manual', label: '手入力', at: m.marketAt, usable: true });
    else if (f && f.market > 0) Object.assign(fx, { market: f.market, code: ff.code, label: ff.label, at: f.ts, usable: ff.usable, reason: ff.reason, source: f.source });
    else if (live.errors.fx) fx.reason = live.errors.fx;
    const fxForCalc = { market: fx.usable ? (manualMarketOk ? m.market : f && f.market) : null, applied: fx.applied };
    const fxUsable = fxForCalc.applied > 0 || fxForCalc.market > 0;
    // --- RSI ---
    let rsi = { confirmed: null, provisional: null, at: null, code: 'error', label: '未取得' };
    if (m.rsi != null && m.rsiAt) {
      rsi = { confirmed: m.rsi, provisional: null, at: m.rsiAt, code: 'manual', label: '手入力' };
    } else if (S.cache.weekly && S.cache.weekly.bars && S.cache.weekly.bars.length) {
      const w = C.weeklyRsi(S.cache.weekly.bars, s.rsiPeriod, nowNyIso());
      rsi = { ...w, at: S.cache.weekly.fetchedAt, code: live.errors.weekly ? 'stale' : 'live', label: live.errors.weekly ? '取得失敗・前回値' : '自動', lastClose: S.cache.weekly.bars.at(-1).close };
    } else if (live.errors.weekly) rsi.reason = live.errors.weekly;

    const ps = C.planStatus(S, s);
    const cond = C.evaluateCondition(S, s, price.usable ? price.value : null, rsi);
    const disp = cond.done ? null : C.displayCondition(S, s, cond);
    let calc = null, calcBlocked = null;
    if (ps.done) calcBlocked = '全5回の購入計画が完了しています';
    else if (!price.usable) calcBlocked = '株価が利用できないため計算を停止しています' + (price.reason ? `（${price.reason}）` : '');
    else if (!fxUsable) calcBlocked = '為替レートが利用できないため計算を停止しています' + (fx.reason ? `（${fx.reason}）` : '');
    else calc = C.maxShares(ps.available, price.value, fxForCalc, s);
    // --- 相場環境（参考） ---
    const mk = S.cache.market || {};
    const spDdInfo = mk.spy ? C.drawdownFromHigh(mk.spy) : null;
    const semi = mk.soxx && mk.soxx.length ? C.weeklyRsi(mk.soxx, s.rsiPeriod, nowNyIso()) : null;
    const em = S.envManual;
    const env = {
      spDdInfo, semi, fetchedAt: mk.fetchedAt || null, error: live.errors.market || mk.spyError || mk.soxxError || null,
      signals: C.marketSignals({ soxlRsi: rsi.confirmed, semiRsi: semi ? semi.confirmed : null, spDd: spDdInfo ? spDdInfo.dd : null,
        vix: em.vix, zbt: em.zbt, zbtFired: em.zbtFired, divergence: em.divergence }, s),
    };
    return { price, fx, fxForCalc, rsi, ps, cond, disp, calc, calcBlocked, env };
  }

  // ================= 通知 =================
  function notify(key, title, body, cooldownMin = 0) {
    const last = S.notifKeys[key];
    if (last && (cooldownMin === 0 || Date.now() - last < cooldownMin * 60000)) return;
    S.notifKeys[key] = Date.now();
    S.notifs.unshift({ at: Date.now(), title, body });
    S.notifs = S.notifs.slice(0, 100);
    toast(title);
    if ('Notification' in window && Notification.permission === 'granted') {
      const opt = { body, tag: key, icon: 'icon.svg' };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(r => r.showNotification(title, opt)).catch(() => {});
      else try { new Notification(title, opt); } catch (_) {}
    }
  }
  function processEvents(cur) {
    const { cond, price, calc, ps, rsi } = cur;
    if (!cond.done && (cond.type === 'rsi' ? cond.rsi != null : price.usable)) {
      const u = C.updateTouchHistory(S, cond, Date.now(), price.value);
      S.touches = u.state.touches; S.touchFlags = u.state.touchFlags;
      if (u.event) {
        const st = S.settings.stages[cond.stage];
        if (cond.type === 'rsi') notify(`touch-${cond.stage}-${u.event.at}`, `${st.name}：週足RSI ${num(rsi.confirmed, 1)}（${S.settings.rsiThreshold}以下）`, `初回購入条件に到達。投入可能額 ${yen(ps.available)}${calc ? ` / 購入可能 ${calc.shares}株` : ''}`);
        else notify(`touch-${cond.stage}-${u.event.at}`, `${st.name}：目標価格 ${usd(cond.target, 3)} に到達`, `現在 ${usd(price.value)}（基準 ${usd(cond.ref)} から -${pct(cond.dropNow)}）投入可能額 ${yen(ps.available)}${calc ? ` / ${calc.shares}株・総額 ${yen(calc.totalYen)}` : ''}`);
      }
    }
    if (S.settings.workerUrl) {
      if (live.errors.quote) notify('quote-err', '株価の取得に失敗しました', live.errors.quote, 30);
      if (live.errors.fx) notify('fx-err', '為替レートの取得に失敗しました', live.errors.fx, 30);
      if (price.code === 'stale') notify('quote-stale', '株価が更新されていません', price.reason || '', 30);
      if (cur.fx.code === 'stale') notify('fx-stale', '為替レートが更新されていません', cur.fx.reason || '', 30);
    }
    if (calc && calc.shares === 0 && ps.available > 0) notify(`zero-${ps.nextStage}`, '購入可能株数が0株です', `投入可能額 ${yen(ps.available)} では手数料込みで1株も購入できません`, 24 * 60);
  }

  // ================= 画面 =================
  let tab = 'home';
  let lastCur = null;
  function tick() {
    const cur = current();
    processEvents(cur);
    save();
    lastCur = cur;
    renderHeader();
    if (tab === 'home') renderHome(cur);
    else if (tab === 'funds') renderFunds(cur);
  }
  function renderHeader() {
    const loading = Object.values(live.loading).some(Boolean);
    $('#hdrStatus').textContent = loading ? '更新中…' : (S.settings.workerUrl ? '' : '手入力モード');
  }
  function setTab(t) {
    tab = t;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    window.scrollTo(0, 0);
    if (t === 'home') renderHome(lastCur || current());
    if (t === 'history') renderHistory();
    if (t === 'funds') renderFunds(lastCur || current());
    if (t === 'settings') renderSettings();
  }
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#btnRefresh').addEventListener('click', () => refreshAll(true));

  function stageStrip(ps) {
    const entries = C.activeEntries(S);
    return `<div class="stagelist">${S.settings.stages.map((st, i) => {
      const e = entries[i];
      const cls = e ? (e.kind === 'buy' ? 'done' : 'skip') : (i === ps.nextStage ? 'cur' : '');
      return `<span class="${cls}">${esc(st.name.split(' ')[0])}<br>${e ? (e.kind === 'buy' ? '購入済' : '見送り') : (i === ps.nextStage ? '監視中' : '未')}</span>`;
    }).join('')}</div>`;
  }

  function renderHome(cur) {
    const { price, fx, rsi, ps, cond, disp, calc, calcBlocked } = cur;
    const s = S.settings;
    const alerts = [];
    if (!s.workerUrl) alerts.push(`<div class="alert info">API中継URLが未設定です。株価・為替は「手入力」ボタンから入力してください（設定画面で自動取得を有効化できます）。</div>`);
    if (price.code === 'error' && price.reason && s.workerUrl) alerts.push(`<div class="alert err">株価取得エラー：${esc(price.reason)}</div>`);
    if (price.code === 'stale') alerts.push(`<div class="alert err">${esc(price.reason)}。この価格では計算しません。</div>`);
    if (fx.code === 'error' && fx.reason && s.workerUrl) alerts.push(`<div class="alert err">為替取得エラー：${esc(fx.reason)}</div>`);

    // 状態カード
    let statusHtml;
    if (cond.done) {
      statusHtml = `<div class="status"><div class="label">購入計画 完了</div><div class="sub">全${s.stages.length}回の段階が終了しました。残予算 ${yen(ps.remainingBudget)}</div>${stageStrip(ps)}</div>`;
    } else if (cond.type === 'rsi') {
      const met = cond.met;
      statusHtml = `<div class="status ${met ? 'hit' : ''}">
        <div class="sub">現在の購入回</div>
        <div class="label">${esc(ps.stage.name)}　${met ? '購入条件 到達' : '条件 未達'}</div>
        <div class="rows" style="margin-top:8px">
          <dt>確定週足RSI(${s.rsiPeriod})</dt><dd class="strong">${num(rsi.confirmed, 2)} ${badge(rsi.code, rsi.label)}</dd>
          <dt>暫定週足RSI（形成中）</dt><dd>${rsi.provisional != null ? num(rsi.provisional, 2) : '—'}</dd>
          <dt>購入条件</dt><dd>確定RSI ≤ ${s.rsiThreshold}</dd>
          <dt>RSI更新</dt><dd>${jst(rsi.at)}</dd>
        </div>
        ${!met && cond.provisionalMet ? `<div class="alert warn" style="margin-top:10px">暫定RSIは${s.rsiThreshold}以下ですが、週足が確定していません。</div>` : ''}
        ${!met ? `<div class="note">条件未達でも下の購入計算は参考として表示しています。</div>` : ''}
        ${stageStrip(ps)}</div>`;
    } else {
      const met = disp.reached;
      const rebound = !cond.met && disp.touched;
      const near = !met && cond.remainingPct != null && cond.remainingPct < 0.02;
      const prog = cond.dropNow != null ? Math.max(0, Math.min(1, cond.dropNow / s.stages[cond.stage].drop)) : 0;
      statusHtml = `<div class="status ${met ? 'hit' : near ? 'near' : ''}">
        <div class="sub">現在の購入回</div>
        <div class="label">${esc(ps.stage.name)}　${met ? (cond.met ? '購入条件 到達' : '到達済み（現在は反発）') : rebound ? '未達（一度到達→反発）' : '条件 未達'}</div>
        <div class="rows" style="margin-top:8px">
          <dt>直前の約定価格（基準）</dt><dd>${usd(cond.ref, 4)}</dd>
          <dt>目標価格（-${(s.stages[cond.stage].drop * 100).toFixed(1)}%）</dt><dd class="strong">${usd(cond.target, 4)}</dd>
          <dt>現在の下落率</dt><dd>${cond.dropNow != null ? (cond.dropNow >= 0 ? '-' : '+') + pct(Math.abs(cond.dropNow)) : '—'}</dd>
          <dt>目標までの残り下落率</dt><dd>${cond.remainingPct != null ? (cond.remainingPct > 0 ? pct(cond.remainingPct) : '到達') : '—'}</dd>
        </div>
        <div class="bar"><i style="width:${(prog * 100).toFixed(1)}%;${met ? 'background:var(--hit)' : ''}"></i></div>
        ${stageStrip(ps)}</div>`;
    }

    const changeTxt = price.changePct != null && price.code !== 'manual' ? `<span class="sub">${price.changePct >= 0 ? '+' : ''}${num(price.changePct, 2)}%</span>` : '';
    const marketCard = `<div class="card"><div class="grid2">
      <div><h2>SOXL ${badge(price.code, price.label)}</h2><div class="big">${usd(price.value)}</div>${changeTxt}
        <div class="sub">${price.at ? '時刻 ' + jst(price.at) : ''}${price.source ? '・' + esc(price.source) : ''}</div>
        ${price.holiday ? `<div class="sub">休場: ${esc(price.holiday)}</div>` : ''}</div>
      <div><h2>USD/JPY ${badge(fx.code, fx.label)}</h2><div class="big">${num(fx.market ?? (S.cache.fx && S.cache.fx.market), 2)}</div>
        <div class="sub">${fx.at ? '時刻 ' + jst(fx.at) : ''}</div>
        <div class="sub">適用レート: <b>${calc ? num(calc.rate, 2) : (fx.applied ? num(fx.applied, 2) : '—')}</b> ${fx.applied ? badge('manual', '楽天手入力') : `（市場+${num(s.fxSpreadYen, 2)}円）`}</div></div>
    </div>
    <div class="btns"><button class="b" id="btnManual">手入力・楽天適用レート</button>${fx.applied || S.manual.price ? '<button class="b" id="btnClearManual">手入力を解除</button>' : ''}</div></div>`;

    let calcHtml;
    if (calc) {
      const zero = calc.shares === 0;
      calcHtml = `<div class="card"><h2>購入可能株数（手数料込み）</h2>
        <div style="display:flex;align-items:baseline;gap:10px"><div class="big" style="color:${zero ? 'var(--bad)' : 'var(--text)'}">${calc.shares}株</div><div class="sub">総支払見込 <b class="mid">${yen(calc.totalYen)}</b></div></div>
        ${cond.type === 'rsi' && !cond.met ? '<div class="alert warn" style="margin-top:8px">購入条件（RSI）は未達です。参考計算です。</div>' : ''}
        ${cond.type === 'drop' && !cond.met ? '<div class="alert warn" style="margin-top:8px">目標価格に未到達です。参考計算です。</div>' : ''}
        <dl class="rows" style="margin-top:10px">
          <dt>今回の基本投入枠</dt><dd>${yen(ps.baseAlloc)}</dd>
          <dt>前回からの繰越金</dt><dd>${yen(ps.carryIn)}</dd>
          <dt class="strong">今回の投入可能額</dt><dd class="strong">${yen(ps.available)}</dd>
          <div class="sep"></div>
          <dt>株価${s.priceBufferPct ? `（+${s.priceBufferPct}%バッファ）` : ''}</dt><dd>${usd(calc.priceUsd, 4)}</dd>
          <dt>適用為替レート</dt><dd>${num(calc.rate, 2)}円</dd>
          <dt>米ドル建て購入代金</dt><dd>${usd(calc.amountUsd)}</dd>
          <dt>円換算購入代金</dt><dd>${yen(calc.amountYen)}</dd>
          <dt>売買手数料</dt><dd>${usd(calc.feeUsd)}（${yen(calc.feeYen)}）</dd>
          <dt>為替コスト（スプレッド）</dt><dd>${calc.fxCostYen != null ? yen(calc.fxCostYen) : '—'}</dd>
          ${calc.otherYen ? `<dt>その他費用</dt><dd>${yen(calc.otherYen)}</dd>` : ''}
          <dt class="strong">手数料込み総支払見込額</dt><dd class="strong">${yen(calc.totalYen)}</dd>
          <div class="sep"></div>
          <dt>購入後の残金（今回枠）</dt><dd>${yen(calc.leftoverYen)}</dd>
          <dt>次回繰越金</dt><dd>${yen(calc.leftoverYen)}</dd>
          <dt>総残予算（購入後）</dt><dd>${yen(ps.remainingBudget - calc.totalYen)}</dd>
        </dl>
        <div class="note">試算です。注文前に楽天証券の注文画面で必ず最終確認してください。${fx.applied ? '' : '注文直前は「楽天適用レート」を入力すると精度が上がります。'}</div>
        <div class="btns"><button class="b primary" id="btnBuy">購入実績を登録</button>${cond.type === 'drop' ? '<button class="b" id="btnSkip">見送って次の回へ</button>' : ''}</div>
      </div>`;
    } else {
      calcHtml = `<div class="card"><h2>購入可能株数</h2><div class="alert ${ps.done ? 'info' : 'err'}">${esc(calcBlocked)}</div>
        <dl class="rows"><dt>今回の投入可能額</dt><dd>${yen(ps.available)}</dd><dt>総残予算</dt><dd>${yen(ps.remainingBudget)}</dd></dl>
        ${ps.done ? '' : `<div class="btns"><button class="b primary" id="btnBuy">購入実績を登録</button>${cond.type === 'drop' ? '<button class="b" id="btnSkip">見送って次の回へ</button>' : ''}</div>`}</div>`;
    }

    const budgetCard = `<div class="card"><h2>資金</h2><dl class="rows">
      <dt>総予算</dt><dd>${yen(ps.totalBudget)}</dd><dt>累計使用額（受渡）</dt><dd>${yen(ps.paid)}</dd>
      <dt class="strong">総残予算</dt><dd class="strong">${yen(ps.remainingBudget)}</dd>
      <dt>累計株数 / 平均取得単価</dt><dd>${ps.totalShares}株 / ${usd(ps.avgUsd, 4)}</dd></dl>
      <div class="bar"><i style="width:${(ps.usageRate * 100).toFixed(1)}%"></i></div><div class="sub">予算消化率 ${pct(ps.usageRate, 1)}</div></div>`;

    const envCard = envOverview(cur.env);
    const checkCard = weekendChecklist(cur);
    const notifs = S.notifs.slice(0, 5);
    const notifCard = notifs.length ? `<div class="card"><h2>最近の通知</h2>${notifs.map(n => `<div class="notif"><b>${esc(n.title)}</b><div class="sub">${jst(n.at)}　${esc(n.body)}</div></div>`).join('')}</div>` : '';

    const planCard = planOverview(ps, cond);
    main.innerHTML = `<div class="dash">${alerts.length ? `<div class="a-alerts">${alerts.join('')}</div>` : ''}
      <div class="a-status">${statusHtml}</div><div class="a-market">${marketCard}</div>
      <div class="a-calc">${calcHtml}</div><div class="a-budget">${budgetCard}</div>
      <div class="a-env">${envCard}</div><div class="a-check">${checkCard}</div>
      <div class="a-plan wide-only">${planCard}</div>${notifCard ? `<div class="a-notif">${notifCard}</div>` : ''}</div>` +
      `<div class="note" style="text-align:center">自動発注は行いません。データ: ${esc((S.cache.quote && S.cache.quote.source) || '—')} / ${esc((S.cache.fx && S.cache.fx.source) || '—')}</div>`;
    $('#btnManual')?.addEventListener('click', openManual);
    $('#btnClearManual')?.addEventListener('click', () => { S.manual = { ...S.manual, price: null, applied: null, market: null, rsi: null, rsiAt: null }; save(); tick(); });
    $('#btnBuy')?.addEventListener('click', () => openBuy(cur));
    $('#btnSkip')?.addEventListener('click', openSkip);
    $('#btnEnv')?.addEventListener('click', openEnvInput);
    main.querySelectorAll('[data-check]').forEach(cb => cb.addEventListener('change', () => {
      const wk = C.isoWeekKey(new Date());
      if (S.checklist.week !== wk) S.checklist = { week: wk, items: {} };
      S.checklist.items[cb.dataset.check] = cb.checked; save();
    }));
  }

  /** 5段階の全体像（広い画面用）。目標価格は直前の実約定価格からの連鎖による参考値 */
  function planOverview(ps, cond) {
    const s = S.settings, entries = C.activeEntries(S);
    // 確定済みの各回の基準価格を使い、未到達の回は直前の約定価格から連鎖で試算
    let ref = null;
    const rows = s.stages.map((st, i) => {
      const e = entries[i];
      let cond2, target = null, state;
      if (st.type === 'rsi') cond2 = `週足RSI ≤ ${s.rsiThreshold}`;
      else { cond2 = `-${(st.drop * 100).toFixed(1)}%`; target = ref != null ? ref * (1 - st.drop) : null; }
      if (e && e.kind === 'buy') {
        state = `<span class="badge b-live">購入 ${esc(e.shares)}株</span>`;
        ref = e.fillPrice; // 実約定価格が次の基準
      } else if (e) {
        state = '<span class="badge b-closed">見送り</span>'; // 基準は直前の約定価格のまま
      } else {
        state = i === ps.nextStage ? (cond.met ? '<span class="badge b-error">条件到達</span>' : '<span class="badge b-manual">監視中</span>') : '<span class="muted">未到達</span>';
        if (target != null) ref = target; // 先の回は「目標価格で約定した」と仮定して連鎖
      }
      const tgt = st.type === 'rsi' ? (e && e.kind === 'buy' ? usd(e.fillPrice, 2) + '<div class="sub">約定</div>' : '—')
        : e && e.kind === 'buy' ? usd(e.fillPrice, 4) + `<div class="sub">約定（目標 ${usd(target, 4)}）</div>`
        : target != null ? usd(target, 4) + (i > ps.nextStage ? '<div class="sub">試算</div>' : '') : '<span class="muted">初回約定後</span>';
      return `<tr class="${i === ps.nextStage ? 'cur' : ''}"><td>${esc(st.name)}</td><td>${cond2}</td><td>${tgt}</td><td>${yen(st.alloc)}</td><td>${state}</td></tr>`;
    }).join('');
    return `<div class="card"><h2>購入計画の全体像</h2><div class="tbl"><table class="plan"><thead><tr><th>回</th><th>条件</th><th>目標 / 約定価格</th><th>基本枠</th><th>状況</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="note">次回より先の目標価格は、各回が目標価格ちょうどで約定した場合の参考値です。実際の目標は直前の約定価格で決まります。</div></div>`;
  }

  /** 相場環境（参考指標）: 資料「VIXとSOXL」（2026年11月）のシグナル一覧 */
  function envOverview(env) {
    const s = S.settings, em = S.envManual, sg = env.signals;
    const dirBadge = d => d === 'down' ? badge('error', '下落継続') : d === 'wait' ? badge('closed', '待ち') : d === 'up' ? badge('live', '反発') : d === 'buy' ? badge('manual', '買い条件') : '<span class="muted">—</span>';
    const fmt = it => {
      if (it.key === 'spdd') return env.spDdInfo ? '−' + pct(env.spDdInfo.dd, 2) : '—';
      if (it.key === 'soxlrsi' || it.key === 'semirsi') return it.value != null ? num(it.value, 1) : '—';
      if (it.key === 'vix') return em.vix != null ? num(em.vix, 2) : '—';
      if (it.key === 'zbt') return em.zbtFired ? '発動' : em.zbt != null ? num(em.zbt, 2) : '—';
      return '';
    };
    const rows = sg.items.map(it => `<div class="envrow">
      <div class="envname">${esc(it.label)}${it.manual ? ' <span class="sub">手入力</span>' : ''}</div>
      <div class="envval">${fmt(it) || '—'}</div><div class="envdir">${dirBadge(it.dir)}</div>
      <div class="envstate"><b>${esc(it.state)}</b>　<span class="sub">判断ライン：${esc(it.line)}</span></div></div>`).join('');
    const sp = env.spDdInfo;
    const semiTxt = env.semi && env.semi.provisional != null ? `（暫定 ${num(env.semi.provisional, 1)}）` : '';
    const manualAt = [em.vixAt, em.zbtAt, em.divAt].filter(Boolean);
    return `<div class="card"><h2>相場環境（参考指標）</h2>
      <div class="sub" style="margin-bottom:8px">下落継続 <b>${sg.down}</b>　待ち <b>${sg.wait}</b>　反発 <b>${sg.up}</b>　買い条件 <b>${sg.buy}</b></div>
      ${env.error ? `<div class="alert warn">${esc(env.error)}</div>` : ''}
      <div class="envlist">${rows}</div>
      <div class="note">${sp ? `SPYの高値 ${usd(sp.high)}（${esc(sp.highDate)}）→ ${usd(sp.last)}（${esc(sp.lastDate)}）。` : ''}半導体RSIはSOXX（SOX指数の代替）${semiTxt}。
        自動取得 ${env.fetchedAt ? jst(env.fetchedAt) : '—'}${manualAt.length ? `／手入力 ${jst(Math.max(...manualAt))}` : ''}。<br>
        資料「VIXとSOXL：2つの話を合わせた相場の見方（2026年11月）」の見方を整理したもので、購入条件には使いません。投資助言ではありません。</div>
      <div class="btns"><button class="b" id="btnEnv">VIX・ZBT・ダイバージェンスを入力</button></div></div>`;
  }

  const CHECK_ITEMS = [
    ['rsi', 'SOXLの週足RSIが週末の確定値で30に入ったか'],
    ['spdd', 'S&P500の高値（10月6日）からの下落率が20%に近づいているか'],
    ['sox', 'SOX指数の週足RSIが30付近まで来ているか'],
    ['div', 'SOXL日足の強気ダイバージェンスが崩れた（安値を深く更新した）か'],
    ['zbt', 'ZBTが発動したか'],
    ['cash', 'シグナル点灯時に投入する資金を用意できているか'],
  ];
  function weekendChecklist(cur) {
    const wk = C.isoWeekKey(new Date());
    const items = S.checklist.week === wk ? S.checklist.items : {};
    const done = CHECK_ITEMS.filter(([k]) => items[k]).length;
    return `<div class="card"><h2>週末チェックリスト（${esc(wk)}）</h2>
      <div class="sub">毎日見る必要はなく、週末に確認すれば十分です。チェックは毎週リセットされます。（${done}/${CHECK_ITEMS.length}）</div>
      ${CHECK_ITEMS.map(([k, t]) => `<label class="chk"><input type="checkbox" data-check="${k}" ${items[k] ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}
      <div class="note">保有中でも、資料の話し手の答えは「下落の底で投入する資金を貯めておく」です。</div></div>`;
  }

  function openEnvInput() {
    const em = S.envManual;
    openDialog(`<h3 style="margin-top:0">参考指標の入力</h3>
      <div class="sub">自動取得できない指標です。チャートや動画で確認した値を入れてください。空欄はそのまま（未入力）になります。</div>
      ${field('vix', 'VIX', em.vix ?? '', 'inputmode="decimal"')}
      ${field('zbt', 'ZBT インジケーターの値', em.zbt ?? '', 'inputmode="decimal"')}
      <label class="f"><input type="checkbox" name="zbtFired" ${em.zbtFired ? 'checked' : ''} style="width:auto"> ZBTが発動した</label>
      <label class="f">SOXL 日足の強気ダイバージェンス</label>
      <select name="divergence"><option value="">未入力</option>${[['active', '発生中'], ['gone', '消滅（安値を深く更新）'], ['none', 'なし']].map(([v, t]) => `<option value="${v}" ${em.divergence === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`, fd => {
      const n = v => v === '' ? null : Number(v);
      if ((fd.vix !== '' && !(Number(fd.vix) >= 0)) || (fd.zbt !== '' && !(Number(fd.zbt) >= 0))) throw new Error('数値を入力してください');
      const now = Date.now();
      S.envManual = {
        vix: n(fd.vix), vixAt: fd.vix !== '' ? now : null, zbt: n(fd.zbt), zbtFired: fd.zbtFired === 'on', zbtAt: (fd.zbt !== '' || fd.zbtFired === 'on') ? now : null,
        divergence: ['active', 'gone', 'none'].includes(fd.divergence) ? fd.divergence : null, divAt: fd.divergence ? now : null,
      };
      save(); tick();
    });
  }

  // ---------- ダイアログ ----------
  function openDialog(html, onSubmit) {
    dlg.innerHTML = `<form method="dialog" id="dlgForm">${html}<div class="btns" style="justify-content:flex-end"><button class="b" value="cancel" formnovalidate>キャンセル</button><button class="b primary" value="ok">OK</button></div></form>`;
    dlg.showModal();
    $('#dlgForm').addEventListener('submit', e => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      const fd = Object.fromEntries(new FormData(e.target).entries());
      try { const keepOpen = onSubmit(fd); if (keepOpen === true) e.preventDefault(); }
      catch (err) { e.preventDefault(); alert(err.message); }
    });
  }
  const field = (name, label, value = '', attrs = '') => `<label class="f">${label}</label><input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;

  function openManual() {
    const m = S.manual;
    openDialog(`<h3 style="margin-top:0">手入力</h3>
      <div class="sub">空欄の項目は自動取得値を使います。手入力値は${MANUAL_EXPIRE_MIN}分で失効します。</div>
      ${field('applied', '楽天証券の適用為替レート（円/ドル・スプレッド込み）', m.applied, 'inputmode="decimal"')}
      ${field('price', 'SOXL株価（USD）', m.price, 'inputmode="decimal"')}
      ${field('market', 'USD/JPY 市場レート', m.market, 'inputmode="decimal"')}
      ${field('rsi', '確定週足RSI（自動取得できない場合）', m.rsi, 'inputmode="decimal"')}`, fd => {
      const n = k => fd[k] === '' ? null : Number(fd[k]);
      for (const k of ['applied', 'price', 'market', 'rsi']) if (fd[k] !== '' && !(Number(fd[k]) >= 0)) throw new Error('数値を入力してください');
      const now = Date.now();
      S.manual = { price: n('price'), priceAt: n('price') ? now : null, applied: n('applied'), appliedAt: n('applied') ? now : null, market: n('market'), marketAt: n('market') ? now : null, rsi: n('rsi'), rsiAt: n('rsi') != null ? now : null };
      save(); tick();
    });
  }

  function openBuy(cur) {
    const { calc, ps, price } = cur;
    if (ps.done) return;
    openDialog(`<h3 style="margin-top:0">${esc(ps.stage.name)} 購入実績の登録</h3>
      <div class="sub">楽天証券の約定照会・取引履歴の値を入力してください。約定単価が次回の下落率判定の基準になります。</div>
      ${field('date', '約定日', todayJst(), 'type="date" required')}
      ${field('fillPrice', '約定単価（USD）', price.value ?? '', 'inputmode="decimal" required')}
      ${field('shares', '約定株数', calc ? calc.shares : '', 'inputmode="numeric" required')}
      ${field('fxRate', '適用為替レート（円/ドル）', calc ? calc.rate : '', 'inputmode="decimal"')}
      ${field('feeUsd', '売買手数料（USD・空欄なら自動計算）', '', 'inputmode="decimal"')}
      ${field('paidYen', '円貨受渡金額（実績・円）', '', 'inputmode="numeric" placeholder="空欄なら試算値で登録"')}
      <label class="f">備考</label><textarea name="note" rows="2"></textarea>`, fd => {
      const e = C.buildBuyEntry(S, S.settings, { ...fd, estimate: calc ? { ...calc, at: Date.now() } : null });
      const msg = `${S.settings.stages[e.stage].name}\n約定 ${usd(e.fillPrice, 4)} × ${e.shares}株\n受渡金額 ${yen(e.paidYen)}${e.paidIsActual ? '' : '（試算）'}\n次回基準価格 ${usd(e.fillPrice, 4)}\n\nこの内容で登録しますか？`;
      if (!confirm(msg)) return true;
      snapshot('購入登録前'); S.entries.push(e); audit('購入登録', e);
      S.touchFlags = {}; save(); toast('登録しました'); tick();
    });
  }
  function openSkip() {
    const ps = C.planStatus(S, S.settings);
    openDialog(`<h3 style="margin-top:0">${esc(ps.stage.name)} を見送る</h3>
      <div class="alert warn">通常は見送る必要はありません（条件到達後に買わなければ、同じ条件を監視し続けます）。<br>この回を飛ばして次の回の条件に進む場合のみ使ってください。投入枠 ${yen(ps.baseAlloc)} は次回へ繰り越され、基準価格は直前の約定価格 ${usd(ps.refPrice, 4)} のままです。</div>
      ${field('date', '日付', todayJst(), 'type="date"')}<label class="f">理由・備考</label><textarea name="note" rows="2"></textarea>`, fd => {
      if (!confirm('この回を見送って次の回へ進みます。よろしいですか？')) return true;
      const e = C.buildSkipEntry(S, S.settings, fd);
      snapshot('見送り前'); S.entries.push(e); audit('見送り', e); S.touchFlags = {}; save(); tick();
    });
  }

  // ---------- 履歴 ----------
  function renderHistory() {
    const s = S.settings, entries = C.activeEntries(S), ps = C.planStatus(S, s);
    let cumShares = 0;
    const rows = entries.map((e, i) => {
      const name = esc(s.stages[i] ? s.stages[i].name : `#${i + 1}`);
      if (e.kind === 'skip') return `<tr><td>${name}</td><td colspan="6" style="text-align:left">見送り（${esc(e.date)}）${esc(e.note)}</td><td><button class="b" data-edit="${e.id}">編集</button></td></tr>`;
      cumShares += e.shares;
      const nextDrop = s.stages[i + 1] && s.stages[i + 1].drop;
      return `<tr><td>${name}<div class="sub">${esc(e.date)}</div></td><td>${usd(e.fillPrice, 4)}</td><td>${e.shares}</td><td>${e.fxRate ? num(e.fxRate, 2) : '—'}</td><td>${usd(e.feeUsd)}</td><td>${yen(e.paidYen)}${e.paidIsActual ? '' : '<div class="sub">試算</div>'}</td><td>${nextDrop ? usd(C.targetPrice(e.fillPrice, nextDrop), 4) : '—'}<div class="sub">累計${cumShares}株</div></td><td><button class="b" data-edit="${e.id}">編集</button></td></tr>${e.note ? `<tr><td colspan="8" class="sub" style="text-align:left">備考: ${esc(e.note)}</td></tr>` : ''}`;
    }).join('');
    const touches = (S.touches || []).slice().reverse().slice(0, 30).map(t => `<tr><td>${esc(s.stages[t.stage] ? s.stages[t.stage].name : '')}</td><td>${jst(t.at)}</td><td>${t.type === 'rsi' ? 'RSI ' + num(t.rsi, 1) : usd(t.price)}</td><td>${t.reboundAt ? '反発 ' + jst(t.reboundAt) : '—'}</td></tr>`).join('');
    const auditRows = S.audit.slice(0, 30).map(a => `<div class="notif"><b>${esc(a.action)}</b> <span class="sub">${new Date(a.at).toLocaleString('ja-JP')}</span></div>`).join('');
    main.innerHTML = `<div class="card"><h2>購入履歴</h2>
      ${entries.length ? `<div class="tbl"><table><thead><tr><th>回</th><th>約定単価</th><th>株数</th><th>為替</th><th>手数料</th><th>受渡金額</th><th>次回目標</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="muted">まだ購入記録はありません。</div>'}
      <dl class="rows" style="margin-top:12px">
        <dt>累計購入株数</dt><dd>${ps.totalShares}株</dd>
        <dt>平均取得単価（USD）</dt><dd>${usd(ps.avgUsd, 4)}</dd>
        <dt>平均取得単価（円・手数料等込み）</dt><dd>${ps.avgYen ? yen(ps.avgYen) : '—'}</dd>
        <dt>累計約定代金</dt><dd>${usd(ps.totalUsd)}</dd><dt>累計手数料</dt><dd>${usd(ps.totalFeeUsd)}</dd>
        <dt>累計受渡金額</dt><dd>${yen(ps.paid)}</dd></dl>
      ${entries.length ? '<div class="btns"><button class="b danger" id="btnUndo">最新の記録を取り消す</button></div>' : ''}</div>
      <div class="grid-3"><div class="card"><h2>購入条件の到達履歴</h2>${touches ? `<div class="tbl"><table><thead><tr><th>回</th><th>到達</th><th>値</th><th>反発</th></tr></thead><tbody>${touches}</tbody></table></div>` : '<div class="muted">まだありません。</div>'}</div>
      <div class="card"><h2>通知履歴</h2>${S.notifs.slice(0, 30).map(n => `<div class="notif"><b>${esc(n.title)}</b><div class="sub">${jst(n.at)}　${esc(n.body)}</div></div>`).join('') || '<div class="muted">まだありません。</div>'}</div>
      <div class="card"><h2>変更履歴</h2>${auditRows || '<div class="muted">まだありません。</div>'}</div></div>`;
    main.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEdit(b.dataset.edit)));
    $('#btnUndo')?.addEventListener('click', () => {
      const last = C.activeEntries(S).at(-1);
      if (!confirm(`最新の記録（${S.settings.stages[C.activeEntries(S).length - 1].name}・${last.kind === 'buy' ? '購入' : '見送り'}）を取り消します。よろしいですか？`)) return;
      if (!confirm('本当に取り消しますか？（取消前の状態は自動バックアップされます）')) return;
      snapshot('取消前'); last.deleted = true; last.deletedAt = new Date().toISOString(); audit('記録の取消', last);
      S.touchFlags = {}; save(); renderHistory(); tick();
    });
  }
  function openEdit(id) {
    const e = S.entries.find(x => x.id === id);
    if (!e) return;
    if (e.kind === 'skip') {
      openDialog(`<h3 style="margin-top:0">見送り記録の編集</h3>${field('date', '日付', e.date, 'type="date"')}<label class="f">備考</label><textarea name="note" rows="2">${esc(e.note)}</textarea>`, fd => {
        if (!confirm('変更を保存しますか？')) return true;
        const before = { ...e }; snapshot('編集前'); Object.assign(e, fd); audit('見送り記録の編集', { before, after: { ...e } }); save(); renderHistory(); tick();
      });
      return;
    }
    openDialog(`<h3 style="margin-top:0">購入記録の編集</h3>
      ${field('date', '約定日', e.date, 'type="date"')}${field('fillPrice', '約定単価（USD）', e.fillPrice, 'inputmode="decimal"')}
      ${field('shares', '株数', e.shares, 'inputmode="numeric"')}${field('fxRate', '適用為替レート', e.fxRate ?? '', 'inputmode="decimal"')}
      ${field('feeUsd', '手数料（USD）', e.feeUsd, 'inputmode="decimal"')}${field('paidYen', '円貨受渡金額（実績）', e.paidYen, 'inputmode="numeric"')}
      <label class="f">備考</label><textarea name="note" rows="2">${esc(e.note)}</textarea>`, fd => {
      const v = { date: fd.date, fillPrice: Number(fd.fillPrice), shares: Number(fd.shares), fxRate: fd.fxRate ? Number(fd.fxRate) : null, feeUsd: Number(fd.feeUsd) || 0, paidYen: Number(fd.paidYen), note: fd.note };
      if (!(v.fillPrice > 0) || !(v.shares > 0) || !Number.isInteger(v.shares) || !(v.paidYen > 0)) throw new Error('約定単価・株数・受渡金額を正しく入力してください');
      const others = C.activeEntries(S).filter(x => x.kind === 'buy' && x.id !== e.id).reduce((a, x) => a + x.paidYen, 0);
      if (others + v.paidYen > S.settings.totalBudget) throw new Error('総予算を超えるため保存できません');
      if (!confirm('変更を保存しますか？次回の目標価格・残予算が再計算されます。')) return true;
      const before = { ...e }; snapshot('編集前');
      Object.assign(e, v, { amountUsd: Math.round(v.fillPrice * v.shares * 1e6) / 1e6, nextRefPrice: v.fillPrice, paidIsActual: true, editedAt: new Date().toISOString() });
      audit('購入記録の編集', { before, after: { ...e } }); save(); renderHistory(); tick();
    });
  }

  // ---------- 資金管理 ----------
  function renderFunds(cur) {
    const s = S.settings, ps = cur.ps, entries = C.activeEntries(S);
    let cum = 0, paidCum = 0;
    const rows = s.stages.map((st, i) => {
      cum += st.alloc;
      const e = entries[i];
      if (e && e.kind === 'buy') paidCum += e.paidYen;
      const status = e ? (e.kind === 'buy' ? `購入 ${esc(e.shares)}株` : '見送り') : (i === ps.nextStage ? '監視中' : '未到達');
      return `<tr><td>${esc(st.name)}</td><td>${st.type === 'rsi' ? `RSI≤${s.rsiThreshold}` : `-${(st.drop * 100).toFixed(1)}%`}</td><td>${yen(st.alloc)}</td><td>${e && e.kind === 'buy' ? yen(e.paidYen) : '—'}</td><td>${e ? yen(cum - paidCum) : '—'}</td><td>${status}</td></tr>`;
    }).join('');
    const allocSum = s.stages.reduce((a, x) => a + x.alloc, 0);
    main.innerHTML = `<div class="grid-2"><div class="card"><h2>予算</h2><dl class="rows">
      <dt>総予算</dt><dd>${yen(ps.totalBudget)}</dd><dt>累計使用額（受渡）</dt><dd>${yen(ps.paid)}</dd>
      <dt>累計約定代金</dt><dd>${usd(ps.totalUsd)}</dd><dt>累計手数料</dt><dd>${usd(ps.totalFeeUsd)}</dd>
      <dt class="strong">総残予算</dt><dd class="strong">${yen(ps.remainingBudget)}</dd>
      <div class="sep"></div>
      <dt>次回（${ps.done ? '—' : esc(ps.stage.name)}）基本投入枠</dt><dd>${yen(ps.baseAlloc)}</dd>
      <dt>繰越金</dt><dd>${yen(ps.carryIn)}</dd><dt class="strong">次回投入可能額</dt><dd class="strong">${yen(ps.available)}</dd>
      <dt>未使用資金（計画上）</dt><dd>${yen(ps.remainingBudget)}</dd>
      <dt>累計購入株数</dt><dd>${ps.totalShares}株</dd></dl>
      <div class="bar"><i style="width:${(ps.usageRate * 100).toFixed(1)}%"></i></div><div class="sub">予算消化率 ${pct(ps.usageRate, 1)}</div>
      ${allocSum !== s.totalBudget ? `<div class="alert warn" style="margin-top:10px">各回の投入枠合計（${yen(allocSum)}）が総予算（${yen(s.totalBudget)}）と一致していません。総予算が常に上限として優先されます。</div>` : ''}</div>
      <div class="card"><h2>各回の購入状況</h2><div class="tbl"><table><thead><tr><th>回</th><th>条件</th><th>基本枠</th><th>受渡金額</th><th>繰越</th><th>状況</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="note">繰越 = それまでの基本枠合計 − 実際の受渡金額合計。見送った回の枠も次回へ繰り越されます。</div></div></div>`;
  }

  // ---------- 設定 ----------
  const SETTING_FIELDS = [
    ['totalBudget', '総予算（円）', 1],
    ['rsiThreshold', 'RSI購入条件（以下）', 1], ['rsiPeriod', 'RSI期間（週）', 1],
    ['feeRate', '手数料率（%・税込）', 100], ['feeMinUsd', '最低手数料（USD）', 1], ['feeMaxUsd', '手数料上限（USD・税込）', 1],
    ['fxSpreadYen', '円貨決済の為替スプレッド（円/ドル）', 1], ['otherCostYen', 'その他費用（円/注文）', 1],
    ['priceBufferPct', '価格バッファ（%・成行の上振れ対策）', 1],
    ['staleMinutesOpen', '株価の鮮度上限（分・取引時間中）', 1], ['staleMinutesFx', '為替の鮮度上限（分）', 1],
    ['envVixLine', '参考：VIXの判断ライン', 1], ['envBuyZoneDdPct', '参考：SOXL買い場とするS&P500下落率（%）', 1], ['envSemiRsiLine', '参考：半導体週足RSIの底の目安', 1],
    ['refreshSecQuote', '株価の自動更新間隔（秒）', 1], ['refreshSecFx', '為替の自動更新間隔（秒）', 1], ['refreshMinRsi', '週足の更新間隔（分）', 1],
  ];
  function renderSettings() {
    const s = S.settings;
    const stageRows = s.stages.map((st, i) => `<tr><td>${esc(st.name)}</td>
      <td>${st.type === 'rsi' ? 'RSI' : `<input name="drop${i}" value="${(st.drop * 100).toFixed(2).replace(/\.?0+$/, '')}" inputmode="decimal" style="width:80px">`}</td>
      <td><input name="alloc${i}" value="${esc(st.alloc)}" inputmode="numeric" style="width:120px"></td></tr>`).join('');
    const notifState = 'Notification' in window ? Notification.permission : 'unsupported';
    main.innerHTML = `<form id="setForm"><div class="set-grid">
      <div class="card s-stage"><h2>購入条件・投入枠</h2>
        <div class="tbl"><table><thead><tr><th>回</th><th>下落率（%）</th><th>投入枠（円）</th></tr></thead><tbody>${stageRows}</tbody></table></div>
        <div class="note">②以降の下落率は「直前の実際の約定価格」からの下落率です。</div>
        <label class="f">目標到達後に反発したときの扱い</label>
        <select name="reboundMode"><option value="history" ${s.reboundMode === 'history' ? 'selected' : ''}>到達履歴を残し、現在の達成状況は別表示（推奨）</option><option value="latch" ${s.reboundMode === 'latch' ? 'selected' : ''}>購入するまで「到達」表示を維持</option></select>
      </div>
      <div class="card s-fee"><h2>手数料・為替（楽天証券 円貨決済）</h2>
        ${SETTING_FIELDS.map(([k, label, scale]) => `<label class="f">${label}</label><input name="${k}" value="${+(s[k] * scale).toFixed(6)}" inputmode="decimal">`).join('')}
        <label class="f">手数料のセント未満</label><select name="feeRounding">${['ceil', 'floor', 'round'].map(v => `<option value="${v}" ${s.feeRounding === v ? 'selected' : ''}>${{ ceil: '切り上げ（安全側）', floor: '切り捨て', round: '四捨五入' }[v]}</option>`).join('')}</select>
        <label class="f">円換算の1円未満</label><select name="yenRounding">${['ceil', 'floor', 'round'].map(v => `<option value="${v}" ${s.yenRounding === v ? 'selected' : ''}>${{ ceil: '切り上げ（安全側）', floor: '切り捨て', round: '四捨五入' }[v]}</option>`).join('')}</select>
        <label class="f"><input type="checkbox" name="feeFree" ${s.feeFree ? 'checked' : ''} style="width:auto"> 売買手数料無料（キャンペーン等が適用される場合）</label>
        <label class="f"><input type="checkbox" name="useAskIfAvailable" ${s.useAskIfAvailable ? 'checked' : ''} style="width:auto"> 売気配（Ask）が取得できる場合はAskで計算</label>
        <div class="note">初期値は2026年11月時点の楽天証券公開情報：手数料 約定代金の0.495%（税込）、最低0ドル、上限22ドル。円貨決済の為替手数料 1ドルあたり25銭。端数処理の正確な方式は未検証のため安全側（切り上げ）にしています。</div>
      </div>
      <div class="card s-data"><h2>データ取得（API中継）</h2>
        <label class="f">API中継URL（Cloudflare Worker）</label><input name="workerUrl" value="${esc(s.workerUrl)}" placeholder="https://soxl-nanpin-api.xxxx.workers.dev" inputmode="url">
        <label class="f">アプリトークン（Workerの APP_TOKEN と同じ値）</label><input name="appToken" value="${esc(s.appToken || '')}" type="password" autocomplete="off">
        <div class="note">APIキー（Finnhub・Twelve Data）はWorker側のシークレットに保存し、このアプリには入力しません。株価: Finnhub（失敗時Twelve Data）/ 為替・週足RSI: Twelve Data。</div>
        <div class="btns"><button type="button" class="b" id="btnTest">接続テスト</button></div><div id="testResult" class="note"></div>
      </div></div>
      <div class="btns savebar" style="margin-bottom:12px"><button class="b primary" type="submit">設定を保存</button><button class="b" type="button" id="btnDefaults">初期値に戻す</button></div>
    </form>
    <div class="grid-2"><div class="card"><h2>通知</h2><div class="sub">状態: ${{ granted: '許可済み', denied: '拒否（端末の設定で変更）', default: '未設定', unsupported: 'この環境では未対応' }[notifState]}</div>
      <div class="note">アプリを開いている間の通知に対応します。iPhoneはホーム画面に追加したアプリでのみ通知を許可できます。</div>
      <div class="btns"><button class="b" id="btnNotif" ${notifState !== 'default' ? 'disabled' : ''}>通知を許可</button></div></div>
    <div class="card"><h2>バックアップ</h2>
      <div class="btns"><button class="b" id="btnExport">JSONバックアップ</button><button class="b" id="btnCsv">購入履歴CSV</button><label class="b" style="cursor:pointer">JSONから復元<input type="file" id="fileImport" accept="application/json,.json" class="hidden"></label></div>
      <div class="note">自動バックアップ（直近10件・登録/編集/取消の直前）からも復元できます。</div>
      <div class="btns"><button class="b" id="btnSnaps">自動バックアップから復元</button><button class="b danger" id="btnReset">全データを消去</button></div></div></div>`;
    $('#setForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const ns = { ...s, stages: s.stages.map(x => ({ ...x })) };
      for (const [k, , scale] of SETTING_FIELDS) {
        const v = Number(fd.get(k));
        if (!isFinite(v) || v < 0) { alert(`「${k}」の値が不正です`); return; }
        ns[k] = v / scale;
      }
      ns.stages.forEach((st, i) => {
        st.alloc = Number(fd.get('alloc' + i));
        if (st.type === 'drop') st.drop = Number(fd.get('drop' + i)) / 100;
      });
      if (ns.stages.some(st => !(st.alloc >= 0) || (st.type === 'drop' && !(st.drop > 0 && st.drop < 1)))) { alert('投入枠・下落率の値が不正です'); return; }
      ns.feeRounding = fd.get('feeRounding'); ns.yenRounding = fd.get('yenRounding'); ns.reboundMode = fd.get('reboundMode');
      ns.feeFree = fd.get('feeFree') === 'on'; ns.useAskIfAvailable = fd.get('useAskIfAvailable') === 'on';
      ns.workerUrl = String(fd.get('workerUrl') || '').trim(); ns.appToken = String(fd.get('appToken') || '').trim();
      if (ns.appToken && !/^[\x21-\x7E]+$/.test(ns.appToken)) { alert('アプリトークンには半角英数字と記号だけを使ってください（全角文字・空白は不可）'); return; }
      if (ns.workerUrl && !/^https:\/\//.test(ns.workerUrl)) { alert('API中継URLは https:// で始まる必要があります'); return; }
      if (!confirm('設定を保存しますか？')) return;
      audit('設定変更', { before: s, after: ns });
      S.settings = ns; save(); schedule(); refreshAll(false); toast('保存しました');
    });
    $('#btnDefaults').addEventListener('click', () => {
      if (!confirm('手数料・購入条件などを初期値に戻します（API中継URLは保持）。よろしいですか？')) return;
      const d = C.defaultSettings(); d.workerUrl = s.workerUrl; d.appToken = s.appToken;
      audit('設定を初期化', { before: s }); S.settings = d; save(); renderSettings(); tick();
    });
    $('#btnTest').addEventListener('click', async () => {
      const out = $('#testResult'); out.textContent = 'テスト中…';
      const url = $('[name=workerUrl]').value.trim(); const tok = $('[name=appToken]').value.trim();
      const saved = { u: S.settings.workerUrl, t: S.settings.appToken };
      S.settings.workerUrl = url; S.settings.appToken = tok;
      const res = [];
      for (const k of ['quote', 'fx', 'weekly', 'market']) {
        try { const j = await api(k, false); res.push(`✓ ${k}: ${k === 'quote' ? usd(j.price) + '（' + j.source + '）' : k === 'fx' ? num(j.market, 3) : k === 'market' ? `SPY ${j.spy ? j.spy.length + '日分' : '✗'}・SOXX ${j.soxx ? j.soxx.length + '週分' : '✗'}` : j.bars.length + '週分'}`); }
        catch (e) { res.push(`✗ ${k}: ${e.message}`); }
      }
      S.settings.workerUrl = saved.u; S.settings.appToken = saved.t;
      out.innerHTML = res.map(esc).join('<br>');
    });
    $('#btnNotif').addEventListener('click', async () => { await Notification.requestPermission(); renderSettings(); });
    $('#btnExport').addEventListener('click', () => download(`soxl-nanpin-backup-${todayJst()}.json`, JSON.stringify(C.exportState(S), null, 2), 'application/json'));
    $('#btnCsv').addEventListener('click', () => download(`soxl-nanpin-history-${todayJst()}.csv`, C.toCsv(S, S.settings), 'text/csv'));
    $('#fileImport').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
        const data = JSON.parse(await file.text());
        const next = adoptState(data, false); // 形式チェック（不正なら例外）
        const fileUrl = data && data.settings && typeof data.settings.workerUrl === 'string' ? data.settings.workerUrl : '';
        const urlNote = fileUrl && fileUrl !== S.settings.workerUrl ? `\n\n※ファイル内のAPI中継URL（${fileUrl}）は使わず、この端末の設定を維持します。` : '';
        if (!confirm(`バックアップ（記録${next.entries.length}件）で現在のデータを置き換えます。よろしいですか？${urlNote}`)) return;
        snapshot('復元前'); S = next;
        audit('JSONから復元', { file: String(file.name).slice(0, 100) }); save(); toast('復元しました'); schedule(); setTab('home'); refreshAll(false);
      } catch (err) { alert('復元に失敗しました: ' + err.message); }
    });
    $('#btnSnaps').addEventListener('click', () => {
      const list = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
      if (!list.length) { alert('自動バックアップはまだありません'); return; }
      openDialog(`<h3 style="margin-top:0">自動バックアップから復元</h3><select name="i">${list.map((x, i) => `<option value="${i}">${esc(new Date(x.at).toLocaleString('ja-JP'))}（${esc(x.reason)}・記録${Array.isArray(x.data && x.data.entries) ? x.data.entries.filter(e => e && !e.deleted).length : 0}件）</option>`).join('')}</select>`, fd => {
        if (!confirm('選択した時点の状態に戻します。よろしいですか？')) return true;
        const pick = list[Number(fd.i)]; snapshot('自動バックアップ復元前');
        try { S = adoptState(pick.data, true); } catch (err) { alert('この自動バックアップは読み込めません: ' + err.message); return; }
        audit('自動バックアップから復元', { at: pick.at }); save(); setTab('home');
      });
    });
    $('#btnReset').addEventListener('click', () => {
      if (!confirm('全データ（購入履歴・設定）を消去します。先にJSONバックアップを取ることをおすすめします。続けますか？')) return;
      if (prompt('確認のため「消去」と入力してください') !== '消去') return;
      snapshot('全消去前'); S = blankState(); save(); setTab('home');
    });
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ================= 起動 =================
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  tick(); setTab('home'); schedule(); refreshAll(false);
})();
