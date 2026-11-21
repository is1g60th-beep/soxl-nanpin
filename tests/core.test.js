// 必須テストケース（仕様書 15章）  実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const S = () => C.defaultSettings();
const fx = (market, applied) => ({ market, applied });
const buy = (stage, fillPrice, shares, paidYen) => ({ kind: 'buy', stage, fillPrice, shares, paidYen, amountUsd: fillPrice * shares, feeUsd: 0, id: 'x' + stage });
const near = (a, b, d = 1e-9) => assert.ok(Math.abs(a - b) < d, `${a} ≠ ${b}`);

// 総支払見込額 ≤ 投入可能額、かつ +1株で超える ことを確認
function assertMax(r, avail) {
  assert.ok(r.totalYen <= avail, `総支払 ${r.totalYen} > 投入可能 ${avail}`);
}

test('1. SOXL 20ドル・為替159.72円の購入計算', () => {
  const s = S();
  const r = C.maxShares(500000, 20, fx(159.72), s);
  // 適用レート 159.72+0.25=159.97、1株あたり 20×1.00495×159.97≒3215.2円 → 155株
  assert.equal(r.rate, 159.97);
  assert.equal(r.shares, 155);
  assert.equal(r.amountUsd, 3100);
  assert.equal(r.feeUsd, 15.35); // 3100×0.495%=15.345 → セント切上げ
  assert.equal(r.totalYen, Math.ceil(3115.35 * 159.97));
  assertMax(r, 500000);
  assert.equal(r.leftoverYen, 500000 - r.totalYen);
  near(r.fxCostYen, 0.25 * 3115.35, 1e-6);
});

test('2. SOXLが15ドルに下落した場合は買える株数が増える', () => {
  const s = S();
  const a = C.maxShares(500000, 20, fx(159.72), s);
  const b = C.maxShares(500000, 15, fx(159.72), s);
  assert.ok(b.shares > a.shares);
  assert.equal(b.shares, 207);
  assertMax(b, 500000);
});

test('3. SOXLが25ドルに上昇した場合', () => {
  const r = C.maxShares(500000, 25, fx(159.72), S());
  assert.equal(r.shares, 124);
  assertMax(r, 500000);
});

test('4. 円高・円安で株数が変わる', () => {
  const s = S();
  const strong = C.maxShares(500000, 20, fx(140), s);
  const weak = C.maxShares(500000, 20, fx(170), s);
  assert.ok(strong.shares > weak.shares);
  assertMax(strong, 500000); assertMax(weak, 500000);
});

test('5. 確定週足RSIが30以下 → 初回条件到達', () => {
  const c = C.evaluateCondition({ entries: [] }, S(), 20, { confirmed: 28.4, provisional: 31 });
  assert.equal(c.type, 'rsi'); assert.equal(c.met, true);
});

test('6. RSIが30超 → 未達（暫定値だけ30以下でも確定扱いにしない）', () => {
  const c = C.evaluateCondition({ entries: [] }, S(), 20, { confirmed: 35, provisional: 29 });
  assert.equal(c.met, false); assert.equal(c.provisionalMet, true);
});

test('7. 初回20ドル → 18ドルで②到達', () => {
  const st = { entries: [buy(0, 20, 155, 498363)] };
  near(C.evaluateCondition(st, S(), 18.0, null).target, 18);
  assert.equal(C.evaluateCondition(st, S(), 18.01, null).met, false);
  assert.equal(C.evaluateCondition(st, S(), 18.0, null).met, true);
});

test('8. 18ドル → 17.10ドルで③到達', () => {
  const st = { entries: [buy(0, 20, 155, 498363), buy(1, 18, 40, 115000)] };
  const c = C.evaluateCondition(st, S(), 17.10, null);
  near(c.target, 17.1); assert.equal(c.met, true);
  assert.equal(C.evaluateCondition(st, S(), 17.11, null).met, false);
});

