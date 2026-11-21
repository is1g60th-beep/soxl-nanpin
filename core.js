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

  const Core = {
    defaultSettings, roundTo, commissionUsd, appliedRate, estimate, maxShares,
    planStatus, targetPrice, projectedTargets, evaluateCondition, updateTouchHistory, displayCondition,
    rsiWilder, weeklyRsi, isWeekStillForming, quoteFreshness, fxFreshness,
    buildBuyEntry, buildSkipEntry, activeEntries, toCsv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
