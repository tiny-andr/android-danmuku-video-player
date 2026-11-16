const assert = require('node:assert/strict');

(async () => {
  const target = (await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json()).find(entry => entry.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  async function evaluate(expression) {
    const response = await new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Audio test timeout')); }, 30000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } })); });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value;
  }
  try {
    const report = await evaluate(`(async()=>{
      if(AndroidPlayback.active)throw new Error('Do not interrupt user playback');
      const report=[];
      for(const extension of ['mka','m4a']){
        const audio=new Audio();audio.crossOrigin='anonymous';audio.preload='auto';
        const context=new AudioContext();const source=context.createMediaElementSource(audio);const analyser=context.createAnalyser();const gain=context.createGain();gain.gain.value=0;source.connect(analyser);analyser.connect(gain);gain.connect(context.destination);
        const result={extension,canPlayType:audio.canPlayType(extension==='mka'?'audio/x-matroska; codecs="mp4a.40.2"':'audio/mp4; codecs="mp4a.40.2"')};
        try{
          audio.src=__TAURI__.core.convertFileSrc('/storage/emulated/0/Download/bplayer-audio-container-fixtures/tone.'+extension);
          await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Metadata timeout')),8000);audio.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve()},{once:true});audio.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Media error '+audio.error?.code))},{once:true});audio.load()});
          result.duration=audio.duration;audio.currentTime=3;await context.resume();await audio.play();
          await new Promise(resolve=>setTimeout(resolve,450));
          const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);result.rms=Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);result.time=audio.currentTime;
          audio.playbackRate=1.5;await new Promise(resolve=>setTimeout(resolve,250));result.fastTime=audio.currentTime;audio.pause();result.paused=audio.paused;result.ready=audio.readyState;result.success=result.duration>5.9&&result.duration<6.2&&result.rms>0.0001&&result.time>3&&result.fastTime>result.time&&result.paused;
        }catch(error){result.success=false;result.error=String(error)}
        finally{audio.pause();audio.removeAttribute('src');audio.load();source.disconnect();analyser.disconnect();gain.disconnect();await context.close()}
        report.push(result);
      }
      return report;
    })()`);
    console.log(JSON.stringify({ report }, null, 2));
    assert(report.some(result => result.success), 'At least one AAC cache container must decode and seek on the real WebView');
  } finally { socket.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