test('9. 17.10ドル → 16.245ドルで④到達、先の目標は15.43275', () => {
  const st = { entries: [buy(0, 20, 1, 3300), buy(1, 18, 1, 3000), buy(2, 17.1, 1, 2800)] };
  const c = C.evaluateCondition(st, S(), 16.245, null);
  near(c.target, 16.245); assert.equal(c.met, true);
  const proj = C.projectedTargets(20, S(), 1);
  near(proj[0], 18); near(proj[1], 17.1); near(proj[2], 16.245); near(proj[3], 15.43275);
});

test('10. 目標到達後に反発: 履歴は残り、現在状況は未達（latchモードは到達扱い継続）', () => {
  const s = S();
  let st = { entries: [buy(0, 20, 155, 498363)], touches: [], touchFlags: {} };
  let c = C.evaluateCondition(st, s, 17.9, null);
  let u = C.updateTouchHistory(st, c, 't1', 17.9); st = u.state;
  assert.ok(u.event);
  c = C.evaluateCondition(st, s, 18.5, null);
  u = C.updateTouchHistory(st, c, 't2', 18.5); st = u.state;
  assert.equal(u.event, null);
  assert.equal(st.touches.length, 1); assert.equal(st.touches[0].reboundAt, 't2');
  const d = C.displayCondition(st, s, c);
  assert.equal(d.reached, false); assert.equal(d.touched, true);
  const d2 = C.displayCondition(st, { ...s, reboundMode: 'latch' }, c);
  assert.equal(d2.reached, true); assert.equal(d2.currentlyMet, false);
  // 同じ到達状態が続いても重複記録しない
  c = C.evaluateCondition(st, s, 17.5, null); st = C.updateTouchHistory(st, c, 't3', 17.5).state;
  c = C.evaluateCondition(st, s, 17.4, null); const u4 = C.updateTouchHistory(st, c, 't4', 17.4);
  assert.equal(u4.event, null); assert.equal(u4.state.touches.length, 2);
});

test('11. 条件到達後に購入を見送った場合: 段階は進まず同じ条件を監視', () => {
  const s = S();
  const st = { entries: [buy(0, 20, 155, 498363)] };
  const c = C.evaluateCondition(st, s, 17.5, null);
  assert.equal(c.met, true);
  const ps = C.planStatus(st, s);
  assert.equal(ps.nextStage, 1); assert.equal(ps.refPrice, 20);
  // 明示的に「見送って次回へ」した場合: 基準価格は直前の約定価格のまま、投入枠は繰越
  const skip = C.buildSkipEntry(st, s, { date: '2026-11-21' });
  const st2 = { entries: [...st.entries, skip] };
  const ps2 = C.planStatus(st2, s);
  assert.equal(ps2.nextStage, 2); assert.equal(ps2.refPrice, 20);
  assert.equal(ps2.available, 500000 + 150000 + 150000 - 498363);
  near(C.evaluateCondition(st2, s, 19, null).target, 19); // 20×0.95
  assert.throws(() => C.buildSkipEntry({ entries: [] }, s, {}));
});

test('12. 実際の約定価格を登録 → 次回の基準価格になる（試算価格は使わない）', () => {
  const s = S();
  const e = C.buildBuyEntry({ entries: [] }, s, { date: '2026-11-21', fillPrice: 19.87, shares: 155, paidYen: 495000, estimate: { priceUsd: 20 } });
  const ps = C.planStatus({ entries: [e] }, s);
  assert.equal(ps.refPrice, 19.87);
  near(C.evaluateCondition({ entries: [e] }, s, 18, null).target, 19.87 * 0.9);
});

test('13. 繰越資金がある場合: 投入可能額 = 基本枠 + 繰越', () => {
  const ps = C.planStatus({ entries: [buy(0, 20, 155, 498363)] }, S());
  assert.equal(ps.carryIn, 1637);
  assert.equal(ps.available, 151637);
  assert.equal(ps.baseAlloc, 150000);
});

test('14. 手数料込みで1株も買えない場合は0株', () => {
  const r = C.maxShares(3000, 20, fx(159.72), S());
  assert.equal(r.shares, 0); assert.equal(r.totalYen, 0);
  const r2 = C.maxShares(0, 20, fx(159.72), S());
  assert.equal(r2.shares, 0);
});

