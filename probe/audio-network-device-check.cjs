const assert = require('node:assert/strict');
const media = process.env.AUDIO_NETWORK_VIDEO;
if (!media || !media.startsWith('/@network/')) throw new Error('Set AUDIO_NETWORK_VIDEO to a selected existing short network video');
(async () => {
  const target = (await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json()).find(entry => entry.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 90000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  async function until(condition) { return evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve(true)}else if(Date.now()-start>80000){clearInterval(timer);reject(new Error(JSON.stringify({state:__BplayerDesktop.audioState,status:document.getElementById('audioStatus').textContent}))) }},80)})`); }
  const saved = await evaluate('Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("bplayer")).map(key=>[key,localStorage.getItem(key)]))');
  try {
    const before = await evaluate(`AndroidFiles.invoke('fs_stat',{path:${JSON.stringify(media)}})`);
    assert.equal(before.kind, 'file'); assert(before.size < 100 * 1024 * 1024, 'Use a small known short clip, not a full movie');
    await evaluate(`(async()=>{if(AndroidPlayback.active)throw new Error('Do not interrupt user playback');document.getElementById('optAutoAudio').checked=false;document.getElementById('optAutoAudio').dispatchEvent(new Event('change'));AndroidResumeStore.create(localStorage).remove(${JSON.stringify(media)});await __BplayerDesktop.loadVideo(${JSON.stringify(media)},null);return true})()`);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading&&Bplayer.art.video.readyState>=2&&__BplayerDesktop.audioState&&["idle","disabled","ready","error"].includes(__BplayerDesktop.audioState.phase)');
    await evaluate('Bplayer.art.pause();Bplayer.art.currentTime=2;true');
    await evaluate('__BplayerDesktop.selectAudio(0)');
    await until('["ready","error"].includes(__BplayerDesktop.audioState.phase)');
    const result = await evaluate('({state:__BplayerDesktop.audioState,output:__BplayerDesktop.audioOutput,status:document.getElementById("audioStatus").textContent,videoTime:Bplayer.art.currentTime,paused:Bplayer.art.video.paused})');
    assert.equal(result.state.phase, 'ready', JSON.stringify(result)); assert(result.paused && result.output.paused && result.output.isolated);
    assert(Math.abs(result.output.time - (result.videoTime - result.output.track.offset)) < 0.15);
    const cache = media.replace(/\.[^.]+$/, ' (音轨1).mka');
    const after = await evaluate(`AndroidFiles.invoke('fs_stat',{path:${JSON.stringify(media)}})`);
    assert.deepEqual(after, before, 'Network source size/mtime must not change');
    const cacheStat = await evaluate(`AndroidFiles.invoke('fs_stat',{path:${JSON.stringify(cache)}})`);
    assert.equal(cacheStat.kind, 'file'); assert(cacheStat.size > 1000);
    const prepared = await evaluate(`AndroidAudioTasks.request('audio_prepare',{videoPath:${JSON.stringify(media)},audioIndex:0,session:__BplayerDesktop.audioState.session})`);
    assert.equal(prepared.cached, true); assert.equal(prepared.legacy, false); assert.equal(prepared.target, cache);
    console.log(JSON.stringify({ passed: true, sourceBytes: before.size, sourceMetadataUnchanged: true, cacheBytes: cacheStat.size, sameDirectory: cache.slice(0, cache.lastIndexOf('/')) === media.slice(0, media.lastIndexOf('/')), nativeCacheReuse: prepared.cached, legacy: prepared.legacy, synchronizedWhilePaused: true }, null, 2));
  } finally {
    try { await evaluate(`if(AndroidPlayback.active)AndroidPlayback.exit();AndroidNavigation.clear();Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>localStorage.removeItem(key));Object.entries(${JSON.stringify(saved)}).forEach(([key,value])=>localStorage.setItem(key,value));true`); await call('Page.reload', {}); }
    finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
