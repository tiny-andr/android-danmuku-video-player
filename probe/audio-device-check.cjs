const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const target = await (async () => {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      try { const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json(); const page = pages.find(entry => entry.type === 'page'); if (page) return page; } catch (error) {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('WebView CDP target did not become ready');
  })();
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 60000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  async function until(condition, timeout = 45000) { return evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve(true)}else if(Date.now()-start>${timeout}){clearInterval(timer);reject(new Error(JSON.stringify({condition:${JSON.stringify(condition)},state:__BplayerDesktop.audioState,output:__BplayerDesktop.audioOutput,status:document.getElementById('audioStatus').textContent}))) }},60)})`); }
  const saved = await evaluate('Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("bplayer")).map(key=>[key,localStorage.getItem(key)]))');
  const directory = '/storage/emulated/0/Download/bplayer-audio-device-fixtures';
  const report = [];
  try {
    await evaluate(`if(AndroidPlayback.active)throw new Error('Do not interrupt user playback');document.getElementById('optAutoAudio').checked=false;document.getElementById('optAutoAudio').dispatchEvent(new Event('change'));true`);
    async function open(name) {
      const media = directory + '/' + name;
      await evaluate(`(async()=>{if(AndroidPlayback.active)AndroidPlayback.exit();AndroidResumeStore.create(localStorage).remove(${JSON.stringify(media)});await __BplayerDesktop.loadVideo(${JSON.stringify(media)},null);return true})()`);
      await until('AndroidPlayback.active&&!AndroidPlayback.loading&&!AndroidPlayerTools.resumePending&&Bplayer.art.video.readyState>=2');
      await evaluate('Bplayer.art.pause();Bplayer.art.currentTime=2;true');
      await until('__BplayerDesktop.audioState&&["disabled","ready","error"].includes(__BplayerDesktop.audioState.phase)');
      const initial = await evaluate('({state:__BplayerDesktop.audioState,status:document.getElementById("audioStatus").textContent})');
      assert.notEqual(initial.state.phase, 'error', JSON.stringify(initial));
      return media;
    }
    for (const [name, codec] of [['dts-default.mkv', 'A_DTS'], ['truehd.mkv', 'A_TRUEHD'], ['ac3.mp4', 'A_AC3']]) {
      const media = await open(name);
      let state = await evaluate('__BplayerDesktop.audioState');
      assert.equal(state.tracks[0].codec, codec); const session = state.session;
      await evaluate('__BplayerDesktop.selectAudio(0)');
      await until('__BplayerDesktop.audioState&&["ready","error"].includes(__BplayerDesktop.audioState.phase)');
      const result = await evaluate('({state:__BplayerDesktop.audioState,output:__BplayerDesktop.audioOutput,status:document.getElementById("audioStatus").textContent,videoTime:Bplayer.art.currentTime,videoPaused:Bplayer.art.video.paused,path:__BplayerDesktop.currentPath})');
      assert.equal(result.state.phase, 'ready', JSON.stringify(result));
      assert.equal(result.path, media); assert.equal(result.state.session, session); assert(result.videoPaused && result.output.paused);
      assert(result.output.isolated); assert(Math.abs(result.output.time - (result.videoTime - result.output.track.offset)) < 0.15, JSON.stringify(result));
      const cache = media.replace(/\.[^.]+$/, ' (音轨1).mka');
      const stat = await evaluate(`AndroidFiles.invoke('fs_stat',{path:${JSON.stringify(cache)}})`);
      assert.equal(stat.kind, 'file'); assert(stat.size > 1000 && stat.size < 1024 * 1024);
      await evaluate('Bplayer.art.playbackRate=1.5;Bplayer.art.play();new Promise(resolve=>setTimeout(resolve,450))');
      const playing = await evaluate('({state:__BplayerDesktop.audioState,output:__BplayerDesktop.audioOutput,time:Bplayer.art.currentTime})');
      assert.equal(playing.output.rate, 1.5); assert.equal(playing.output.paused, false); assert(Math.abs(playing.output.time - (playing.time - playing.output.track.offset)) < 0.4);
      await evaluate('Bplayer.art.pause();Bplayer.art.currentTime=5;true');
      await until('__BplayerDesktop.audioOutput&&__BplayerDesktop.audioOutput.paused&&Math.abs(__BplayerDesktop.audioOutput.time-(Bplayer.art.currentTime-__BplayerDesktop.audioOutput.track.offset))<0.15');
      report.push({ name, sameVideoPath: result.path === media, cacheBytes: stat.size, pauseAndSeek: true, rate: playing.output.rate });
      await evaluate('Bplayer.art.playbackRate=1;true');
      await open(name);
      await until('__BplayerDesktop.audioState.phase==="ready"');
      const reused = await evaluate('({state:__BplayerDesktop.audioState,status:document.getElementById("audioStatus").textContent})');
      assert.notEqual(reused.state.session, session); assert.equal(reused.state.activeIndex, 0);
      report.push({ name, cacheReuseWithAutomaticConversionDisabled: true });
    }
    await open('dts-default.mkv');
    await evaluate('__BplayerDesktop.selectAudio(1)');
    await until('["ready","error"].includes(__BplayerDesktop.audioState.phase)');
    const selected = await evaluate('({state:__BplayerDesktop.audioState,status:document.getElementById("audioStatus").textContent})');
    assert.equal(selected.state.phase, 'ready', JSON.stringify(selected)); assert.equal(selected.state.activeIndex, 1);
    report.push({ manualAlternateTrack: true });
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'audio-conversion-device.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ passed: true, report }, null, 2));
  } finally {
    try { await evaluate(`if(AndroidPlayback.active)AndroidPlayback.exit();AndroidNavigation.clear();Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>localStorage.removeItem(key));Object.entries(${JSON.stringify(saved)}).forEach(([key,value])=>localStorage.setItem(key,value));true`); await call('Page.reload', {}); }
    finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
