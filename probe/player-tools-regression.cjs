const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function adb(...args) {
  const device = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
  const result = spawnSync(process.env.ADB || 'adb', [...device, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ADB failed');
  return result.stdout.trim();
}
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(entry => entry.type === 'page').webSocketDebuggerUrl);
  const pending = new Map(); let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const entry = pending.get(message.id);
    if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 35000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  function until(expression) {
    return evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-start>15000){clearInterval(timer);reject(new Error('Condition timeout '+${JSON.stringify(expression)}))}},100)})`);
  }
  async function touch(x, y) {
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function click(selector) {
    await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
    await evaluate('new Promise(resolve=>setTimeout(resolve,500))');
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await touch(point.x, point.y);
  }
  async function settled() { await until('!Bplayer.art.video.seeking'); }
  async function open() {
    await evaluate('__BplayerDesktop.loadVideo("/sdcard/Download/test-hevc10-aac.mp4",null);true');
    await until('!AndroidPlayback.loading&&Bplayer.art.video.readyState>=2');
    await evaluate('new Promise(resolve=>setTimeout(resolve,650))');
  }
  const report = {};
  let saved;
  try {
    saved = await evaluate(`({resume:localStorage.getItem('bplayer.android.resume.v1'),recent:localStorage.getItem('bplayer.android.recent.v1')})`);
    await evaluate(`if(AndroidPlayback.active)__aAndroidBack();AndroidResumeStore.create(localStorage).remove('/sdcard/Download/test-hevc10-aac.mp4');true`);
    await open();
    await until('!Bplayer.art.video.paused&&Bplayer.art.currentTime>0.2');
    await evaluate('Bplayer.art.pause();Bplayer.art.currentTime=1;Bplayer.art.controls.show=true;true'); await settled();
    await click('#mFitButton'); await until('Bplayer.art.video.style.objectFit==="cover"');
    assert.equal(await evaluate('Bplayer.art.video.style.objectFit'), 'cover');
    await click('#mFitButton'); await until('Bplayer.art.video.style.objectFit==="contain"');
    assert.equal(await evaluate('Bplayer.art.video.style.objectFit'), 'contain'); report.fit = 'contain/cover preserve aspect ratio';
    const viewport = await evaluate('({w:innerWidth,h:innerHeight})');
    const right = { x: viewport.w * 0.78, y: viewport.h * 0.48 };
    await evaluate('Bplayer.art.controls.show=false;true');
    await touch(right.x, right.y); await touch(right.x, right.y); await settled();
    report.forward = await evaluate('Bplayer.art.currentTime'); assert(report.forward > 10.5 && report.forward < 12);
    const left = { x: viewport.w * 0.22, y: viewport.h * 0.48 };
    await touch(left.x, left.y); await touch(left.x, left.y); await settled();
    report.backward = await evaluate('Bplayer.art.currentTime'); assert(report.backward < 2);
    await evaluate('Bplayer.art.controls.show=true;true'); await click('#mTouchLockButton'); await until('AndroidPlayerTools.locked');
    assert.equal(await evaluate('AndroidPlayerTools.locked'), true);
    assert.equal(await evaluate('document.getElementById("mTouchLockButton").textContent'), '锁定');
    await until('getComputedStyle(document.getElementById("mTouchUnlock")).visibility==="hidden"&&getComputedStyle(document.getElementById("mTouchLockHint")).visibility==="hidden"');
    const hiddenLock = await evaluate('({locked:AndroidPlayerTools.locked,button:getComputedStyle(document.getElementById("mTouchUnlock")).visibility,hint:getComputedStyle(document.getElementById("mTouchLockHint")).visibility})');
    assert.equal(hiddenLock.button, 'hidden'); assert.equal(hiddenLock.hint, 'hidden'); assert.equal(hiddenLock.locked, true);
    const hiddenButton = await evaluate('(()=>{const r=document.getElementById("mTouchUnlock").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await touch(hiddenButton.x, hiddenButton.y); assert.equal(await evaluate('AndroidPlayerTools.locked'), true);
    await until('getComputedStyle(document.getElementById("mTouchUnlock")).visibility==="hidden"');
    adb('shell', 'screencap', '/sdcard/Download/bplayer-tools-review.png'); adb('pull', '/sdcard/Download/bplayer-tools-review.png', path.join(__dirname, 'tools-lock-hidden.png'));
    const initial = await evaluate('({time:Bplayer.art.currentTime,controls:JSON.parse(AndroidUI.getPlaybackControls())})');
    await touch(right.x, right.y); await touch(right.x, right.y);
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: left.x, y: viewport.h * 0.7 }] });
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: left.x, y: viewport.h * 0.35 }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const after = await evaluate('({time:Bplayer.art.currentTime,controls:JSON.parse(AndroidUI.getPlaybackControls()),locked:AndroidPlayerTools.locked})');
    assert.equal(after.time, initial.time); assert.equal(after.controls.volume, initial.controls.volume); assert.equal(after.controls.brightness, initial.controls.brightness); assert.equal(after.locked, true);
    adb('shell', 'screencap', '/sdcard/Download/bplayer-tools-review.png'); adb('pull', '/sdcard/Download/bplayer-tools-review.png', path.join(__dirname, 'tools-touch-lock.png'));
    await touch(left.x, viewport.h * 0.48); await until('document.getElementById("mTouchLock").classList.contains("show-controls")');
    await click('#mTouchUnlock'); await until('!AndroidPlayerTools.locked'); assert.equal(await evaluate('AndroidPlayerTools.locked'), false); report.touchLock = 'blocks seek/brightness/volume; hint auto-hides; explicit unlock works';
    await evaluate('Bplayer.art.currentTime=8;true'); await settled();
    await evaluate('AndroidPlayerTools.save();__aAndroidBack();true');
    await open(); await until('AndroidPlayerTools.resumePending');
    assert.equal(await evaluate('Bplayer.art.video.paused'), true);
    report.resumeText = await evaluate('document.getElementById("mResumePosition").textContent');
    adb('shell', 'screencap', '/sdcard/Download/bplayer-tools-review.png'); adb('pull', '/sdcard/Download/bplayer-tools-review.png', path.join(__dirname, 'tools-resume.png'));
    await click('#mResumeContinue');
    await until('!Bplayer.art.video.paused&&Bplayer.art.currentTime>=8');
    report.resumePosition = await evaluate('Bplayer.art.currentTime');
    await evaluate('Bplayer.art.pause();__aAndroidBack();true');
    await open(); await until('AndroidPlayerTools.resumePending'); await click('#mResumeRestart');
    await until('!Bplayer.art.video.paused&&Bplayer.art.currentTime<3'); report.restart = true;
    await evaluate('AndroidPlaybackAudioEvent("headphones-disconnected");true');
    assert.equal(await evaluate('Bplayer.art.video.paused'), true); report.noisyCallback = 'paused';
    await evaluate('Bplayer.art.play();true'); await until('!Bplayer.art.video.paused');
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await until('Bplayer.art.video.paused');
    adb('shell', 'am', 'start', '-n', 'com.danmuku.bplayer.android/.MainActivity');
    await until('!document.hidden'); assert.equal(await evaluate('Bplayer.art.video.paused'), true); report.background = 'pauses and does not auto-resume';
    console.log(JSON.stringify({ passed: true, ...report }, null, 2));
  } finally {
    await evaluate('if(AndroidPlayback.active)__aAndroidBack();true').catch(() => {});
    if (saved) await evaluate(`(()=>{for(const [key,value] of Object.entries(${JSON.stringify({ 'bplayer.android.resume.v1': saved.resume, 'bplayer.android.recent.v1': saved.recent })})){if(value==null)localStorage.removeItem(key);else localStorage.setItem(key,value)}return true})()`).catch(() => {});
    adb('shell', 'rm', '-f', '/sdcard/Download/bplayer-tools-review.png'); socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
