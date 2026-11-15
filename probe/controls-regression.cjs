const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function adb(...args) {
  const device = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
  const result = spawnSync(process.env.ADB || 'adb', [...device, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ADB failed');
  return result.stdout.trim();
}
function setting(action, key, value) {
  return adb('shell', 'settings', action, 'system', key, ...(value == null ? [] : [String(value)]));
}
(async () => {
  const originalAuto = setting('get', 'accelerometer_rotation');
  const originalRotation = setting('get', 'user_rotation');
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
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
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  function until(expression) {
    return evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-start>20000){clearInterval(timer);reject(new Error('Condition timeout'))}},100)})`);
  }
  async function click(selector) {
    const point = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});const box=element.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()`);
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function screenshot(name) {
    await evaluate('new Promise(resolve=>setTimeout(resolve,700))');
    adb('shell', 'screencap', '/sdcard/Download/bplayer-controls-review.png');
    adb('pull', '/sdcard/Download/bplayer-controls-review.png', path.join(__dirname, name));
  }
  async function layout() {
    return evaluate(`(()=>{const rect=element=>{const box=element.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom}};const hit=element=>{const box=element.getBoundingClientRect();return element.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))};const toggle=document.querySelector('.mDanControls .apd-toggle'),config=document.querySelector('.mDanControls .apd-config');return {viewport:[innerWidth,innerHeight],rotate:document.getElementById('mRotateBtn').textContent,removedDuplicate:!document.getElementById('mDanBtn'),toggle:rect(toggle),config:rect(config),toggleHit:hit(toggle),configHit:hit(config),speed:Bplayer.art.plugins.artplayerPluginDanmuku.option.speed,font:Bplayer.art.plugins.artplayerPluginDanmuku.option.fontSize,progressHeight:document.querySelector('.art-progress').getBoundingClientRect().height,iconFill:getComputedStyle(toggle.querySelector('.apd-icon')).fill,topBackground:getComputedStyle(document.getElementById('mTop')).backgroundColor,bottomBackground:getComputedStyle(document.querySelector('.art-bottom')).backgroundImage}})()`);
  }
  async function checkDanmaku() {
    const hidden = await evaluate('Bplayer.art.plugins.artplayerPluginDanmuku.isHide');
    await click('.mDanControls .apd-toggle');
    await until(`Bplayer.art.plugins.artplayerPluginDanmuku.isHide===${!hidden}`);
    await click('.mDanControls .apd-toggle');
    await until(`Bplayer.art.plugins.artplayerPluginDanmuku.isHide===${hidden}`);
    await click('.mDanControls .apd-config');
    await until('!!document.querySelector(".mDanControls.is-config-open")');
    const panel = await evaluate(`(()=>{const element=document.querySelector('.apd-config-panel');const box=element.getBoundingClientRect();return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height,opacity:getComputedStyle(element).opacity,viewport:[innerWidth,innerHeight]}})()`);
    assert(panel.x >= -1); assert(panel.y >= 0); assert(panel.right <= panel.viewport[0] + 1); assert(panel.bottom <= panel.viewport[1] + 1); assert(panel.height > 100);
    return panel;
  }
  const report = {};
  try {
    await evaluate('if(AndroidPlayback.active)__aAndroidBack();true');
    setting('put', 'user_rotation', 0); setting('put', 'accelerometer_rotation', 0);
    await until('innerWidth<innerHeight');
    await evaluate('__BplayerDesktop.loadVideo("/sdcard/Download/test-hevc10-aac.mp4",null);true');
    await until('!AndroidPlayback.loading&&Bplayer.art.video.readyState>=2');
    await evaluate('Bplayer.art.pause();Bplayer.art.controls.show=true;true');
    await until('document.getElementById("mTop").classList.contains("show")');
    report.portrait = await layout();
    assert(report.portrait.viewport[0] < report.portrait.viewport[1]);
    assert.equal(report.portrait.removedDuplicate, true); assert.equal(report.portrait.toggleHit, true); assert.equal(report.portrait.configHit, true);
    assert.equal(report.portrait.rotate, '横屏'); assert.equal(report.portrait.font, 18);
    assert(report.portrait.progressHeight < 24); assert.equal(report.portrait.iconFill, 'rgb(242, 244, 255)');
    await screenshot('controls-portrait.png');
    report.portraitPanel = await checkDanmaku(); await screenshot('controls-portrait-settings.png');
    await evaluate('__aAndroidBack();true');
    await click('#mRotateBtn');
    await until('innerWidth>innerHeight&&document.getElementById("mRotateBtn").textContent==="竖屏"');
    assert.equal(setting('get', 'accelerometer_rotation'), '0');
    report.landscape = await layout();
    assert.equal(report.landscape.toggleHit, true); assert.equal(report.landscape.configHit, true);
    await screenshot('controls-landscape.png');
    report.landscapePanel = await checkDanmaku(); await screenshot('controls-landscape-settings.png');
    await evaluate('__aAndroidBack();Bplayer.art.controls.show=false;true');
    await until('!document.getElementById("mTop").classList.contains("show")&&Number(getComputedStyle(document.querySelector(".art-bottom")).opacity)<0.05');
    report.hidden = await evaluate('({top:getComputedStyle(document.getElementById("mTop")).pointerEvents,bottom:Number(getComputedStyle(document.querySelector(".art-bottom")).opacity)})');
    await evaluate('Bplayer.art.controls.show=true;true');
    await click('#mRotateBtn');
    await until('innerWidth<innerHeight');
    await click('#mRotateBtn');
    await until('innerWidth>innerHeight');
    await evaluate('__aAndroidBack();true');
    await until('innerWidth<innerHeight&&!document.getElementById("mHome").classList.contains("hide")');
    report.exitRestoresSystemPortrait = true;
    console.log(JSON.stringify({ passed: true, ...report }, null, 2));
  } finally {
    await evaluate('if(AndroidPlayback.active)__aAndroidBack();true').catch(() => {});
    setting('put', 'user_rotation', originalRotation); setting('put', 'accelerometer_rotation', originalAuto);
    adb('shell', 'rm', '-f', '/sdcard/Download/bplayer-controls-review.png');
    socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
