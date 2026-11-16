const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(entry => entry.type === 'page').webSocketDebuggerUrl);
  const pending = new Map(); let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const request = pending.get(message.id);
    if (!request) return; pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function touch(type, point) {
    await call('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [] });
  }
  async function longPress() {
    const point = await evaluate(`(()=>{const row=document.querySelector('.mRecentRow');row.scrollIntoView({block:'nearest'});const rect=row.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await touch('touchStart', point);
    await evaluate('new Promise(resolve=>setTimeout(resolve,750))');
    await touch('touchEnd');
    assert.equal(await evaluate('AndroidNavigation.top'), 'recentActions');
    assert.equal(await evaluate('AndroidPlayback.active'), false);
  }
  const saved = await evaluate('Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("bplayer")).map(key=>[key,localStorage.getItem(key)]))');
  try {
    assert.equal(await evaluate('AndroidPlayback.active'), false);
    await evaluate(`(()=>{const records=Array.from({length:8},(_,index)=>({p:index?'/storage/emulated/0/Movies/Recent '+index+'.mp4':'/storage/emulated/0/Download/test-hevc10-aac.mp4',n:'Test record '+index+'.mp4',t:Date.now()-index}));localStorage.setItem('bplayer.android.recent.v1',JSON.stringify(records));AndroidResumeStore.create(localStorage).save(records[0].p,8,20);AndroidPlayback.exit();AndroidUI.setKeepScreenOn(true);AndroidUI.setPlaybackActive(true);return true})()`);
    for (const [width, height, grid] of [[415, 931, false], [845, 919, true]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.55, mobile: true });
      await evaluate(`if(document.getElementById('mRecentList').classList.contains('is-grid')!==${grid})document.getElementById('mRecentView').click();new Promise(resolve=>setTimeout(resolve,150))`);
      await longPress();
      const card = await evaluate(`(()=>{const card=document.getElementById('mRecentActionCard');const box=card.getBoundingClientRect();const buttons=Array.from(card.querySelectorAll('button')).map(button=>{const rect=button.getBoundingClientRect();return button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))});return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,buttons,note:document.getElementById('mRecentActionNote').textContent,count:document.querySelectorAll('.mRecentRow').length}})()`);
      assert(card.left >= 0 && card.right <= width + 1 && card.top >= 0 && card.bottom <= height + 1);
      assert(card.buttons.every(Boolean)); assert.equal(card.count, 8); assert.match(card.note, /不会删除视频/);
      await evaluate('__aAndroidBack();true');
      assert.equal(await evaluate('AndroidNavigation.top'), null);
      assert.equal(await evaluate('document.querySelectorAll(".mRecentRow").length'), 8);
      if (grid) {
        await longPress();
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(__dirname, 'recent-delete-device.png'), Buffer.from(shot.data, 'base64'));
        await evaluate('document.getElementById("mRecentDelete").click();true');
        assert.equal(await evaluate('document.querySelectorAll(".mRecentRow").length'), 7);
        assert.equal(await evaluate('AndroidPlayback.active'), false);
        assert.equal(await evaluate('!!AndroidResumeStore.create(localStorage).get("/storage/emulated/0/Download/test-hevc10-aac.mp4")'), true);
        assert.equal(await evaluate('AndroidFiles.invoke("fs_stat",{path:"/storage/emulated/0/Download/test-hevc10-aac.mp4"}).then(result=>result.kind)'), 'file');
      }
    }
    const point = await evaluate(`(()=>{const rect=document.querySelector('.mRecentRow').getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await touch('touchStart', point); await touch('touchMove', { x: point.x, y: point.y + 30 });
    await evaluate('new Promise(resolve=>setTimeout(resolve,700))'); await touch('touchEnd');
    assert.equal(await evaluate('AndroidNavigation.top'), null);
    assert.equal(await evaluate('AndroidPlayback.active'), false);
    console.log('Recent deletion device: real touch long-press, folded/wide layouts, Back, confirmation, move cancellation, resume and source preservation passed');
  } finally {
    try {
      await call('Emulation.clearDeviceMetricsOverride', {});
      await evaluate(`AndroidNavigation.clear();AndroidUI.setPlaybackActive(false);Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>localStorage.removeItem(key));Object.entries(${JSON.stringify(saved)}).forEach(([key,value])=>localStorage.setItem(key,value));true`);
      await call('Page.reload', {});
    } finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
