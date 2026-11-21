"""ブラウザでの動作確認（モックAPI）。実行: python3 scripts/e2e.py"""
import json, time, threading, http.server, functools, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(os.path.dirname(__file__), '..', 'shots')
os.makedirs(OUT, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

state = {'price': 20.0, 'fail_quote': False}
now_ms = lambda: int(time.time() * 1000)
# 週足: 下落トレンドで RSI が30を下回るデータ
bars = [{'date': f'2025-{(i // 4) % 12 + 1:02d}-{(i % 4) * 7 + 1:02d}', 'close': 60 - i * 1.2 + (2 if i % 3 == 0 else 0)} for i in range(40)]
bars[-1]['date'] = '2026-11-16'

def route(r):
    u = r.request.url
    if '/api/quote' in u:
        if state['fail_quote']:
            return r.fulfill(status=502, content_type='application/json', body=json.dumps({'error': 'HTTP 503'}), headers={'Access-Control-Allow-Origin': '*'})
        body = {'source': 'Finnhub', 'price': state['price'], 'ask': None, 'prevClose': 21, 'changePct': -2.1, 'ts': now_ms() - 20000, 'isOpen': True, 'session': 'regular', 'fetchedAt': now_ms()}
    elif '/api/fx' in u:
        body = {'source': 'Twelve Data', 'market': 159.72, 'ts': now_ms() - 30000, 'marketClosed': False, 'fetchedAt': now_ms()}
    else:
        body = {'source': 'Twelve Data', 'bars': bars, 'fetchedAt': now_ms()}
    r.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'Access-Control-Allow-Origin': '*'})

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='ja-JP', timezone_id='Asia/Tokyo')
    ctx.route('https://mock.workers.dev/**', route)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text) if '502' not in m.text else None)
    pg.on('dialog', lambda d: d.accept('消去') if d.type == 'prompt' else d.accept())

    # 1) 手入力モード（API未設定）
    pg.goto('http://127.0.0.1:8765/index.html'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/01_manual_mode.png', full_page=True)

    # 2) API設定 → 自動取得
    pg.evaluate("""() => { const s = JSON.parse(localStorage.getItem('soxl-nanpin-v1')); s.settings.workerUrl='https://mock.workers.dev'; localStorage.setItem('soxl-nanpin-v1', JSON.stringify(s)); }""")
    pg.reload(); pg.wait_for_timeout(1200)
    txt = pg.inner_text('main')
    assert '155株' in txt, txt[:800]
    pg.screenshot(path=f'{OUT}/02_home_rsi.png', full_page=True)

    # 3) 初回購入を登録
    pg.click('#btnBuy'); pg.wait_for_timeout(200)
    pg.fill('[name=fillPrice]', '20'); pg.fill('[name=paidYen]', '498400')
    pg.click('#dlgForm button[value=ok]'); pg.wait_for_timeout(500)
    txt = pg.inner_text('main')
    assert '② 追加' in txt and '$18.0000' in txt, txt[:1000]
    assert '151,600円' in txt, '繰越込み投入可能額'

    # 4) 18ドルまで下落 → 到達
    state['price'] = 17.95
    pg.click('#btnRefresh'); pg.wait_for_timeout(1000)
    txt = pg.inner_text('main')
    assert '購入条件 到達' in txt, txt[:600]
    pg.screenshot(path=f'{OUT}/03_stage2_hit.png', full_page=True)

    # 5) 反発 → 履歴は残る
    state['price'] = 18.6
    pg.click('#btnRefresh'); pg.wait_for_timeout(1000)
    txt = pg.inner_text('main')
    assert '一度到達→反発' in txt, txt[:600]

    # 6) 株価API停止 → 計算停止
    state['fail_quote'] = True
    pg.click('#btnRefresh'); pg.wait_for_timeout(1000)
    txt = pg.inner_text('main')
    assert '計算を停止' in txt, txt[:800]
    pg.screenshot(path=f'{OUT}/04_api_error.png', full_page=True)
    state['fail_quote'] = False

    # 7) 各画面
    for t in ['history', 'funds', 'settings']:
        pg.click(f'nav button[data-tab={t}]'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'{OUT}/05_{t}.png', full_page=True)

    # 8) 取消 → 初回に戻る
    pg.click('nav button[data-tab=history]'); pg.wait_for_timeout(200)
    pg.click('#btnUndo'); pg.wait_for_timeout(400)
    pg.click('nav button[data-tab=home]'); pg.wait_for_timeout(300)
    assert '① 初回' in pg.inner_text('main')

    # 9) バックアップ: トークンが含まれない／悪意あるJSONを復元しても中継URLは変わらずHTMLも実行されない
    pg.evaluate("""() => { const s = JSON.parse(localStorage.getItem('soxl-nanpin-v1')); s.settings.appToken='SECRET-TOKEN'; localStorage.setItem('soxl-nanpin-v1', JSON.stringify(s)); }""")
    pg.reload(); pg.wait_for_timeout(800)
    pg.click('nav button[data-tab=settings]'); pg.wait_for_timeout(300)
    with pg.expect_download() as dl: pg.click('#btnExport')
    text = open(dl.value.path(), encoding='utf-8').read()
    assert 'SECRET-TOKEN' not in text, 'token leaked in backup'
    evil = json.loads(text)
    evil['settings']['workerUrl'] = 'https://evil.example'
    evil['entries'] = [{'kind': 'buy', 'id': 'x', 'stage': 0, 'date': '2026-11-21', 'shares': 10, 'fillPrice': 20, 'paidYen': 32000, 'note': '<img src=x onerror="window.__pwned=1">'}]
    path = os.path.join(OUT, 'evil.json'); open(path, 'w').write(json.dumps(evil))
    pg.set_input_files('#fileImport', path); pg.wait_for_timeout(800)
    st = pg.evaluate("() => JSON.parse(localStorage.getItem('soxl-nanpin-v1')).settings")
    assert st['workerUrl'] == 'https://mock.workers.dev' and st['appToken'] == 'SECRET-TOKEN', st
    pg.click('nav button[data-tab=history]'); pg.wait_for_timeout(300)
    assert pg.evaluate('() => window.__pwned') is None, 'XSS executed'
    assert '<img src=x' in pg.inner_text('main')

    # iPad
    pg.set_viewport_size({'width': 820, 'height': 1180}); pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/06_ipad.png', full_page=False)
    b.close()

srv.shutdown()
if errors:
    print('ERRORS:', errors); sys.exit(1)
print('E2E OK')
