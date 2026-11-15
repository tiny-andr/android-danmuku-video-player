const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async function () {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../tmp/network-fixture/source.json'), 'utf8'));
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const target = targets.find(entry => entry.type === 'page');
  assert(target, 'WebView target missing');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onclose = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP socket closed')); }
    pending.clear();
  };
  function call(method, params) {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP socket is not open'));
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 100000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  function invoke(command, args = {}) { return evaluate(`AndroidFiles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`); }
  async function mustReject(command, args) {
    const result = await evaluate(`AndroidFiles.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(()=>false, error=>String(error.message||error))`);
    assert.equal(typeof result, 'string'); return result;
  }
  const report = {};
  let saved;
  let videoPath;
  try {
    const fingerprint = await invoke('network_test', { source });
    assert.equal(fingerprint.fingerprintRequired, true);
    assert.match(fingerprint.hostKey, /^SHA256:[A-Za-z0-9+/]{43}$/);
    const wrongKey = fingerprint.hostKey.slice(0, -1) + (fingerprint.hostKey.endsWith('A') ? 'B' : 'A');
    report.rejectedWrongFingerprint = await mustReject('network_test', { source: { ...source, hostKey: wrongKey } });
    source.hostKey = fingerprint.hostKey;
    const tested = await invoke('network_test', { source });
    assert.equal(tested.fingerprintRequired, false);
    assert(tested.entries.some(entry => entry.name === '第 01 集 + %.mp4'));
    assert.equal(Object.hasOwn(tested.source, 'password'), false);
    saved = await invoke('network_save', { source });
    assert.equal(saved.hasPassword, true);
    assert.equal(Object.hasOwn(saved, 'password'), false);
    const root = `/@network/${saved.id}`;
    videoPath = `${root}/第 01 集 + %.mp4`;
    report.file = await invoke('fs_stat', { path: videoPath });
    assert.equal(report.file.kind, 'file');
    const folder = await invoke('scan_folder', { dir: root });
    assert.equal(folder.episodes.find(entry => entry.name === '第 01 集 + %.mp4').danmaku, '第 01 集 + %.xml');
    const paired = await invoke('pair_danmaku', { videoPath });
    assert.match(paired.text, /Network fixture/);
    report.subtitle = await invoke('scan_subtitles', { videoPath });
    assert.equal(report.subtitle[0].name, '第 01 集 + %.zh.srt');
    assert.match(await invoke('read_text', { path: report.subtitle[0].path }), /Network subtitle fixture/);
    assert.equal(Buffer.from(await invoke('read_bytes', { path: report.subtitle[0].path }), 'base64').toString().includes('Network subtitle fixture'), true);
    await mustReject('read_bytes', { path: `${root}/large.mp4` });
    await mustReject('list_dir', { dir: `${root}/../escape` });
    const total = 5 * 1024 ** 3 + 123;
    for (const [header, start, length] of [['bytes=100-104', 100, 5], [`bytes=${total - 7}-`, total - 7, 7], ['bytes=-13', total - 13, 13]]) {
      const result = await evaluate(`(async()=>{const response=await fetch(AndroidFiles.mediaUrl(${JSON.stringify(`${root}/large.mp4`)}),{headers:{Range:${JSON.stringify(header)}}});return {status:response.status,range:response.headers.get('Content-Range'),bytes:Array.from(new Uint8Array(await response.arrayBuffer()))}})()`);
      assert.equal(result.status, 206);
      assert.equal(result.range, `bytes ${start}-${start + length - 1}/${total}`);
      assert.deepEqual(result.bytes, Array.from({ length }, (_, index) => (start + index) % 251));
    }
    report.ranges = 'closed/open/suffix beyond 5 GiB: exact bytes';
    const head = await evaluate(`fetch(AndroidFiles.mediaUrl(${JSON.stringify(`${root}/large.mp4`)}),{method:'HEAD'}).then(response=>({status:response.status,size:response.headers.get('Content-Length')}))`);
    assert.equal(head.status, 200); assert.equal(head.size, String(total));
    assert.equal(await evaluate(`fetch(AndroidFiles.mediaUrl(${JSON.stringify(`${root}/large.mp4`)}),{headers:{Range:'bytes=${total}-'}}).then(response=>response.status)`), 416);
    assert.equal(await evaluate(`fetch(AndroidFiles.mediaUrl(${JSON.stringify(`${root}/empty.mp4`)}),{headers:{Range:'bytes=0-'}}).then(response=>response.status)`), 416);
    const sources = await invoke('network_sources');
    assert(!JSON.stringify(sources).includes(source.password));
    assert.equal(await evaluate(`JSON.stringify(localStorage).includes(${JSON.stringify(source.password)})`), false);
    report.credentials = 'not present in public source or localStorage';
    await evaluate(`window.__BplayerDesktop.loadVideo(${JSON.stringify(videoPath)},null)`);
    await evaluate(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{const art=window.Bplayer&&window.Bplayer.art;if(art&&art.video.readyState>=2&&art.video.videoWidth){clearInterval(timer);resolve(true)}else if(Date.now()-started>20000){clearInterval(timer);reject(new Error('Network video did not become playable'))}},100)})`);
    await evaluate('window.Bplayer.art.currentTime=2;window.Bplayer.art.play();true');
    report.playback = await evaluate(`new Promise(resolve=>setTimeout(()=>{const video=window.Bplayer.art.video;resolve({width:video.videoWidth,height:video.videoHeight,duration:video.duration,time:video.currentTime,paused:video.paused,path:window.__BplayerDesktop.currentPath,danmaku:document.getElementById('chipDanmaku').textContent})},1000))`);
    assert(report.playback.width > 0); assert(report.playback.time >= 2); assert.equal(report.playback.paused, false);
    assert.equal(report.playback.path, videoPath);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'storage-playback.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ passed: true, ...report }, null, 2));
  } catch (error) {
    console.error('SMOKE_FAILURE', error.stack);
    throw error;
  } finally {
    if (saved) {
      await evaluate('window.Bplayer?.art?.pause();if(document.body.classList.contains("m-playing"))window.__aAndroidBack();true').catch(() => {});
      await invoke('network_remove', { id: saved.id }).catch(() => {});
      await evaluate(`(()=>{const key='bplayer.android.recent.v1';const values=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(values.filter(entry=>!String(entry.p).startsWith('/@network/${saved.id}'))));if(String(localStorage.getItem('bplayer.android.lastDir')).startsWith('/@network/${saved.id}'))localStorage.removeItem('bplayer.android.lastDir');return true})()`).catch(() => {});
    }
    socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
