const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const target = (await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json()).find(entry => entry.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  const saved = await evaluate('Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("bplayer")).map(key=>[key,localStorage.getItem(key)]))');
  const report = [];
  try {
    await evaluate(`(async()=>{if(AndroidPlayback.active)throw new Error('Do not interrupt user playback');const path='/storage/emulated/0/Download/test-hevc10-aac.mp4';AndroidResumeStore.create(localStorage).remove(path);await __BplayerDesktop.loadVideo(path,null);await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(!AndroidPlayback.loading&&!AndroidPlayerTools.resumePending){clearInterval(timer);resolve()}else if(Date.now()-start>15000){clearInterval(timer);reject(new Error('Playback timeout'))}},80)});Bplayer.art.pause();await __BplayerDesktop.loadSubtitle('/storage/emulated/0/Download/bplayer-sidecar-fixture-a6d93182/dialog.zh-Hans.srt');Bplayer.art.currentTime=2;document.getElementById('mInfoBtn').click();document.getElementById('mActSub').click();return true})()`);
    for (const [width, height] of [[415, 931], [845, 919], [320, 720], [931, 415], [415, 931]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.55, mobile: true });
      await evaluate('new Promise(resolve=>setTimeout(resolve,150))');
      const panel = await evaluate(`(()=>{const panel=document.getElementById('subtitlePanel');return{rect:panel.getBoundingClientRect().toJSON(),overflow:panel.scrollWidth>panel.clientWidth+1,count:__BplayerDesktop.sidecars.subtitleCount}})()`);
      assert(panel.rect.left >= 0 && panel.rect.right <= width + 1); assert(panel.rect.top >= 0 && panel.rect.bottom <= height + 1); assert.equal(panel.overflow, false); assert.equal(panel.count, 2);
      for (const id of ['btnPickSubtitle', 'subtitleDelay', 'subtitleDelayReset', 'subtitleFontSize', 'subtitleColor', 'subtitleOutline', 'subtitlePosition', 'subtitleLanguage', 'subtitleSave']) {
        const result = await evaluate(`(()=>{const element=document.getElementById(${JSON.stringify(id)});element.scrollIntoView({block:'nearest'});const rect=element.getBoundingClientRect();return{rect:rect.toJSON(),hit:element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))}})()`);
        assert(result.hit, id + ' must remain reachable at ' + width + 'x' + height);
      }
      report.push({ width, height, reachableControls: 9 });
    }
    await call('Emulation.clearDeviceMetricsOverride', {});
    await evaluate('AndroidUI.setPlaybackOrientation("portrait");new Promise(resolve=>setTimeout(resolve,250))');
    await evaluate('document.getElementById("toastClose").click();document.getElementById("subtitlePanel").scrollTop=0;true');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'sidecar-subtitle-phone.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ passed: true, layouts: report }, null, 2));
  } finally {
    try { await call('Emulation.clearDeviceMetricsOverride', {}); await evaluate(`if(AndroidPlayback.active)AndroidPlayback.exit();AndroidFiles.close();AndroidNavigation.clear();AndroidUI.setPlaybackActive(false);Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>localStorage.removeItem(key));Object.entries(${JSON.stringify(saved)}).forEach(([key,value])=>localStorage.setItem(key,value));true`); await call('Page.reload', {}); }
    finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
