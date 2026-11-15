const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const target = targets.find(entry => entry.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const requests = new Map(); let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const entry = requests.get(message.id);
    if (!entry) return; requests.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timeout`)); }, 45000);
      requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  function until(expression, timeout = 25000) {
    return evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-start>${timeout}){clearInterval(timer);reject(new Error('Condition timeout: '+${JSON.stringify(expression)}))}},100)})`);
  }
  async function screenshot(name) {
    const result = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(result.data, 'base64'));
  }
  async function swipe(fraction) {
    const bounds = await evaluate('({width:innerWidth,height:innerHeight})');
    const x = Math.round(bounds.width * fraction); const start = Math.round(bounds.height * 0.7); const end = Math.round(bounds.height * 0.35);
    await evaluate('window.Bplayer.art.controls.show=false;true');
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
    for (let index = 1; index <= 10; index++) await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * index / 10 }] });
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  let original;
  const report = {};
  try {
    original = await evaluate('JSON.parse(AndroidUI.getPlaybackControls())');
    await evaluate('if(AndroidPlayback.active)window.__aAndroidBack();true');
    const immediate = await evaluate(`(()=>{window.__BplayerDesktop.loadVideo('/sdcard/Download/test-hevc10-aac.mp4',null);return {homeHidden:document.getElementById('mHome').classList.contains('hide'),loading:AndroidPlayback.loading}})()`);
    assert.equal(immediate.homeHidden, true); assert.equal(immediate.loading, true);
    await until('!AndroidPlayback.loading&&window.Bplayer.art.video.readyState>=2');
    report.local = await evaluate(`({width:innerWidth,height:innerHeight,video:[Bplayer.art.video.videoWidth,Bplayer.art.video.videoHeight],font:Bplayer.art.plugins.artplayerPluginDanmuku.option.fontSize,toast:document.getElementById('toast').classList.contains('show')})`);
    await swipe(0.25);
    report.brightness = await evaluate('({controls:JSON.parse(AndroidUI.getPlaybackControls()),hud:document.getElementById("mGestureHud")?.textContent})');
    assert(report.brightness.controls.brightness > original.brightness);
    await screenshot('playback-brightness.png');
    await swipe(0.75);
    report.volume = await evaluate('({controls:JSON.parse(AndroidUI.getPlaybackControls()),hud:document.getElementById("mGestureHud")?.textContent})');
    assert(report.volume.controls.volume > original.volume);
    await evaluate(`AndroidUI.setPlaybackVolume(${original.volume});true`);
    await evaluate('window.__aAndroidBack();true');
    report.exit = await evaluate('({home:!document.getElementById("mHome").classList.contains("hide"),src:Bplayer.art.video.getAttribute("src"),controls:JSON.parse(AndroidUI.getPlaybackControls())})');
    assert.equal(report.exit.home, true); assert.equal(report.exit.src, null);
    const recent = await evaluate(`(()=>{for(const value of Object.values(localStorage)){try{const entries=JSON.parse(value);if(Array.isArray(entries)){const entry=entries.find(item=>String(item.p||'').startsWith('/@network/')&&String(item.p).endsWith('.mkv'));if(entry)return entry.p}}catch(error){}}return null})()`);
    if (recent) {
      report.network = [];
      for (let index = 0; index < 3; index++) {
        await evaluate(`window.__BplayerDesktop.loadVideo(${JSON.stringify(recent)},null);true`);
        await until('!AndroidPlayback.loading&&Bplayer.art.video.readyState>=2');
        await evaluate('Bplayer.art.currentTime=10;true');
        await until('!Bplayer.art.video.seeking');
        await evaluate('window.__aAndroidBack();true');
        const root = recent.split('/').slice(0, 3).join('/');
        const result = await evaluate(`(async()=>{const start=performance.now();const listing=await AndroidFiles.invoke('list_dir',{dir:${JSON.stringify(root)}});return {ms:Math.round(performance.now()-start),count:listing.entries.length}})()`);
        assert(result.ms < 10000); assert(result.count > 0); report.network.push(result);
      }
    }
    console.log(JSON.stringify({ passed: true, ...report }, null, 2));
  } finally {
    if (original) await evaluate(`AndroidUI.setPlaybackVolume(${original.volume});if(AndroidPlayback.active)window.__aAndroidBack();true`).catch(() => {});
    socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
