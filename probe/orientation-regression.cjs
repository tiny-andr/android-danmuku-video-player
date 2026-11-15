const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function setting(action, key, value) {
  const args = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
  args.push('shell', 'settings', action, 'system', key);
  if (value != null) args.push(String(value));
  const result = spawnSync(process.env.ADB || 'adb', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ADB settings failed');
  return result.stdout.trim();
}
(async () => {
  const originalAuto = setting('get', 'accelerometer_rotation');
  const originalRotation = setting('get', 'user_rotation');
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  const pending = new Map(); let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const entry = pending.get(message.id);
    if (!entry) return; clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 40000);
      pending.set(id, { resolve, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const message = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (message.error || message.result.exceptionDetails) throw new Error(JSON.stringify(message));
    return message.result.result.value;
  }
  async function until(expression) {
    await evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-start>20000){clearInterval(timer);reject(new Error('orientation timeout'))}},100)})`);
  }
  const report = [];
  try {
    await evaluate('if(AndroidPlayback.active)window.__aAndroidBack();true');
    setting('put', 'accelerometer_rotation', 1);
    for (const [name, file, landscape] of [
      ['wide', 'test-hevc10-aac.mp4', true],
      ['portrait', 'bplayer-test-portrait.mp4', false],
      ['square', 'bplayer-test-square.mp4', false]
    ]) {
      await evaluate(`__BplayerDesktop.loadVideo(${JSON.stringify('/sdcard/Download/' + file)},null);true`);
      await until(`!AndroidPlayback.loading&&Bplayer.art.video.readyState>=2&&${landscape ? 'innerWidth>innerHeight' : 'innerWidth<innerHeight'}`);
      const current = await evaluate('({viewport:[innerWidth,innerHeight],video:[Bplayer.art.video.videoWidth,Bplayer.art.video.videoHeight]})');
      assert.equal(current.video[0] > current.video[1], landscape);
      report.push({ name, ...current });
      const screenshot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, `playback-${name}.png`), Buffer.from(screenshot.result.data, 'base64'));
      await evaluate('__aAndroidBack();true');
    }
    setting('put', 'user_rotation', 0); setting('put', 'accelerometer_rotation', 0);
    await until('innerWidth<innerHeight');
    await evaluate('__BplayerDesktop.loadVideo("/sdcard/Download/test-hevc10-aac.mp4",null);true');
    await until('!AndroidPlayback.loading&&Bplayer.art.video.readyState>=2');
    const locked = await evaluate('({viewport:[innerWidth,innerHeight],video:[Bplayer.art.video.videoWidth,Bplayer.art.video.videoHeight]})');
    assert(locked.viewport[0] < locked.viewport[1]);
    report.push({ name: 'system-rotation-locked', ...locked });
    console.log(JSON.stringify({ passed: true, report }, null, 2));
  } finally {
    await evaluate('if(AndroidPlayback.active)window.__aAndroidBack();true').catch(() => {});
    setting('put', 'user_rotation', originalRotation); setting('put', 'accelerometer_rotation', originalAuto);
    socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
