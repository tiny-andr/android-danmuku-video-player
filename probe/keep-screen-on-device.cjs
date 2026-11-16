const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function adb(...args) {
  const device = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
  const result = spawnSync(process.env.ADB || 'adb', [...device, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ADB failed');
  return result.stdout;
}

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(entry => entry.type === 'page').webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(action, label) {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      try { if (await action()) return; } catch (error) {
        if (!/context|navigation/i.test(error.message)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Condition timeout: ' + label);
  }
  async function reload() {
    await call('Page.reload', {});
    await until(() => evaluate('!!(window.__BplayerDesktop && document.getElementById("optKeepScreenOn"))'), 'settings initialization');
  }
  function keepScreenOn() {
    const dump = adb('shell', 'dumpsys', 'window', 'windows');
    const entry = dump.split(/(?=  Window #\d+ )/).find(block => block.includes('package=com.danmuku.bplayer.android'));
    assert(entry, 'Player window must exist');
    const flags = entry.match(/\n\s+fl=([^\r\n]*)/);
    assert(flags, 'Player window flags must exist');
    return flags[1].includes('KEEP_SCREEN_ON');
  }
  async function setPreference(enabled) {
    await evaluate(`(()=>{document.getElementById('btnSettings').click();const option=document.getElementById('optKeepScreenOn');if(option.checked!==${enabled})option.click();return true})()`);
  }
  const keys = ['bplayer_settings', 'bplayer.android.resume.v1', 'bplayer.android.recent.v1'];
  const saved = await evaluate(`Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,localStorage.getItem(key)]))`);
  const report = {};
  try {
    await evaluate('localStorage.setItem("bplayer_settings",JSON.stringify({ver:2,autoAudio:false,autoSubtitle:true}));true');
    await reload();
    await setPreference(true);
    assert.equal(await evaluate('document.getElementById("optKeepScreenOn").checked'), true);
    assert.equal(await evaluate('document.getElementById("optAutoAudio").checked'), false);
    assert.equal(await evaluate('document.getElementById("optAutoSubtitle").checked'), true);
    report.migration = 'enabled by default; existing unrelated preferences preserved';
    await setPreference(false);
    await reload();
    await evaluate('document.getElementById("btnSettings").click();true');
    assert.equal(await evaluate('document.getElementById("optKeepScreenOn").checked'), false);
    report.persistence = 'disabled preference survives reload';
    await evaluate('document.getElementById("settingsClose").click();AndroidResumeStore.create(localStorage).remove("/storage/emulated/0/Download/test-hevc10-aac.mp4");__BplayerDesktop.loadVideo("/storage/emulated/0/Download/test-hevc10-aac.mp4",null);true');
    await until(() => evaluate('!AndroidPlayback.loading&&Bplayer.art&&Bplayer.art.video.readyState>=2'), 'test video');
    await evaluate('Bplayer.art.video.loop=true;Bplayer.art.play();true');
    await until(() => !keepScreenOn(), 'disabled during real video playback');
    report.disabledPlaying = true;
    await evaluate('Bplayer.art.pause();true');
    await evaluate('Bplayer.art.play();true');
    await until(() => !keepScreenOn(), 'disabled after pause and resume');
    report.disabledAfterResume = true;
    await setPreference(true);
    await until(() => keepScreenOn(), 'enabled during playback');
    report.enabledPlaying = true;
    await evaluate('Bplayer.art.pause();true');
    await until(() => keepScreenOn(), 'enabled while paused on playback page');
    report.enabledPaused = true;
    await evaluate('document.getElementById("settingsClose").click();true');
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await until(() => !keepScreenOn(), 'background release');
    report.backgroundReleased = true;
    adb('shell', 'am', 'start', '-n', 'com.danmuku.bplayer.android/.MainActivity');
    await until(() => evaluate('document.visibilityState === "visible" && !!window.__BplayerDesktop'), 'foreground app');
    await evaluate('document.getElementById("mHomeSettings").click();true');
    await evaluate('(()=>{const option=document.getElementById("optKeepScreenOn");if(!option.checked)option.click();document.getElementById("settingsClose").click();__BplayerDesktop.loadVideo("/storage/emulated/0/Download/test-hevc10-aac.mp4",null);return true})()');
    await until(() => evaluate('!AndroidPlayback.loading&&Bplayer.art&&Bplayer.art.video.readyState>=2'), 'foreground playback page');
    await evaluate('Bplayer.art.video.loop=true;Bplayer.art.play();true');
    await until(() => keepScreenOn(), 'foreground playback keep awake');
    await evaluate('__aAndroidBack();true');
    await until(() => !keepScreenOn(), 'playback exit release');
    report.exitReleased = true;
  } finally {
    try {
      await evaluate(`if(AndroidPlayback.active)__aAndroidBack();const saved=${JSON.stringify(saved)};for(const key of ${JSON.stringify(keys)}){if(saved[key]===null)localStorage.removeItem(key);else localStorage.setItem(key,saved[key])}const settings=JSON.parse(localStorage.getItem('bplayer_settings')||'{"ver":2,"autoAudio":true,"autoSubtitle":false}');settings.keepScreenOn=true;localStorage.setItem('bplayer_settings',JSON.stringify(settings));true`);
      await reload();
      await evaluate('document.getElementById("mHomeSettings").click();true');
      if (process.env.SCREENSHOT_PATH) {
        const device = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
        const capture = spawnSync(process.env.ADB || 'adb', [...device, 'exec-out', 'screencap', '-p']);
        assert.equal(capture.status, 0);
        const start = capture.stdout.indexOf(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        assert(start >= 0);
        const destination = path.resolve(process.env.SCREENSHOT_PATH);
        fs.writeFileSync(destination, capture.stdout.subarray(start));
      }
    } finally { socket.close(); }
  }
  console.log(JSON.stringify({ passed: true, report }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
