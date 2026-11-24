"""起動直後、端末に残った古い値で誤って「更新されていません」と通知しないことの確認。
実行: python3 scripts/startup_stale_test.py"""
import json, time, threading, http.server, functools, os, datetime
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8768), h); threading.Thread(target=srv.serve_forever, daemon=True).start()

# 2026-11-24(火) 08:56 JST = 11-23(月) 18:56 NY（為替は開場中・米国株は時間外）
T0 = datetime.datetime(2026, 11, 23, 23, 56, 39, tzinfo=datetime.timezone.utc)
T0MS = int(T0.timestamp() * 1000)
mode = {'fx_fail': False}
bars = [{'date': f'2025-{(i//4)%12+1:02d}-{(i%4)*7+1:02d}', 'close': 60 - i} for i in range(40)]

pending = []
def route(r):
    pending.append(r)  # 応答をすぐ返さず保留（遅いWorkerの再現）。respond_all() でまとめて返す

def respond(r):
    k = r.request.url.split('/api/')[1].split('?')[0]
    if k == 'fx' and mode['fx_fail']:
        return r.fulfill(status=502, content_type='application/json', body=json.dumps({'error': 'データ提供元の応答エラー（HTTP 500）'}), headers={'Access-Control-Allow-Origin': '*'})
    b = {'quote': {'source': 'Finnhub', 'price': 31.2, 'ts': T0MS - 60000, 'isOpen': True, 'session': 'post-market'},
         'fx': {'source': 'Twelve Data', 'market': 156.8, 'ts': T0MS - 30000, 'marketClosed': False},
         'weekly': {'bars': bars}, 'market': {'spy': [{'date': '2026-10-06', 'close': 600}], 'soxx': bars},
         'vix': {'source': 'FRED', 'vix': 27.1, 'asOf': '2026-11-20'}}[k]
    b['fetchedAt'] = T0MS
    r.fulfill(status=200, content_type='application/json', body=json.dumps(b), headers={'Access-Control-Allow-Origin': '*'})

old = T0MS - 1162 * 60000  # 1162分前（前日13:34ごろ）
state = {'version': 1, 'settings': {'workerUrl': 'https://mock.workers.dev'}, 'entries': [],
         'cache': {'quote': {'source': 'Finnhub', 'price': 30.5, 'ts': old, 'isOpen': True, 'session': 'regular', 'fetchedAt': old},
                   'fx': {'source': 'Twelve Data', 'market': 156.2, 'ts': old, 'marketClosed': False, 'fetchedAt': old}}}

def run(fx_fail):
    mode['fx_fail'] = fx_fail
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(locale='ja-JP', timezone_id='Asia/Tokyo')
        ctx.route('https://mock.workers.dev/**', route)
        ctx.add_init_script(f"localStorage.setItem('soxl-nanpin-v1', {json.dumps(json.dumps(state))})")
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.clock.install(time=T0)
        pending.clear()
        pg.goto('http://127.0.0.1:8768/index.html'); pg.wait_for_timeout(600)
        early = pg.inner_text('main')
        notifs_early = pg.evaluate("JSON.parse(localStorage.getItem('soxl-nanpin-v1')).notifs.map(n=>n.title)")
        assert pending, '取得要求が発生していない'
        for r in list(pending): respond(r)
        pending.clear()
        pg.wait_for_timeout(1500)  # 取得完了を待つ
        late = pg.inner_text('main')
        notifs_late = pg.evaluate("JSON.parse(localStorage.getItem('soxl-nanpin-v1')).notifs.map(n=>n.title)")
        b.close()
        return early, notifs_early, late, notifs_late, errs

# 1) 取得が成功する場合: 起動直後も取得後も「更新されていません」は出ない
early, ne, late, nl, errs = run(False)
assert not any('更新されていません' in t for t in ne + nl), (ne, nl)
assert '更新中…' in early, early[:400]
assert '156.80' in late and '更新中…' not in late, late[:600]
print('成功時: 起動直後は「更新中…」、取得後は最新値。誤通知なし ✓')

# 2) 取得に失敗した場合: 取得を試したあとなら正しく警告・通知する
early, ne, late, nl, errs2 = run(True)
assert not any('為替レートが更新されていません' in t for t in ne), ne
assert any('為替レートが更新されていません' in t or '為替レートの取得に失敗' in t for t in nl), nl
print('失敗時: 起動直後は通知せず、取得失敗を確認してから通知 ✓', nl)
srv.shutdown()
print('ERRORS' if errs or errs2 else 'OK', errs + errs2)