test('15. 最終回の残予算が少ない場合は残予算が上限', () => {
  const s = S();
  // 実績受渡が試算より多く、⑤の時点で残予算が少ない
  const st = { entries: [buy(0, 20, 1, 500000), buy(1, 18, 1, 150000), buy(2, 17, 1, 150000), buy(3, 16, 1, 190000)] };
  const ps = C.planStatus(st, s);
  assert.equal(ps.nextStage, 4);
  assert.equal(ps.remainingBudget, 10000);
  assert.equal(ps.available, 10000);
  const r = C.maxShares(ps.available, 15, fx(150), s);
  assertMax(r, 10000); assert.equal(r.shares, 4);
});

test('16. 株価APIが停止 → 計算に使わない', () => {
  const f = C.quoteFreshness({ error: 'HTTP 503' }, Date.now(), S());
  assert.equal(f.usable, false); assert.equal(f.code, 'error');
  const g = C.quoteFreshness({ price: 20, ts: Date.now() - 20 * 60000, isOpen: true, session: 'regular' }, Date.now(), S());
  assert.equal(g.usable, false); assert.equal(g.code, 'stale');
});

test('17. 為替APIが停止 → 計算に使わない', () => {
  const f = C.fxFreshness({ error: 'timeout' }, Date.now(), S());
  assert.equal(f.usable, false);
  const g = C.fxFreshness({ market: 155, ts: Date.now() - 90 * 60000 }, Date.now(), S());
  assert.equal(g.usable, false);
  assert.equal(C.maxShares(500000, 20, fx(null), S()).ok, false);
});

test('18. 株価データ遅延を区別して表示', () => {
  const now = Date.now(), s = S();
  assert.equal(C.quoteFreshness({ price: 20, ts: now - 30000, isOpen: true, session: 'regular' }, now, s).code, 'live');
  assert.equal(C.quoteFreshness({ price: 20, ts: now - 3 * 60000, isOpen: true, session: 'regular' }, now, s).code, 'delayed');
  assert.equal(C.quoteFreshness({ price: 20, ts: now - 3 * 3600000, isOpen: false, session: null }, now, s).code, 'closed');
  assert.equal(C.quoteFreshness({ price: 20, ts: now - 60000, isOpen: true, session: 'pre-market' }, now, s).code, 'extended');
});

test('19. 実際の受渡金額が試算と異なる場合は実績を優先', () => {
  const s = S();
  const est = C.maxShares(500000, 20, fx(159.72), s);
  const e = C.buildBuyEntry({ entries: [] }, s, { date: 'd', fillPrice: 20, shares: est.shares, paidYen: est.totalYen + 1200, estimate: est });
  const ps = C.planStatus({ entries: [e] }, s);
  assert.equal(ps.paid, est.totalYen + 1200);
  assert.equal(ps.remainingBudget, 1000000 - est.totalYen - 1200);
  assert.equal(e.paidIsActual, true);
  // 受渡金額未入力なら適用レートから試算し「試算」と記録
  const e2 = C.buildBuyEntry({ entries: [] }, s, { date: 'd', fillPrice: 20, shares: 10, fxRate: 160 });
  assert.equal(e2.paidIsActual, false);
});

test('20. 総予算を超える株数・登録は出ない（ランダム検証）', () => {
  const s = S();
  for (let i = 0; i < 3000; i++) {
    const price = 3 + Math.random() * 80;
    const m = 100 + Math.random() * 80;
    const avail = Math.floor(Math.random() * 1100000);
    const cfg = { ...s, feeRounding: ['ceil', 'floor', 'round'][i % 3], priceBufferPct: i % 2 ? 0 : 1, otherCostYen: i % 5 };
    const r = C.maxShares(avail, price, fx(m), cfg);
    assert.ok(r.totalYen <= avail);
    assert.ok(C.estimate(r.shares + 1, price, fx(m), cfg).totalYen > avail);
  }
  // 残予算を超える受渡金額の登録は拒否
  const st = { entries: [buy(0, 20, 1, 900000)] };
  assert.throws(() => C.buildBuyEntry(st, s, { date: 'd', fillPrice: 18, shares: 100, paidYen: 150000 }));
  // 予算設定が小さくても投入可能額は残予算を超えない
  const ps = C.planStatus({ entries: [] }, { ...s, totalBudget: 300000 });
  assert.equal(ps.available, 300000);
});

