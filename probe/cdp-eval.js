// 通过 Android WebView 的 devtools 端口执行一段 JS，用来点探针页面上的能力按钮。
// 用法: node cdp-eval.js "document.getElementById('fs').click()"
const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

(async () => {
  const port = process.env.CDP_PORT || '9222';
  const list = await getJson('http://127.0.0.1:' + port + '/json/list');
  const page = list.find((p) => p.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 8000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
  const expression = process.argv.slice(2).join(' ') || '1+1';
  const id = ++seq;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), 120000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
    }));
  });
  console.log(JSON.stringify(reply, null, 2));
  ws.close();
})().catch((e) => {
  console.error('CDP_FAIL', e.message || e);
  process.exit(1);
});
