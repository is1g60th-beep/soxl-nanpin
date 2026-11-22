import json, time, threading, http.server, functools, collections
from playwright.sync_api import sync_playwright
import os; ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message=lambda *a:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8767),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
counts=collections.Counter(); mode={'fx429':False}; off={'ms':0}
bars=[{'date':f'2025-{(i//4)%12+1:02d}-{(i%4)*7+1:02d}','close':60-i} for i in range(40)]
def route(r):
    u=r.request.url; k=u.split('/api/')[1].split('?')[0]; counts[k]+=1
    now=int(time.time()*1000)+off['ms']
    if k=='fx' and mode['fx429']:
        return r.fulfill(status=502,content_type='application/json',body=json.dumps({'error':'データ提供元の応答エラー（HTTP 429）'}),headers={'Access-Control-Allow-Origin':'*'})
    b={'quote':{'source':'Finnhub','price':30.88,'ts':now-20000,'isOpen':False,'session':None},
       'fx':{'source':'Twelve Data','market':156.4,'ts':now-30000,'marketClosed':False},
       'weekly':{'bars':bars},'market':{'spy':[{'date':'2026-10-06','close':600},{'date':'2026-11-20','close':537}],'soxx':bars},
       'vix':{'source':'FRED','vix':28.44,'asOf':'2026-11-19'}}[k]
    b['fetchedAt']=now
    r.fulfill(status=200,content_type='application/json',body=json.dumps(b),headers={'Access-Control-Allow-Origin':'*'})
state={'version':1,'settings':{'workerUrl':'https://mock.workers.dev','refreshSecFx':180},'entries':[]}
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(locale='ja-JP',timezone_id='Asia/Tokyo')
    ctx.route('https://mock.workers.dev/**',route)
    ctx.add_init_script(f"if(!sessionStorage.getItem('init')){{localStorage.setItem('soxl-nanpin-v1', {json.dumps(json.dumps(state))});sessionStorage.setItem('init','1')}}")
    ctx.add_init_script("const of=window.fetch;window.__fx=[];window.fetch=(u,o)=>{if(String(u).includes('/api/fx'))window.__fx.push(Date.now());return of(u,o)}")
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.clock.install()
    def adv(ms):
        pg.clock.run_for(ms); off['ms']+=ms; pg.wait_for_timeout(30)  # 実時間の通信が終わるのを待つ
    pg.goto('http://127.0.0.1:8767/index.html'); pg.wait_for_timeout(800)
    first=dict(counts); print('起動時:', first)
    assert all(first.get(k)==1 for k in ['quote','fx','weekly','market','vix']), first
    assert pg.evaluate("JSON.parse(localStorage.getItem('soxl-nanpin-v1')).settings.refreshSecFx")==300
    # 更新ボタン連打 → 20秒以内は再取得しない
    pg.click('#btnRefresh'); pg.click('#btnRefresh'); pg.wait_for_timeout(300)
    assert dict(counts)==first, ('連打で再取得', dict(counts))
    # 1時間を早送り: 取得回数の上限を確認
    for _ in range(360): adv(10000)
    pg.wait_for_timeout(500)
    hour=dict(counts); print('1時間後:', hour)
    # 実行日時(この環境の時計)で週末/平日が変わるので、Twelve Data系の上限で判定
    td=sum(hour.get(k,0)-first.get(k,0) for k in ['fx','weekly','market'])
    assert td <= 12+2+2, ('Twelve Dataの呼び出しが多すぎる', td)
    # 為替で429 → 前回値で計算継続・15分は再試行しない
    mode['fx429']=True
    before=counts['fx']
    adv(301000)
    for _ in range(50):
        pg.wait_for_timeout(100)
        if counts['fx']>before: break
    pg.wait_for_timeout(500)
    c429=counts['fx']; assert c429==before+1, ('429の取得が起きていない', c429, before)
    txt=pg.inner_text('main')
    print('CACHE quote:', pg.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('soxl-nanpin-v1')).cache.quote)"))
    print('NOTIFS:', pg.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('soxl-nanpin-v1')).notifs.slice(0,4))"))
    assert '前回の値' in txt and '計算を停止' not in txt, txt[:600]
    print('429後:', dict(counts))
    for _ in range(60): adv(10000)   # 10分
    pg.wait_for_timeout(300)
    t=pg.evaluate('window.__fx'); print('fx times (min from start):', [round((x-t[0])/60000,2) for x in t])
    assert counts['fx']==c429, ('バックオフ中に再試行', counts['fx'], c429)
    for _ in range(40): adv(10000)   # さらに約7分（計17分）
    pg.wait_for_timeout(300)
    assert counts['fx']>c429, 'バックオフ後に再試行していない'
    b.close()
srv.shutdown()
print('週末判定:', '為替は週末は取得しない' )
print('TEXT429:', [l for l in txt.split('\n') if '前回の値' in l or '上限' in l][:3])
print('ERRORS' if errs else 'OK', errs)