test('追加: 手数料上限22ドル・RSI計算・週足確定判定', () => {
  const s = S();
  assert.equal(C.commissionUsd(10000, s), 22);
  assert.equal(C.commissionUsd(100, { ...s, feeFree: true }), 0);
  // RSI: 一様上昇は100、一様下落は0
  assert.equal(C.rsiWilder([...Array(20)].map((_, i) => i + 1), 14), 100);
  assert.equal(C.rsiWilder([...Array(20)].map((_, i) => 40 - i), 14), 0);
  // 2026-11-16(月)の週は 11/20(金)16:00 NYまで形成中
  assert.equal(C.isWeekStillForming('2026-11-16', '2026-11-20T15:59'), true);
  assert.equal(C.isWeekStillForming('2026-11-16', '2026-11-20T16:00'), false);
  const bars = [...Array(30)].map((_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, close: 30 - i * 0.5 }));
  bars[bars.length - 1].date = '2026-11-16';
  const w = C.weeklyRsi(bars, 14, '2026-11-18T10:00');
  assert.ok(w.provisional != null && w.confirmed != null);
});

test('セキュリティ: バックアップにアプリトークンを含めない（変更履歴の中も）', () => {
  const s = { ...S(), workerUrl: 'https://x.workers.dev', appToken: 'SECRET-TOKEN' };
  const st = { settings: s, entries: [], audit: [{ at: '2026-11-21T00:00:00Z', action: '設定変更', detail: { before: s, after: s } }], cache: { quote: 1 }, manual: { price: 20 } };
  const out = JSON.stringify(C.exportState(st));
  assert.ok(!out.includes('SECRET-TOKEN'));
  assert.ok(!out.includes('"cache"') && !out.includes('"manual"'));
});

test('セキュリティ: 不正な復元データを無害化・拒否', () => {
  const evil = {
    settings: { ...S(), workerUrl: 'javascript:alert(1)', feeRate: '<img src=x onerror=alert(1)>', stages: [{ alloc: '<b>' }] },
    entries: [{ kind: 'buy', shares: 155, fillPrice: 20, paidYen: 498363, note: '<script>x</script>', date: '<img>', id: '"><svg onload=1>' }],
    touches: [{ stage: '<x>', at: '<img>', price: 'NaN' }], notifs: [{ title: 1 }], touchFlags: { '<x>': true }, notifKeys: { '<x>': 1 },
  };
  const r = C.sanitizeState(evil);
  assert.equal(r.settings.workerUrl, '');
  assert.equal(r.settings.feeRate, S().feeRate);
  assert.equal(r.settings.stages[0].alloc, 500000);
  assert.equal(r.entries[0].date, '');
  assert.equal(r.entries[0].id.includes('<'), false);
  assert.equal(r.touches[0].at, null);
  assert.deepEqual(r.touchFlags, {}); assert.deepEqual(r.notifKeys, {});
  assert.equal(typeof r.entries[0].shares, 'number');
  assert.throws(() => C.sanitizeState({ settings: {}, entries: [{ kind: 'buy', shares: '1<b>', fillPrice: 20, paidYen: 1 }] }));
  assert.throws(() => C.sanitizeState({ settings: {} }));
  assert.throws(() => C.sanitizeState({ entries: [{ kind: 'hack' }] }));
  // 正常なバックアップは往復で一致
  const ok = { settings: S(), entries: [{ kind: 'buy', id: 'e1', stage: 0, date: '2026-11-21', shares: 155, fillPrice: 20, paidYen: 498363, amountUsd: 3100, feeUsd: 15.35 }] };
  const rt = C.sanitizeState(JSON.parse(JSON.stringify(C.exportState(ok))));
  assert.equal(C.planStatus(rt, rt.settings).available, C.planStatus(ok, ok.settings).available);
});
