/*
 * SOXLナンピン管理 — 計算コア
 * 画面やAPIに依存しない純粋関数のみ。ブラウザ(window.Core)とNode(require)の両方で動く。
 */
(function (root) {
  'use strict';

  const EPS = 1e-9;

  // ---------- 初期設定 ----------
  function defaultSettings() {
    return {
      totalBudget: 1000000,
      stages: [
        { name: '① 初回', type: 'rsi', drop: null, alloc: 500000 },
        { name: '② 追加', type: 'drop', drop: 0.10, alloc: 150000 },
        { name: '③ 追加', type: 'drop', drop: 0.05, alloc: 150000 },
        { name: '④ 追加', type: 'drop', drop: 0.05, alloc: 100000 },
        { name: '⑤ 追加', type: 'drop', drop: 0.05, alloc: 100000 },
      ],
      rsiPeriod: 14,
      rsiThreshold: 30,
      // 楽天証券 米国株式 現物 インターネット取引（2026年11月調査時点）
      feeRate: 0.00495,      // 約定代金の0.495%（税込）
      feeMinUsd: 0,          // 最低手数料 0米ドル
      feeMaxUsd: 22,         // 上限 22米ドル（税込）
      feeFree: false,        // 手数料無料キャンペーン等の適用
      feeRounding: 'ceil',   // 手数料のセント未満: ceil / floor / round（楽天の正確な方式は要検証）
      fxSpreadYen: 0.25,     // 円貨決済の為替手数料 1米ドルあたり25銭
      yenRounding: 'ceil',   // 円換算の1円未満: ceil / floor / round（安全側=ceil）
      otherCostYen: 0,       // その他費用（円・1注文あたり）
      priceBufferPct: 0,     // 成行等での価格上振れに備えるバッファ（%）
      useAskIfAvailable: true,
      reboundMode: 'history', // 'history'=到達履歴を残し現在状況は別表示 / 'latch'=購入するまで到達扱いを維持
      staleMinutesOpen: 5,   // 取引時間中、これより古い株価は計算に使わない
      staleMinutesFx: 30,    // これより古い為替レートは計算に使わない
      refreshSecQuote: 30,
      refreshSecFx: 180,
      refreshMinRsi: 60,
      workerUrl: '',
      // 相場環境（参考指標）の判断ライン。購入条件には使わない
      envVixLine: 29,          // VIX
      envVixDdPct: 8,          // VIX29突破時にS&P500が高値から何%以上下落していれば「該当」
      envBuyZoneDdPct: 20,     // S&P500の下落率がこれに近づくとSOXL買い場の前提
      envSemiRsiLine: 30,      // 半導体の週足RSIの底の目安
      envZbtLow: 0.40,         // ZBT: この値を下回ると売られすぎ
    };
  }

  // ---------- 丸め ----------
  function roundTo(x, digits, mode) {
    const f = Math.pow(10, digits);
    const v = x * f;
    let r;
    if (mode === 'floor') r = Math.floor(v + EPS);
    else if (mode === 'round') r = Math.round(v);
    else r = Math.ceil(v - EPS);
    return r / f;
  }

  // ---------- 手数料 ----------
  function commissionUsd(amountUsd, s) {
    if (s.feeFree || amountUsd <= 0) return 0;
    let fee = amountUsd * s.feeRate;
    fee = roundTo(fee, 2, s.feeRounding);
    if (fee < s.feeMinUsd) fee = s.feeMinUsd;
    if (s.feeMaxUsd > 0 && fee > s.feeMaxUsd) fee = s.feeMaxUsd;
    return fee;
  }

  /**
   * 適用為替レート。
   * fx: { market: 市場レート, applied: 楽天の適用レート(手入力・スプレッド込み) }
   */
  function appliedRate(fx, s) {
    if (fx && fx.applied > 0) return { rate: fx.applied, source: 'manual' };
    if (fx && fx.market > 0) return { rate: fx.market + s.fxSpreadYen, source: 'market+spread' };
    return { rate: null, source: 'none' };
  }

  /** n株の見積り */
  function estimate(n, priceUsd, fx, s) {
    const ar = appliedRate(fx, s);
    const rate = ar.rate;
    const p = priceUsd * (1 + (s.priceBufferPct || 0) / 100);
    const amountUsd = Math.round(p * n * 1e6) / 1e6;
    const feeUsd = commissionUsd(amountUsd, s);
    const totalUsd = Math.round((amountUsd + feeUsd) * 1e6) / 1e6;
    const amountYen = amountUsd * rate;
    const feeYen = feeUsd * rate;
    const marketRate = fx && fx.market > 0 ? fx.market : null;
    const fxCostYen = marketRate ? Math.max(0, (rate - marketRate) * totalUsd) : null;
    const extra = n > 0 ? (s.otherCostYen || 0) : 0;
    const totalYen = roundTo(totalUsd * rate, 0, s.yenRounding) + extra;
    return {
      shares: n, priceUsd: p, rate, rateSource: ar.source, marketRate,
      amountUsd, feeUsd, totalUsd, amountYen, feeYen, fxCostYen, otherYen: extra, totalYen,
    };
  }

  /** 手数料込み総支払見込額が available 以下となる最大整数株数 */
  function maxShares(availableYen, priceUsd, fx, s) {
    const ar = appliedRate(fx, s);
    if (!(priceUsd > 0) || !(ar.rate > 0)) return { ok: false, reason: '株価または為替が未取得です' };
    if (!(availableYen > 0)) {
      const e = estimate(0, priceUsd, fx, s);
      return { ok: true, ...e, availableYen: Math.max(0, availableYen || 0), leftoverYen: Math.max(0, availableYen || 0), verified: true };
    }
    const perShare = priceUsd * (1 + (s.priceBufferPct || 0) / 100) * ar.rate;
    let n = Math.floor(availableYen / perShare) + 1;
    while (n > 0 && estimate(n, priceUsd, fx, s).totalYen > availableYen) n--;
    const e = estimate(n, priceUsd, fx, s);
    // 最終検証
    const verified = e.totalYen <= availableYen && estimate(n + 1, priceUsd, fx, s).totalYen > availableYen;
    if (!verified) throw new Error('株数計算の検証に失敗しました');
    return { ok: true, ...e, availableYen, leftoverYen: availableYen - e.totalYen, verified };
  }

  // ---------- 購入計画・資金 ----------
  /**
   * state.entries: 時系列の記録
   *   { kind:'buy', stage, date, fillPrice, shares, fxRate, amountUsd, feeUsd, paidYen, estimate, note, id }
   *   { kind:'skip', stage, date, note, id }  … 明示的に「見送って次の回へ」した記録
   */
  function activeEntries(state) {
    return (state.entries || []).filter(e => !e.deleted);
  }

  function planStatus(state, s) {
    const entries = activeEntries(state);
    const stages = s.stages;
    const buys = entries.filter(e => e.kind === 'buy');
    const paid = buys.reduce((a, e) => a + (Number(e.paidYen) || 0), 0);
    const nextStage = entries.length; // 購入 or 見送りで1段階進む
    const done = nextStage >= stages.length;
    const cumAlloc = stages.slice(0, Math.min(nextStage + 1, stages.length)).reduce((a, x) => a + x.alloc, 0);
    const prevAlloc = stages.slice(0, Math.min(nextStage, stages.length)).reduce((a, x) => a + x.alloc, 0);
    const remainingBudget = Math.max(0, s.totalBudget - paid);
    const carryIn = prevAlloc - paid; // 前回までの繰越金（使い残し・見送り分）
    const baseAlloc = done ? 0 : stages[nextStage].alloc;
    let available = done ? 0 : Math.min(cumAlloc - paid, remainingBudget);
    if (available < 0) available = 0;
    const lastBuy = buys.length ? buys[buys.length - 1] : null;
    const shares = buys.reduce((a, e) => a + (Number(e.shares) || 0), 0);
    const usd = buys.reduce((a, e) => a + (Number(e.amountUsd) || Number(e.fillPrice) * Number(e.shares) || 0), 0);
    const fees = buys.reduce((a, e) => a + (Number(e.feeUsd) || 0), 0);
    return {
      nextStage, done, stage: done ? null : stages[nextStage],
      baseAlloc, carryIn, available, remainingBudget, paid,
      totalBudget: s.totalBudget,
      usageRate: s.totalBudget > 0 ? paid / s.totalBudget : 0,
      buyCount: buys.length, skipCount: entries.length - buys.length,
      lastBuy, refPrice: lastBuy ? Number(lastBuy.fillPrice) : null,
      totalShares: shares, totalUsd: usd, totalFeeUsd: fees,
      avgUsd: shares > 0 ? usd / shares : null,
      avgYen: shares > 0 ? paid / shares : null,
    };
  }

  function targetPrice(refPrice, drop) {
    if (!(refPrice > 0) || drop == null) return null;
    return refPrice * (1 - drop);
  }

  /** 先の各段階の目標価格（直前の実約定価格を起点に連鎖させた参考値） */
  function projectedTargets(refPrice, s, fromStage) {
    const out = [];
    let p = refPrice;
    for (let i = fromStage; i < s.stages.length; i++) {
      const st = s.stages[i];
      if (st.type !== 'drop' || !(p > 0)) { out.push(null); continue; }
      p = p * (1 - st.drop);
      out.push(p);
    }
    return out;
  }

  /**
   * 購入条件の判定
   * quote: { price }, rsi: { confirmed, provisional }
   */
  function evaluateCondition(state, s, price, rsi) {
    const ps = planStatus(state, s);
    if (ps.done) return { stage: null, done: true, met: false };
    const st = ps.stage;
    if (st.type === 'rsi') {
      const v = rsi && rsi.confirmed != null ? rsi.confirmed : null;
      const met = v != null && v <= s.rsiThreshold;
      const provisionalMet = rsi && rsi.provisional != null && rsi.provisional <= s.rsiThreshold;
      return { stage: ps.nextStage, type: 'rsi', met, provisionalMet, rsi: v, threshold: s.rsiThreshold };
    }
    const ref = ps.refPrice;
    const target = targetPrice(ref, st.drop);
    if (!(price > 0) || !(target > 0)) return { stage: ps.nextStage, type: 'drop', met: false, ref, target };
    const dropNow = (ref - price) / ref; // 正=下落
    const remainingPct = (price - target) / price; // 目標まであと何%下落が必要か
    const met = price <= target + EPS;
    return { stage: ps.nextStage, type: 'drop', met, ref, target, dropNow, remainingPct, price };
  }

  /**
   * 条件到達履歴の更新（重複記録しない）。返り値: { state, event|null }
   * 到達 → 反発 → 再到達 の場合、再到達は新しい履歴として残る。
   */
  function updateTouchHistory(state, cond, now, price) {
    const hist = state.touches || [];
    const key = 'stage' + cond.stage;
    const flags = Object.assign({}, state.touchFlags || {});
    let event = null;
    const was = !!flags[key];
    if (cond.met && !was) {
      event = { stage: cond.stage, at: now, price: price ?? null, target: cond.target ?? null, rsi: cond.rsi ?? null, type: cond.type };
      hist.push(event);
    }
    if (cond.met) flags[key] = true;
    else if (was && !cond.met) { flags[key] = false; if (hist.length) hist[hist.length - 1].reboundAt = hist[hist.length - 1].reboundAt || now; }
    return { state: Object.assign({}, state, { touches: hist, touchFlags: flags }), event };
  }

  /** 表示用の条件状態（反発時の扱いを設定で切替） */
  function displayCondition(state, s, cond) {
    const touchedThisStage = (state.touches || []).some(t => t.stage === cond.stage);
    if (s.reboundMode === 'latch') return { reached: cond.met || touchedThisStage, currentlyMet: cond.met, touched: touchedThisStage };
    return { reached: cond.met, currentlyMet: cond.met, touched: touchedThisStage };
  }

  // ---------- RSI（Wilder） ----------
  function rsiWilder(closes, period) {
    period = period || 14;
    if (!closes || closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let ag = gain / period, al = loss / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (al === 0) return ag === 0 ? 50 : 100;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
  }

  /**
   * 週足の確定・暫定を分けてRSIを計算
   * bars: 古い順 [{ date:'YYYY-MM-DD'(週の初日), close }]
   * nowNy: ニューヨーク時間のDate相当 {y,m,d,dow,minutes}
   */
  function weeklyRsi(bars, period, nowNyIso) {
    if (!bars || !bars.length) return { confirmed: null, provisional: null };
    const last = bars[bars.length - 1];
    const lastIsOpen = isWeekStillForming(last.date, nowNyIso);
    const closes = bars.map(b => Number(b.close));
    const confirmedCloses = lastIsOpen ? closes.slice(0, -1) : closes;
    return {
      confirmed: rsiWilder(confirmedCloses, period),
      provisional: lastIsOpen ? rsiWilder(closes, period) : null,
      confirmedWeek: lastIsOpen ? (bars[bars.length - 2] || {}).date : last.date,
      provisionalWeek: lastIsOpen ? last.date : null,
    };
  }

  /** 週足バーの日付(その週の月曜など)と現在NY時刻(ISO 'YYYY-MM-DDTHH:mm')から、その週がまだ形成中か */
  function isWeekStillForming(weekDate, nowNyIso) {
    const wd = new Date(weekDate + 'T00:00:00Z');
    const dow = wd.getUTCDay();
    const monday = new Date(wd.getTime() - ((dow + 6) % 7) * 86400000);
    const fridayClose = new Date(monday.getTime() + 4 * 86400000 + 16 * 3600000); // 金曜16:00(NY)
    const now = new Date(nowNyIso + ':00Z'); // NYローカル時刻をUTCとして同一基準で比較
    return now < fridayClose;
  }

  // ---------- データ鮮度 ----------
  /**
   * quote: { price, ts(ms), session:'regular'|'pre-market'|'post-market'|null, isOpen, error }
   * 返り値: { label, usable, reason }
   */
  function quoteFreshness(quote, nowMs, s) {
    if (!quote || quote.error) return { label: 'エラー', code: 'error', usable: false, reason: quote && quote.error ? quote.error : '未取得' };
    if (!(quote.price > 0) || !quote.ts) return { label: 'エラー', code: 'error', usable: false, reason: '価格データなし' };
    const ageMin = (nowMs - quote.ts) / 60000;
    if (quote.isOpen && quote.session === 'regular') {
      if (ageMin <= 1.5) return { label: 'リアルタイム', code: 'live', usable: true, ageMin };
      if (ageMin <= s.staleMinutesOpen) return { label: '遅延', code: 'delayed', usable: true, ageMin };
      return { label: '更新停止', code: 'stale', usable: false, ageMin, reason: `取引時間中ですが${Math.round(ageMin)}分間更新されていません` };
    }
    if (quote.isOpen && (quote.session === 'pre-market' || quote.session === 'post-market' || quote.session === 'overnight')) {
      return { label: '時間外', code: 'extended', usable: true, ageMin };
    }
    return { label: '休場', code: 'closed', usable: true, ageMin };
  }

  function fxFreshness(fx, nowMs, s) {
    if (!fx || fx.error) return { label: 'エラー', code: 'error', usable: false, reason: fx && fx.error ? fx.error : '未取得' };
    if (!(fx.market > 0) || !fx.ts) return { label: 'エラー', code: 'error', usable: false, reason: 'レートなし' };
    const ageMin = (nowMs - fx.ts) / 60000;
    // 為替は週末休場。土日は古くても使用可とし「休場」表示。
    if (fx.marketClosed) return { label: '休場', code: 'closed', usable: true, ageMin };
    if (ageMin > s.staleMinutesFx) return { label: '更新停止', code: 'stale', usable: false, ageMin, reason: `${Math.round(ageMin)}分間更新されていません` };
    return { label: ageMin <= 2 ? 'リアルタイム' : '遅延', code: ageMin <= 2 ? 'live' : 'delayed', usable: true, ageMin };
  }

  // ---------- 購入実績の登録 ----------
  function buildBuyEntry(state, s, input) {
    const ps = planStatus(state, s);
    if (ps.done) throw new Error('全5回の購入計画は完了しています');
    const shares = Number(input.shares);
    const fillPrice = Number(input.fillPrice);
    if (!(shares > 0) || !Number.isInteger(shares)) throw new Error('株数は1以上の整数で入力してください');
    if (!(fillPrice > 0)) throw new Error('約定単価を入力してください');
    const fxRate = Number(input.fxRate) || null;
    const amountUsd = input.amountUsd ? Number(input.amountUsd) : Math.round(fillPrice * shares * 1e6) / 1e6;
    const feeUsd = input.feeUsd !== undefined && input.feeUsd !== '' ? Number(input.feeUsd) : commissionUsd(amountUsd, s);
    let paidYen = Number(input.paidYen);
    let paidIsActual = true;
    if (!(paidYen > 0)) {
      if (!(fxRate > 0)) throw new Error('受渡金額（円）か適用為替レートのどちらかを入力してください');
      paidYen = roundTo((amountUsd + feeUsd) * fxRate, 0, s.yenRounding);
      paidIsActual = false;
    }
    if (paidYen > ps.remainingBudget + EPS) throw new Error(`受渡金額 ${paidYen.toLocaleString()}円 が総残予算 ${ps.remainingBudget.toLocaleString()}円 を超えています`);
    return {
      id: input.id || ('e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      kind: 'buy', stage: ps.nextStage, date: input.date, fillPrice, shares, fxRate,
      amountUsd, feeUsd, paidYen, paidIsActual,
      amountYen: fxRate ? amountUsd * fxRate : null,
      estimate: input.estimate || null, note: input.note || '',
      remainingAfter: ps.remainingBudget - paidYen,
      carryNext: (ps.available - paidYen),
      nextRefPrice: fillPrice,
      createdAt: input.createdAt || new Date().toISOString(),
    };
  }

  function buildSkipEntry(state, s, input) {
    const ps = planStatus(state, s);
    if (ps.done) throw new Error('計画は完了しています');
    if (ps.stage.type === 'rsi' || !ps.lastBuy) throw new Error('初回は見送りで先へ進めません（基準となる約定価格がないため）');
    return { id: 'e' + Date.now().toString(36), kind: 'skip', stage: ps.nextStage, date: input.date, note: input.note || '', createdAt: new Date().toISOString() };
  }

  function toCsv(state, s) {
    const head = ['購入回', '種別', '購入日', '約定単価USD', '株数', '為替レート', '約定代金USD', '手数料USD', '円貨受渡金額', '受渡金額区分', '購入後残予算', '次回繰越金', '次回基準価格', '備考'];
    const rows = [head];
    for (const e of activeEntries(state)) {
      const name = s.stages[e.stage] ? s.stages[e.stage].name : e.stage + 1;
      if (e.kind === 'skip') { rows.push([name, '見送り', e.date, '', '', '', '', '', '', '', '', '', '', e.note]); continue; }
      rows.push([name, '購入', e.date, e.fillPrice, e.shares, e.fxRate ?? '', e.amountUsd, e.feeUsd, e.paidYen, e.paidIsActual ? '実績' : '試算', e.remainingAfter, e.carryNext, e.nextRefPrice, e.note]);
    }
    return '﻿' + rows.map(r => r.map(v => {
      const t = String(v ?? '');
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    }).join(',')).join('\r\n');
  }

  // ---------- 相場環境（参考指標） ----------
  /** 日足（古い順）から、直近の高値と現在の下落率を求める */
  function drawdownFromHigh(bars) {
    if (!bars || !bars.length) return null;
    let hi = -Infinity, hiDate = null;
    for (const b of bars) { const c = Number(b.close); if (c > hi) { hi = c; hiDate = b.date; } }
    const last = bars[bars.length - 1];
    const lastClose = Number(last.close);
    if (!(hi > 0) || !(lastClose > 0)) return null;
    return { high: hi, highDate: hiDate, last: lastClose, lastDate: last.date, dd: (hi - lastClose) / hi };
  }

  /**
   * 資料「VIXとSOXL」（2026年11月）のシグナル一覧を評価する。
   * 返り値の dir: 'down'=下落継続を示す / 'wait'=条件未到達（待ち） / 'up'=反発を示す / 'buy'=買いの条件に到達 / null=該当なし・不明
   * 購入条件の判定には使わない（参考表示のみ）。
   */
  function marketSignals(input, s) {
    const { soxlRsi, semiRsi, spDd, vix, zbt, zbtFired, divergence } = input;
    const out = [];
    // 1) VIX29突破 × S&P500下落率
    {
      let state = '未入力', dir = null;
      if (vix != null) {
        if (vix >= s.envVixLine && spDd != null && spDd * 100 >= s.envVixDdPct) { state = '該当（過去は最終20%前後の下落が多い）'; dir = 'down'; }
        else if (vix >= s.envVixLine) { state = `VIX ${s.envVixLine}超（下落率は${s.envVixDdPct}%未満）`; }
        else state = `VIX ${s.envVixLine}未満`;
      }
      out.push({ key: 'vix', label: `VIX（${s.envVixLine}突破時のS&P500下落率）`, value: vix, line: `${s.envVixLine}突破かつ下落${s.envVixDdPct}%以上`, state, dir, manual: input.vixManual === true });
    }
    // 2) S&P500 高値からの下落率
    {
      let state = '未取得', dir = null;
      if (spDd != null) {
        const pct = spDd * 100;
        if (pct >= s.envBuyZoneDdPct) { state = 'SOXL買い場の前提に到達'; dir = 'buy'; }
        else { state = `まだ甘い（あと${(s.envBuyZoneDdPct - pct).toFixed(1)}%）`; dir = 'wait'; }
      }
      out.push({ key: 'spdd', label: 'S&P500 高値からの下落', value: spDd, line: `約${s.envBuyZoneDdPct}%でSOXL買い場`, state, dir });
    }
    // 3) SOXL 週足RSI（確定）
    {
      let state = '未取得', dir = null;
      if (soxlRsi != null) { if (soxlRsi <= s.rsiThreshold) { state = '買いシグナル点灯'; dir = 'buy'; } else { state = 'まだ未点灯'; dir = 'wait'; } }
      out.push({ key: 'soxlrsi', label: 'SOXL 週足RSI（確定）', value: soxlRsi, line: `${s.rsiThreshold}以下で買い（週末確定）`, state, dir });
    }
    // 4) 半導体 週足RSI
    {
      let state = '未取得', dir = null;
      if (semiRsi != null) { if (semiRsi <= s.envSemiRsiLine) { state = '底の目安に到達'; dir = 'buy'; } else { state = 'まだ未到達'; dir = 'wait'; } }
      out.push({ key: 'semirsi', label: '半導体 週足RSI（SOX指数の代替：SOXX）', value: semiRsi, line: `過去の底は${s.envSemiRsiLine}付近`, state, dir });
    }
    // 5) SOXL 日足ダイバージェンス
    {
      const map = { active: ['強気で発生中', 'up'], gone: ['消滅（安値を深く更新）', 'down'], none: ['なし', null] };
      const [state, dir] = map[divergence] || ['未入力', null];
      out.push({ key: 'div', label: 'SOXL 日足ダイバージェンス', value: null, line: '安値をもう一段深く更新すると消滅', state, dir, manual: true });
    }
    // 6) ZBT インジケーター
    {
      let state = '未入力', dir = null;
      if (zbtFired) { state = '発動'; dir = 'up'; }
      else if (zbt != null) { if (zbt < s.envZbtLow) { state = '売られすぎ（いずれ発動の可能性）'; dir = 'up'; } else state = '未発動'; }
      out.push({ key: 'zbt', label: 'ZBT インジケーター', value: zbt, line: `${s.envZbtLow}未満で売られすぎ／発動で反発`, state, dir, manual: true });
    }
    const count = d => out.filter(x => x.dir === d).length;
    return { items: out, down: count('down'), wait: count('wait'), up: count('up'), buy: count('buy') };
  }

  /**
   * VIXの値を選ぶ。自動取得（Cboe/FRED）と手入力のうち、新しいほうを使う。
   * auto: { vix, source, kind, asOf, fetchedAt } / manual: { vix, vixAt }
   */
  function pickVix(auto, manual) {
    const a = auto && auto.vix > 0 ? auto : null;
    const m = manual && manual.vix != null && manual.vixAt ? manual : null;
    if (a && (!m || (a.fetchedAt || 0) >= m.vixAt)) {
      const label = a.source === 'Cboe' ? `Cboe・約15分遅れ（${a.asOf || '時刻不明'}${a.asOfTz ? ' ' + a.asOfTz : ''}）`
        : a.source === 'FRED' ? `FRED・終値（${a.asOf || '日付不明'}）` : String(a.source || '自動');
      return { value: a.vix, source: a.source, label, auto: true, changePct: a.changePct ?? null };
    }
    if (m) return { value: m.vix, source: 'manual', label: '手入力', auto: false, changePct: null };
    return { value: null, source: null, label: '未取得', auto: false, changePct: null };
  }

  /** ISO週の識別子（チェックリストの週ごとのリセット用） 例 '2026-W47' */
  function isoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y = d.getUTCFullYear();
    const wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return `${y}-W${String(wk).padStart(2, '0')}`;
  }

  // ---------- 保存データの検証（復元・読込時） ----------
  const SECRET_KEYS = ['appToken'];
  /** 入れ子のオブジェクトから秘密情報のキーを取り除いた複製を返す */
  function stripSecrets(obj) {
    if (obj === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(obj, (k, v) => SECRET_KEYS.includes(k) ? undefined : v)); } catch (_) { return null; }
  }
  const finite = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
  const str = (v, max) => v == null ? '' : String(v).slice(0, max || 500);
  const isoish = v => (typeof v === 'string' && /^[0-9TZ:.\-+ ]{8,40}$/.test(v)) ? v : null;
  const dateStr = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : '';
  const msOrIso = v => typeof v === 'number' ? (isFinite(v) ? v : null) : isoish(v);

  function sanitizeSettings(raw) {
    const d = defaultSettings();
    const out = { ...d };
    if (!raw || typeof raw !== 'object') return out;
    for (const k of Object.keys(d)) {
      if (k === 'stages' || !(k in raw)) continue;
      const def = d[k];
      if (typeof def === 'number') { const n = finite(raw[k]); if (n != null && n >= 0) out[k] = n; }
      else if (typeof def === 'boolean') out[k] = raw[k] === true;
      else if (typeof def === 'string') out[k] = str(raw[k], 300);
    }
    if (!['ceil', 'floor', 'round'].includes(out.feeRounding)) out.feeRounding = d.feeRounding;
    if (!['ceil', 'floor', 'round'].includes(out.yenRounding)) out.yenRounding = d.yenRounding;
    if (!['history', 'latch'].includes(out.reboundMode)) out.reboundMode = d.reboundMode;
    if (out.workerUrl && !/^https:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._~\-\/]*)?$/.test(out.workerUrl)) out.workerUrl = '';
    if (Array.isArray(raw.stages) && raw.stages.length === d.stages.length) {
      out.stages = d.stages.map((def, i) => {
        const r = raw.stages[i] || {};
        const alloc = finite(r.alloc);
        const drop = finite(r.drop);
        return { ...def, alloc: alloc != null && alloc >= 0 ? alloc : def.alloc, drop: def.type === 'drop' && drop != null && drop > 0 && drop < 1 ? drop : def.drop };
      });
    }
    if (typeof raw.appToken === 'string') out.appToken = str(raw.appToken, 200);
    return out;
  }

  function sanitizeEntry(e) {
    if (!e || typeof e !== 'object' || !['buy', 'skip'].includes(e.kind)) return null;
    const base = {
      id: str(e.id, 40).replace(/[^A-Za-z0-9_\-]/g, '') || ('e' + Math.random().toString(36).slice(2, 10)),
      kind: e.kind, stage: Math.max(0, Math.floor(finite(e.stage) || 0)), date: dateStr(e.date), note: str(e.note, 500),
      createdAt: isoish(e.createdAt), deleted: e.deleted === true, deletedAt: isoish(e.deletedAt), editedAt: isoish(e.editedAt),
    };
    if (e.kind === 'skip') return base;
    const shares = finite(e.shares), fillPrice = finite(e.fillPrice), paidYen = finite(e.paidYen);
    if (!(shares > 0) || !Number.isInteger(shares) || !(fillPrice > 0) || !(paidYen >= 0)) return null;
    const amountUsd = finite(e.amountUsd);
    return {
      ...base, fillPrice, shares, paidYen,
      fxRate: finite(e.fxRate), amountUsd: amountUsd != null ? amountUsd : fillPrice * shares,
      feeUsd: finite(e.feeUsd) || 0, paidIsActual: e.paidIsActual !== false,
      amountYen: finite(e.amountYen), remainingAfter: finite(e.remainingAfter), carryNext: finite(e.carryNext),
      nextRefPrice: fillPrice, estimate: null,
    };
  }

  /**
   * 外部から読み込んだデータ（JSON復元・自動バックアップ・端末内保存）を検証し、
   * 想定どおりの型の値だけを残す。画面へ不正なHTMLや値が入るのを防ぐ。
   */
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) throw new Error('このアプリのデータ形式ではありません');
    const settings = sanitizeSettings(raw.settings);
    const entries = raw.entries.slice(0, 100).map(sanitizeEntry);
    if (entries.some(e => e === null)) throw new Error('購入記録に不正な値が含まれています');
    const touches = (Array.isArray(raw.touches) ? raw.touches : []).slice(-500).map(t => ({
      stage: Math.max(0, Math.floor(finite(t && t.stage) || 0)), at: msOrIso(t && t.at), price: finite(t && t.price),
      target: finite(t && t.target), rsi: finite(t && t.rsi), type: t && t.type === 'rsi' ? 'rsi' : 'drop', reboundAt: msOrIso(t && t.reboundAt),
    }));
    const notifs = (Array.isArray(raw.notifs) ? raw.notifs : []).slice(0, 100).map(n => ({ at: finite(n && n.at), title: str(n && n.title, 200), body: str(n && n.body, 500) }));
    const audit = (Array.isArray(raw.audit) ? raw.audit : []).slice(0, 300).map(a => ({ at: isoish(a && a.at), action: str(a && a.action, 100), detail: stripSecrets(a && a.detail) }));
    const flags = {};
    if (raw.touchFlags && typeof raw.touchFlags === 'object') for (const [k, v] of Object.entries(raw.touchFlags)) if (/^stage\d+$/.test(k)) flags[k] = v === true;
    const notifKeys = {};
    if (raw.notifKeys && typeof raw.notifKeys === 'object') for (const [k, v] of Object.entries(raw.notifKeys)) if (/^[A-Za-z0-9\-]{1,60}$/.test(k) && finite(v) != null) notifKeys[k] = finite(v);
    const em = raw.envManual && typeof raw.envManual === 'object' ? raw.envManual : {};
    const envManual = {
      vix: finite(em.vix), vixAt: finite(em.vixAt), zbt: finite(em.zbt), zbtFired: em.zbtFired === true, zbtAt: finite(em.zbtAt),
      divergence: ['active', 'gone', 'none'].includes(em.divergence) ? em.divergence : null, divAt: finite(em.divAt),
    };
    const cl = raw.checklist && typeof raw.checklist === 'object' ? raw.checklist : {};
    const checklist = { week: typeof cl.week === 'string' && /^\d{4}-W\d{2}$/.test(cl.week) ? cl.week : null, items: {} };
    if (cl.items && typeof cl.items === 'object') for (const [k, v] of Object.entries(cl.items)) if (/^[a-z0-9]{1,20}$/.test(k)) checklist.items[k] = v === true;
    return { version: 1, settings, entries, touches, touchFlags: flags, notifs, notifKeys, audit, envManual, checklist };
  }

  /** バックアップ書き出し用：秘密情報（アプリトークン）を除く */
  function exportState(state) {
    const settings = { ...state.settings };
    for (const k of SECRET_KEYS) delete settings[k];
    const { cache, manual, ...rest } = state;
    return { ...stripSecrets(rest), settings, exportedAt: new Date().toISOString() };
  }

  const Core = {
    sanitizeState, sanitizeSettings, exportState, stripSecrets, drawdownFromHigh, marketSignals, isoWeekKey, pickVix,
    defaultSettings, roundTo, commissionUsd, appliedRate, estimate, maxShares,
    planStatus, targetPrice, projectedTargets, evaluateCondition, updateTouchHistory, displayCondition,
    rsiWilder, weeklyRsi, isWeekStillForming, quoteFreshness, fxFreshness,
    buildBuyEntry, buildSkipEntry, activeEntries, toCsv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
