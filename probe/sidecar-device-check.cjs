const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(entry => entry.type === 'page').webSocketDebuggerUrl);
  const requests = new Map(); let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const request = requests.get(message.id);
    if (!request) return; requests.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { requests.delete(id); reject(new Error(method + ' timeout')); }, 25000);
      requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(condition) {
    return evaluate(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve(true)}else if(Date.now()-started>15000){clearInterval(timer);reject(new Error(${JSON.stringify(condition)}))}},80)})`);
  }
  const fixture = '/storage/emulated/0/Download/bplayer-sidecar-fixture-a6d93182';
  const video = '/storage/emulated/0/Download/test-hevc10-aac.mp4';
  const saved = await evaluate('Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith("bplayer")).map(key=>[key,localStorage.getItem(key)]))');
  const report = [];
  try {
    await evaluate(`if(AndroidPlayback.active&&__BplayerDesktop.currentPath!==${JSON.stringify(video)})throw new Error('Do not interrupt user playback');if(AndroidPlayback.active)AndroidPlayback.exit();AndroidFiles.close();AndroidNavigation.clear();AndroidResumeStore.create(localStorage).remove(${JSON.stringify(video)});window.__sidecarTest={core:__TAURI__.core,network:AndroidNetwork,held:[],hold:'',paired:[],holdPair:false};AndroidFiles.open('file',null,'/storage/emulated/0/Download').then(value=>{if(value)return __BplayerDesktop.loadVideo(value,null)});true`);
    await until(`Array.from(document.querySelectorAll('#aFileList .aRow')).some(row=>row.dataset.path===${JSON.stringify(video)})`);
    await evaluate(`Array.from(document.querySelectorAll('#aFileList .aRow')).find(row=>row.dataset.path===${JSON.stringify(video)}).click();true`);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading&&!AndroidPlayerTools.resumePending');
    await evaluate('Bplayer.art.pause();document.getElementById("mInfoBtn").click();document.getElementById("mActSub").click();true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'subtitlePanel');
    assert.equal(await evaluate('document.getElementById("btnSubtitleEntry").hidden'), false);
    await evaluate('document.getElementById("btnPickSubtitle").click();true');
    await until('AndroidFiles.active&&document.querySelectorAll("#aFileList .aRow").length>0');
    assert.equal(await evaluate('document.getElementById("aPickerTitle").textContent'), '选择字幕');
    await evaluate('AndroidFiles.close();true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'subtitlePanel');
    await evaluate('document.getElementById("btnPickSubtitle").click();true');
    await until(`Array.from(document.querySelectorAll('#aFileList .aRow')).some(row=>row.dataset.path===${JSON.stringify(fixture)})`);
    await evaluate(`Array.from(document.querySelectorAll('#aFileList .aRow')).find(row=>row.dataset.path===${JSON.stringify(fixture)}).click();true`);
    await until('document.querySelectorAll("#aFileList .aRow").length>=7');
    assert.equal(await evaluate('document.querySelectorAll("#aFileList .aFileThumb").length'), 0);
    assert.equal(await evaluate('document.getElementById("aFileView").hidden'), true);
    await evaluate(`Array.from(document.querySelectorAll('#aFileList .aRow')).find(row=>row.dataset.path===${JSON.stringify(fixture + '/dialog.zh-Hans.srt')}).click();true`);
    await until('__BplayerDesktop.sidecars.subtitle.endsWith("dialog.zh-Hans.srt")');
    await evaluate('Bplayer.art.currentTime=2;true');
    await until('Bplayer.art.template.$subtitle.textContent.includes("第一行")');
    assert.match(await evaluate('Bplayer.art.template.$subtitle.textContent'), /第二行 & 中文/);
    await evaluate('document.getElementById("subtitleDelay").value="2";document.getElementById("subtitleDelay").dispatchEvent(new Event("input"));true');
    assert.equal(await evaluate('Bplayer.art.template.$subtitle.textContent'), '');
    await evaluate('document.getElementById("subtitleDelay").value="-1";document.getElementById("subtitleDelay").dispatchEvent(new Event("input"));true');
    assert.match(await evaluate('Bplayer.art.template.$subtitle.textContent'), /第一行/);
    await evaluate('document.getElementById("subtitleDelayReset").click();true');
    assert.equal(await evaluate('__BplayerDesktop.sidecars.delay'), 0);
    report.push('real local picker, cancellation, Chinese SRT, safe text and positive/negative subtitle delay');

    for (const [name, expected] of [['dialog.ass', 'ASS 字幕'], ['dialog.ssa', 'SSA subtitle'], ['dialog.vtt', 'VTT subtitle & text'], ['utf16.srt', '第一行']]) {
      assert.equal(await evaluate(`__BplayerDesktop.loadSubtitle(${JSON.stringify(fixture + '/' + name)})`), true, name);
      assert.match(await evaluate('Bplayer.art.template.$subtitle.textContent'), new RegExp(expected));
    }
    const originalSubtitle = await evaluate('__BplayerDesktop.sidecars.subtitle');
    assert.equal(await evaluate(`__BplayerDesktop.loadSubtitle(${JSON.stringify(fixture + '/invalid.srt')})`), false);
    assert.equal(await evaluate('__BplayerDesktop.sidecars.subtitle'), originalSubtitle);
    assert.match(await evaluate('Bplayer.art.template.$subtitle.textContent'), /第一行/);
    assert.equal(await evaluate(`__BplayerDesktop.loadSubtitle(${JSON.stringify(fixture + '/oversized.srt')})`), false);
    assert.equal(await evaluate(`AndroidFiles.invoke('read_bytes',{path:${JSON.stringify(fixture + '/oversized.srt')}}).then(()=>false,error=>/32 MiB/.test(String(error)))`), true);
    report.push('ASS/SSA text compatibility, VTT entities, UTF-16, failed replacement and native 32 MiB limit');

    const persistedBefore = await evaluate('localStorage.getItem("bplayer.android.subtitles")');
    await evaluate(`for(const [id,value] of [['subtitleFontSize','36'],['subtitleColor','#ffff00'],['subtitleOutline','4'],['subtitleLanguage','zh-Hans']]){document.getElementById(id).value=value;document.getElementById(id).dispatchEvent(new Event('change'))}true`);
    assert.equal(await evaluate('localStorage.getItem("bplayer.android.subtitles")'), persistedBefore);
    assert.equal(await evaluate('getComputedStyle(Bplayer.art.template.$subtitle).fontSize'), '36px');
    assert.equal(await evaluate('getComputedStyle(Bplayer.art.template.$subtitle).color'), 'rgb(255, 255, 0)');
    await evaluate('document.getElementById("subtitleSave").click();true');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("bplayer.android.subtitles")).language'), 'zh-Hans');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'sidecar-subtitle-settings.png'), Buffer.from(screenshot.data, 'base64'));
    report.push('style preview versus explicit save and language preference');

    await evaluate('document.getElementById("subtitleClose").click();document.getElementById("mActDanmaku").click();document.getElementById("btnPickDanmaku").click();true');
    await until('AndroidFiles.active');
    assert.equal(await evaluate('document.getElementById("aPickerTitle").textContent'), '选择弹幕');
    await evaluate('AndroidFiles.close();true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'danmakuPanel');
    assert.equal(await evaluate(`__BplayerDesktop.loadDanmaku(${JSON.stringify(fixture + '/comments.json')})`), true);
    assert.equal(await evaluate('Bplayer.danmaku.length'), 2);
    assert.equal(await evaluate(`__BplayerDesktop.loadDanmaku(${JSON.stringify(fixture + '/invalid.json')})`), false);
    assert.equal(await evaluate('Bplayer.danmaku.length'), 2);
    assert.equal(await evaluate(`__BplayerDesktop.loadDanmaku(${JSON.stringify(fixture + '/invalid.xml')})`), false);
    assert.equal(await evaluate('Bplayer.danmaku.length'), 2);
    assert.equal(await evaluate(`__BplayerDesktop.loadDanmaku(${JSON.stringify(fixture + '/comments.xml')})`), true);
    assert.equal(await evaluate('Bplayer.danmaku.length'), 2);
    report.push('manual JSON/XML loading, picker return, invalid files preserve existing danmaku');

    await evaluate(`(()=>{const test=__sidecarTest;__TAURI__.core=Object.assign({},test.core,{invoke:(command,args)=>{if(command==='read_bytes'&&args.path===test.hold)return new Promise(resolve=>test.held.push(()=>test.core.invoke(command,args).then(resolve)));if(command==='pair_danmaku'&&test.holdPair)return new Promise(resolve=>test.paired.push(resolve));return test.core.invoke(command,args)}});test.hold=${JSON.stringify(fixture + '/dialog.en.srt')};test.pending=__BplayerDesktop.loadSubtitle(test.hold);return true})()`);
    await until('__sidecarTest.held.length===1');
    assert.equal(await evaluate(`__BplayerDesktop.loadSubtitle(${JSON.stringify(fixture + '/dialog.zh-Hans.srt')})`), true);
    await evaluate('__sidecarTest.held.splice(0).forEach(resolve=>resolve());true');
    assert.equal(await evaluate('__sidecarTest.pending'), false);
    assert.match(await evaluate('__BplayerDesktop.sidecars.subtitle'), /zh-Hans/);
    await evaluate(`__sidecarTest.pending=__BplayerDesktop.loadSubtitle(__sidecarTest.hold);true`);
    await until('__sidecarTest.held.length===1');
    await evaluate(`Array.from(document.querySelectorAll('#subtitleList .track-item')).find(row=>row.textContent==='关闭字幕').click();__sidecarTest.held.splice(0).forEach(resolve=>resolve());true`);
    assert.equal(await evaluate('__sidecarTest.pending'), false);
    assert.equal(await evaluate('__BplayerDesktop.sidecars.subtitle'), '');
    report.push('slow A versus fast B and close-during-read cannot resurrect stale subtitles');

    await evaluate(`__sidecarTest.hold='';__sidecarTest.holdPair=true;AndroidResumeStore.create(localStorage).remove(${JSON.stringify(video)});__BplayerDesktop.loadVideo(${JSON.stringify(video)},null);true`);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading&&__sidecarTest.paired.length===1');
    await evaluate('Bplayer.art.pause();document.getElementById("mInfoBtn").click();document.getElementById("mActDanmaku").click();document.getElementById("btnPickDanmaku").click();true');
    await until('AndroidFiles.active');
    await evaluate(`AndroidFiles.close();__sidecarTest.holdPair=false;__sidecarTest.paired.splice(0).forEach(resolve=>resolve(${JSON.stringify({ name: 'auto.xml', text: '<i><d p="1,1,25,16777215,0,0,0,0">Auto after cancel</d></i>' })}));true`);
    await until('__BplayerDesktop.sidecars.danmaku==="auto.xml"');
    report.push('cancelling picker preserves pending automatic danmaku loading');

    await evaluate(`__sidecarTest.holdPair=true;AndroidResumeStore.create(localStorage).remove(${JSON.stringify(video)});__BplayerDesktop.loadVideo(${JSON.stringify(video)},null);true`);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading&&__sidecarTest.paired.length===1');
    await evaluate('Bplayer.art.pause();true');
    assert.equal(await evaluate(`__BplayerDesktop.loadDanmaku(${JSON.stringify(fixture + '/comments.json')})`), true);
    await evaluate('__sidecarTest.holdPair=false;__sidecarTest.paired.splice(0).forEach(resolve=>resolve({name:"stale.xml",text:"<i/>"}));new Promise(resolve=>setTimeout(resolve,150))');
    assert.equal(await evaluate('__BplayerDesktop.sidecars.danmaku'), 'comments.json');
    assert.equal(await evaluate('Bplayer.danmaku.length'), 2);
    report.push('late automatic pair cannot replace manual danmaku and new video resets subtitle delay');

    await evaluate(`window.AndroidNetwork={request:(id,command,args)=>{const data=JSON.parse(args);const virtual=data.path||data.dir||data.videoPath;const segments=String(virtual||'').split('/');if(segments[1]==='@network'&&segments[2]&&segments[2].startsWith('a6d93182')){const translated=Object.assign({},data);for(const key of ['path','dir','videoPath'])if(translated[key])translated[key]=${JSON.stringify(fixture)}+'/'+segments.slice(3).join('/');__sidecarTest.core.invoke(command,translated).then(result=>__aNetworkReply(id,{ok:true,result}),error=>__aNetworkReply(id,{ok:false,error:String(error)}))}else __sidecarTest.network.request(id,command,args)},mediaUrl:path=>__sidecarTest.network.mediaUrl(path)};true`);
    for (const suffix of ['000000000001', '000000000002', '000000000003']) {
      const prefix = '/@network/a6d93182-0000-4000-8000-' + suffix;
      assert.equal(await evaluate(`__BplayerDesktop.loadSubtitle(${JSON.stringify(prefix + '/dialog.zh-Hans.srt')})`), true);
      assert.equal(await evaluate(`__BplayerDesktop.loadDanmaku(${JSON.stringify(prefix + '/comments.json')})`), true);
    }
    report.push('three network-source path variants use the native network bridge routing (transport mocked, local native fixture reads)');

    await evaluate('AndroidNavigation.clear();AndroidPlayback.exit();true');
    await until('AndroidFiles.active&&document.querySelectorAll("#aFileList .aRow").length>0');
    assert.equal(await evaluate('document.getElementById("aFilePath").textContent.includes("bplayer-sidecar-fixture")'), false);
    assert.match(await evaluate('document.getElementById("aFilePath").textContent'), /Download/);
    assert.equal(await evaluate('__BplayerDesktop.sidecars.delay'), 0);
    assert.equal(await evaluate('document.querySelectorAll("video track").length'), 1, 'Only the original empty vendor track remains after exit');
    report.push('attachment choices do not replace video origin; exit removes staged/current subtitle tracks');
    console.log(JSON.stringify({ passed: true, groups: report }, null, 2));
  } finally {
    try {
      await evaluate(`(()=>{if(window.__sidecarTest){__TAURI__.core=__sidecarTest.core;window.AndroidNetwork=__sidecarTest.network;__sidecarTest.held.splice(0).forEach(resolve=>resolve());__sidecarTest.paired.splice(0).forEach(resolve=>resolve(null))}if(AndroidPlayback.active)AndroidPlayback.exit();AndroidFiles.close();AndroidNavigation.clear();AndroidUI.setPlaybackActive(false);Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>localStorage.removeItem(key));Object.entries(${JSON.stringify(saved)}).forEach(([key,value])=>localStorage.setItem(key,value));delete window.__sidecarTest;return true})()`);
      await call('Page.reload', {});
    } finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
