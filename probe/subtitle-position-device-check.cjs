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
    await evaluate(`(async()=>{if(AndroidPlayback.active)throw new Error('Do not interrupt user playback');const media='/storage/emulated/0/Download/test-hevc10-aac.mp4';AndroidResumeStore.create(localStorage).remove(media);await __BplayerDesktop.loadVideo(media,null);await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(!AndroidPlayback.loading&&!AndroidPlayerTools.resumePending){clearInterval(timer);resolve()}else if(Date.now()-start>15000){clearInterval(timer);reject(new Error('Playback timeout'))}},80)});Bplayer.art.pause();await __BplayerDesktop.loadSubtitle('/storage/emulated/0/Download/bplayer-sidecar-fixture-a6d93182/dialog.zh-Hans.srt');Bplayer.art.currentTime=2;for(const [id,value] of [['subtitleFontSize','18'],['subtitleOutline','0']]){const control=document.getElementById(id);control.value=value;control.dispatchEvent(new Event('change'))}AndroidNavigation.clear();Bplayer.art.controls.show=false;return true})()`);
    for (const [width, height] of [[845, 919], [415, 931], [931, 415], [720, 1200], [1200, 720], [845, 919]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.55, mobile: true });
      for (const fit of ['contain', 'cover']) {
        for (const position of ['inside', 'below']) {
          await evaluate(`Bplayer.art.video.style.objectFit=${JSON.stringify(fit)};document.getElementById('subtitlePosition').value=${JSON.stringify(position)};document.getElementById('subtitlePosition').dispatchEvent(new Event('change'));new Promise(resolve=>setTimeout(resolve,120))`);
          const result = await evaluate(`(()=>{const art=Bplayer.art,video=art.video,host=art.template.$player.getBoundingClientRect(),media=video.getBoundingClientRect(),sub=art.template.$subtitle.getBoundingClientRect();const scale=(getComputedStyle(video).objectFit==='cover'?Math.max:Math.min)(media.width/video.videoWidth,media.height/video.videoHeight);return{host:host.toJSON(),sub:sub.toJSON(),frameTop:Math.max(host.top,media.top+(media.height-video.videoHeight*scale)/2),frameBottom:Math.min(host.bottom,media.top+(media.height+video.videoHeight*scale)/2),text:art.template.$subtitle.textContent,time:art.currentTime,cues:__BplayerDesktop.sidecars.subtitleCount,ready:video.readyState,font:getComputedStyle(art.template.$subtitle).fontSize,shadow:getComputedStyle(art.template.$subtitle).textShadow,overflow:art.template.$subtitle.scrollHeight>art.template.$subtitle.clientHeight+1}})()`);
          assert(result.text.includes('字幕测试'), JSON.stringify({ width, height, fit, position, result })); assert.equal(result.font, '18px'); assert.equal(result.shadow, 'none');
          assert(result.sub.left >= result.host.left - 1 && result.sub.right <= result.host.right + 1);
          assert(result.sub.top >= result.host.top - 1 && result.sub.bottom <= result.host.bottom - 11);
          if (position === 'inside' || fit === 'cover') assert(Math.abs(result.sub.bottom - (result.frameBottom - 12)) <= 1.5, JSON.stringify(result));
          else if (result.frameBottom + 8 + result.sub.height <= result.host.bottom - 12) assert(Math.abs(result.sub.top - (result.frameBottom + 8)) <= 1.5, JSON.stringify(result));
          assert.equal(result.overflow, false);
          report.push({ width, height, fit, position, subtitleTop: result.sub.top, subtitleBottom: result.sub.bottom });
        }
      }
    }
    await call('Emulation.clearDeviceMetricsOverride', {});
    for (const position of ['inside', 'below']) {
      await evaluate(`Bplayer.art.video.style.objectFit='contain';document.getElementById('subtitlePosition').value=${JSON.stringify(position)};document.getElementById('subtitlePosition').dispatchEvent(new Event('change'));new Promise(resolve=>setTimeout(resolve,200))`);
      const screenshot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, `subtitle-position-${position}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    console.log(JSON.stringify({ passed: true, cases: report.length, report }, null, 2));
  } finally {
    try { await call('Emulation.clearDeviceMetricsOverride', {}); await evaluate(`if(AndroidPlayback.active)AndroidPlayback.exit();AndroidFiles.close();AndroidNavigation.clear();AndroidUI.setPlaybackActive(false);Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>localStorage.removeItem(key));Object.entries(${JSON.stringify(saved)}).forEach(([key,value])=>localStorage.setItem(key,value));true`); await call('Page.reload', {}); }
    finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
