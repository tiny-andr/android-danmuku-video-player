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
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 25000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    return evaluate(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-started>15000){clearInterval(timer);reject(new Error(${JSON.stringify(expression)}))}},80)})`);
  }
  async function screenshot(name) {
    const result = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(result.data, 'base64'));
  }
  const report = [];
  try {
    assert.equal(await evaluate('AndroidPlayback.active'), false, 'Do not interrupt existing playback');
    await evaluate(`(async()=>{
      if(document.visibilityState!=='visible')throw new Error('Unlock the phone before running navigation tests');
      const sample='/storage/emulated/0/Download/test-hevc10-aac.mp4';
      const stat=await AndroidFiles.invoke('fs_stat',{path:sample});if(stat.kind!=='file')throw new Error('Playback fixture missing');
      window.__navTest={saved:Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)])),core:__TAURI__.core,invoke:__TAURI__.core.invoke,convert:__TAURI__.core.convertFileSrc,network:AndroidNetwork,sample,fail:false,offline:false,held:[],hold:false};
      const test=window.__navTest;test.resume=AndroidResumeStore.create(localStorage);
      test.entries=dir=>Array.from({length:80},(_,index)=>({name:'Episode '+String(index+1).padStart(3,'0')+'.mp4',path:dir+'/Episode '+String(index+1).padStart(3,'0')+'.mp4',is_dir:false,size:stat.size,modified_ms:1000+index})).concat([{name:'Child',path:dir+'/Child',is_dir:true,size:0}]);
      test.handle=async(command,args)=>{
        if(test.holdStat&&command==='fs_stat')return new Promise(resolve=>test.held.push(()=>resolve(stat)));
        if(test.hold&&command==='scan_folder'&&(!test.holdDir||args.dir===test.holdDir))return new Promise(resolve=>test.held.push(()=>resolve({label:'Fixture',episodes:test.entries(args.dir).filter(entry=>!entry.is_dir)})));
        if(command==='list_dir'){if(test.offline)throw new Error('Fixture offline');return{dir:args.dir,entries:test.entries(args.dir)}}
        if(command==='fs_stat'){if(test.fail)throw new Error('Fixture load failure');return stat}
        if(command==='scan_folder')return{label:'Fixture',episodes:test.entries(args.dir).filter(entry=>!entry.is_dir)};
        if(command==='pair_danmaku')return null;if(command==='scan_subtitles')return[];
        if(command==='clean_sidecar_tmp')return 0;
        return test.invoke(command,args);
      };
      __TAURI__.core=Object.assign({},__TAURI__.core);
      __TAURI__.core.invoke=(command,args)=>args&&String(args.dir||args.path||args.videoPath||'').includes('navigation-fixture')?test.handle(command,args):test.invoke(command,args);
      __TAURI__.core.convertFileSrc=(file,...args)=>test.convert(file.includes('navigation-fixture')?sample:file,...args);
      window.AndroidNetwork={request:(id,command,args)=>{
        const data=JSON.parse(args||'{}');
        if(command==='network_sources'){setTimeout(()=>__aNetworkReply(id,{ok:true,result:[{id:'navigation-fixture',name:'Navigation fixture',protocol:'smb',host:'fixture.invalid'}]}),0);return}
        test.handle(command,data).then(result=>__aNetworkReply(id,{ok:true,result}),error=>__aNetworkReply(id,{ok:false,error:error.message}));
      },mediaUrl:()=>test.convert(sample)};
      AndroidUI.setKeepScreenOn(true);AndroidUI.setPlaybackActive(true);return true;
    })()`);
    async function open(dir, mode = 'file') {
      await evaluate(`AndroidFiles.close();AndroidFiles.open(${JSON.stringify(mode)},null,${JSON.stringify(dir)}).then(value=>{if(value){if(${JSON.stringify(mode)}==='dir')return __BplayerDesktop.openFolder(value);return __BplayerDesktop.loadVideo(value,null)}});AndroidUI.setPlaybackActive(true);true`);
      await until('document.querySelectorAll("#aFileList .aRow").length===81');
      await evaluate(`if(document.getElementById('aFileList').classList.contains('is-grid'))document.getElementById('aFileView').click();document.getElementById('aFileSort').value='name';document.getElementById('aFileSort').dispatchEvent(new Event('change'));true`);
    }
    async function choose(index = 40) {
      return evaluate(`(()=>{const rows=document.querySelectorAll('#aFileList .aRow');const row=rows[${index}];row.scrollIntoView({block:'center'});__navTest.expected=AndroidNavigation.captureScroll(document.getElementById('aFileList'));__navTest.chosen=row.dataset.path;__navTest.resume.remove(row.dataset.path);row.click();return __navTest.expected})()`);
    }
    async function browserRestored(expected) {
      await until('AndroidFiles.active&&document.querySelectorAll("#aFileList .aRow").length===81');
      const position = await evaluate('AndroidNavigation.captureScroll(document.getElementById("aFileList"))');
      assert.equal(position.path, expected.path);
      assert(Math.abs(position.offset - expected.offset) < 5, `Anchor offset ${position.offset} != ${expected.offset}`);
      await evaluate('AndroidUI.setPlaybackActive(true);true');
    }
    await open('/sdcard/navigation-fixture');
    let expected = await choose();
    await until('AndroidPlayback.active&&!AndroidPlayback.loading&&!AndroidPlayerTools.resumePending');
    await evaluate('Bplayer.art.pause();document.getElementById("mInfoBtn").click();document.getElementById("mActSettings").click();true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'settingsMask');
    await evaluate('document.getElementById("settingsClose").click();true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'mInfo');
    await screenshot('navigation-info-return.png');
    for (const [button, panel, close] of [['mActBlock','blockPanel','blockClose'],['mActAudio','audioPanel','audioClose'],['mActSub','subtitlePanel','subtitleClose']]) {
      await evaluate(`document.getElementById(${JSON.stringify(button)}).disabled=false;document.getElementById(${JSON.stringify(button === 'mActAudio' ? 'btnAudioEntry' : button === 'mActSub' ? 'btnSubtitleEntry' : 'btnBlockEntry')}).hidden=false;document.getElementById(${JSON.stringify(button)}).click();true`);
      assert.equal(await evaluate('AndroidNavigation.top'), panel);
      await evaluate(`document.getElementById(${JSON.stringify(close)}).click();true`);
      assert.equal(await evaluate('AndroidNavigation.top'), 'mInfo');
    }
    await evaluate('document.getElementById("mPlBtn").click();true');
    assert.equal(await evaluate('document.getElementById("mInfo").hidden'), true);
    await evaluate('__aAndroidBack();true');
    assert.equal(await evaluate('AndroidNavigation.top'), null);
    assert.equal(await evaluate('AndroidPlayback.active'), true);
    await evaluate('document.getElementById("mQuickSettings").click();document.getElementById("settingsClose").click();true');
    assert.equal(await evaluate('AndroidNavigation.top'), null);
    await evaluate('Bplayer.art.setting.show=true;true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'playerSettings');
    await evaluate('__aAndroidBack();true');
    assert.equal(await evaluate('Bplayer.art.setting.show'), false);
    assert.equal(await evaluate('AndroidPlayback.active'), true);
    await evaluate('document.querySelector(".mDanControls .apd-config").click();true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'danmaku');
    await evaluate('document.getElementById("mRotateBtn").click();true');
    assert.equal(await evaluate('AndroidNavigation.top'), null);
    await evaluate('document.getElementById("mInfoBtn").click();Bplayer.art.emit("video:canplay");true');
    assert.equal(await evaluate('AndroidNavigation.top'), 'mInfo', 'Buffer readiness must not dismiss open panels');
    await evaluate('document.getElementById("mBack").click();true');
    assert.equal(await evaluate('AndroidPlayback.active'), true, 'Top Back closes the panel first');
    await evaluate('document.getElementById("mBack").click();true');
    await browserRestored(expected);
    await screenshot('navigation-browser-return.png');
    report.push('real media playback, nested panels, direct controls, buffer event and top/system Back');

    expected = await choose(46);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading');
    await evaluate('AndroidPlayerTools.lock();__aAndroidBack();true');
    assert.equal(await evaluate('AndroidPlayerTools.locked'), false);
    assert.equal(await evaluate('AndroidPlayback.active'), true);
    await evaluate('__aAndroidBack();true'); await browserRestored(expected);
    report.push('touch-lock Back unlocks without exiting');

    await evaluate(`__navTest.resume.save(__navTest.chosen,8,20);document.querySelectorAll('#aFileList .aRow')[46].click();true`);
    await until('AndroidPlayerTools.resumePending');
    await evaluate('document.getElementById("mResumeCancel").click();true'); await browserRestored(expected);
    report.push('resume cancellation restores the browser');

    await evaluate('__navTest.fail=true;true');
    expected = await choose(48); await until('document.querySelector("#mLoading.failed")');
    await evaluate('document.getElementById("mLoadingCancel").click();true'); await browserRestored(expected);
    report.push('failed loading returns to its original directory and scroll');
    await evaluate('__navTest.fail=false;__navTest.holdStat=true;true');
    expected = await choose(54); await until('__navTest.held.length===1');
    await evaluate('__aAndroidBack();__navTest.holdStat=false;__navTest.held.splice(0).forEach(resolve=>resolve());true');
    await browserRestored(expected);
    assert.equal(await evaluate('AndroidPlayback.active'), false);
    await evaluate('__navTest.fail=true;true');
    report.push('loading cancellation discards late file-stat results');

    await open('/@network/navigation-fixture/Movies');
    expected = await choose(43); await until('document.querySelector("#mLoading.failed")');
    await evaluate('__aAndroidBack();true'); await browserRestored(expected);
    await evaluate('__navTest.fail=false;true');
    expected = await choose(43); await until('AndroidPlayback.active&&!AndroidPlayback.loading');
    await evaluate('Bplayer.art.pause();__navTest.offline=true;__aAndroidBack();true');
    await until('AndroidFiles.active&&document.querySelector("#aFileList .aStatus button")');
    assert.match(await evaluate('document.getElementById("aFilePath").textContent'), /Movies/);
    await evaluate('__navTest.offline=false;document.querySelector("#aFileList .aStatus button").click();true');
    await browserRestored(expected);
    report.push('network-origin playback and failure return to the same network directory');

    await open('/sdcard/navigation-fixture/old');
    await evaluate('__navTest.hold=true;__navTest.holdDir="/sdcard/navigation-fixture/old";true');
    expected = await choose(30);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading&&__navTest.held.length===1');
    await evaluate('Bplayer.art.pause();__BplayerDesktop.openFolder("/sdcard/navigation-fixture/new");true');
    await until('AndroidNavigation.top==="playlist"&&document.querySelector("#plList .pl-item").dataset.path.includes("/new/")');
    await evaluate('__navTest.hold=false;__navTest.holdDir="";__navTest.held.splice(0).forEach(resolve=>resolve());new Promise(resolve=>setTimeout(resolve,150))');
    assert.equal(await evaluate('document.querySelector("#plList .pl-item").dataset.path.includes("/new/")'), true);
    await evaluate('AndroidPlayback.exit();true');await browserRestored(expected);
    report.push('late automatic sibling scans cannot overwrite a newer explicit folder');

    await open('/sdcard/navigation-fixture', 'dir');
    await evaluate('document.getElementById("aFileList").scrollTop=600;__navTest.folderExpected=AndroidNavigation.captureScroll(document.getElementById("aFileList"));document.getElementById("aPickHere").click();true');
    await until('AndroidNavigation.top==="playlist"&&document.querySelectorAll("#plList .pl-item").length===80');
    const playlistPosition = await evaluate(`(()=>{const row=document.querySelectorAll('#plList .pl-item')[35];row.scrollIntoView({block:'center'});const position=AndroidNavigation.captureScroll(document.getElementById('plList'));row.click();return position})()`);
    await until('AndroidPlayback.active&&!AndroidPlayback.loading');
    await evaluate('__BplayerNext();true');
    await until('!AndroidPlayback.loading&&__BplayerDesktop.currentPath.endsWith("Episode 037.mp4")');
    await evaluate('Bplayer.art.pause();__aAndroidBack();true');
    await until('AndroidNavigation.top==="playlist"');
    const restoredPlaylistPosition = await evaluate('AndroidNavigation.captureScroll(document.getElementById("plList"))');
    assert.equal(restoredPlaylistPosition.path, playlistPosition.path);
    assert(Math.abs(restoredPlaylistPosition.offset - playlistPosition.offset) < 5);
    assert.match(await evaluate('document.querySelector("#plList .current").dataset.path'), /Episode 037\.mp4$/);
    await screenshot('navigation-playlist-return.png');
    const folderExpected = await evaluate('__navTest.folderExpected');
    await evaluate('document.getElementById("plClose").click();true'); await browserRestored(folderExpected);
    assert.equal(await evaluate('document.getElementById("aPickerTitle").textContent'), '选择文件夹');
    report.push('explicit playlist, auto-next and folder-mode caller restoration');

    await evaluate('__navTest.hold=true;document.getElementById("aPickHere").click();true');
    await until('__navTest.held.length===1');
    await evaluate('__aAndroidBack();__navTest.hold=false;__navTest.held.splice(0).forEach(resolve=>resolve());true');
    await browserRestored(folderExpected);
    assert.equal(await evaluate('AndroidNavigation.top'), null);
    report.push('cancelled folder scans cannot reopen the playlist');
    await evaluate('AndroidFiles.close();AndroidNavigation.clear();AndroidPlayback.exit();true');
    await evaluate('localStorage.setItem("bplayer.android.recent.v1",JSON.stringify(Array.from({length:8},(_,index)=>({p:"/sdcard/navigation-fixture/recent/Recent "+index+".mp4",n:"Recent "+index+".mp4",t:Date.now()-index}))));AndroidPlayback.exit();document.getElementById("mRecentList").style.maxHeight="150px";document.getElementById("mRecentList").scrollTop=200;__navTest.homeExpected=AndroidNavigation.captureScroll(document.getElementById("mRecentList"));__navTest.fail=true;document.querySelectorAll(".mRecentRow")[5].click();true');
    await until('document.querySelector("#mLoading.failed")');
    await evaluate('__aAndroidBack();true');
    assert.equal(await evaluate('AndroidFiles.active'), false);
    assert.equal(await evaluate('document.getElementById("mHome").classList.contains("hide")'), false);
    const recentPosition=await evaluate('AndroidNavigation.captureScroll(document.getElementById("mRecentList"))');
    const recentExpected=await evaluate('__navTest.homeExpected');
    assert.equal(recentPosition.path,recentExpected.path);
    assert(Math.abs(recentPosition.offset-recentExpected.offset)<5);
    await evaluate('__navTest.fail=false;document.querySelectorAll(".mRecentRow")[5].click();true');
    await until('AndroidPlayback.active&&!AndroidPlayback.loading');
    await evaluate('Bplayer.art.pause();__aAndroidBack();true');
    assert.equal(await evaluate('AndroidFiles.active'), false);
    const restoredRecent = await evaluate(`(()=>{const box=document.getElementById('mRecentList');const row=Array.from(box.querySelectorAll('[data-path]')).find(row=>row.dataset.path===__navTest.homeExpected.path);return{present:!!row,offset:row?row.getBoundingClientRect().top-box.getBoundingClientRect().top:null}})()`);
    assert(restoredRecent.present);
    assert(Math.abs(restoredRecent.offset-recentExpected.offset)<5);
    report.push('recent-origin playback and failure restore home and its scroll anchor');
    console.log(JSON.stringify({ passed: true, groups: report }, null, 2));
  } finally {
    try {
      await evaluate(`(()=>{if(!window.__navTest)return;const test=__navTest;AndroidFiles.close();AndroidNavigation.invalidate();if(AndroidPlayback.active)AndroidPlayback.exit();AndroidFiles.close();AndroidNavigation.clear();__TAURI__.core=test.core;window.AndroidNetwork=test.network;test.held.splice(0).forEach(resolve=>resolve());Object.keys(localStorage).filter(key=>key.startsWith('bplayer')).forEach(key=>{if(!(key in test.saved))localStorage.removeItem(key)});Object.entries(test.saved).forEach(([key,value])=>{if(key.startsWith('bplayer'))localStorage.setItem(key,value)});AndroidUI.setPlaybackActive(false);delete window.__navTest;return true})()`);
      await call('Page.reload', {});
    } finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
