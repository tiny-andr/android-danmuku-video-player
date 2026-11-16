const assert = require('node:assert/strict');

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
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    return evaluate(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-started>12000){clearInterval(timer);reject(new Error('Condition timeout'))}},100)})`);
  }
  const keys = ['bplayer.android.resume.v1', 'bplayer.android.recent.v1', 'bplayer.android.fileView', 'bplayer.android.lastDir'];
  const saved = await evaluate(`Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,localStorage.getItem(key)]))`);
  const report = { cards: [], resume: [] };
  try {
    await evaluate('AndroidUI.setPlaybackActive(true);AndroidUI.setKeepScreenOn(true);if(AndroidPlayback.active)AndroidPlayback.exit();document.getElementById("settingsMask").hidden=true;AndroidUI.setPlaybackActive(true);AndroidFiles.open("dir",null,"/storage/emulated/0/Download");true');
    await until('document.querySelectorAll("#aFileList .aRow").length>6');
    await evaluate('if(!document.getElementById("aFileList").classList.contains("is-grid"))document.getElementById("aFileView").click();true');
    const thumbnail = await evaluate('AndroidThumbnailsView.request("/storage/emulated/0/Download/test-hevc10-aac.mp4",{}).promise.then(result=>result.image)');
    assert(thumbnail, 'Real decoded thumbnail required');
    await evaluate(`document.querySelectorAll('.aFileThumb').forEach(image=>{image.src=${JSON.stringify(thumbnail)};image.classList.add('thumbnail-ready')});true`);
    await until('Array.from(document.querySelectorAll(".aFileThumb")).every(image=>image.complete&&image.naturalWidth>0)');
    for (const [width, height] of [[845, 919], [415, 931], [845, 919], [415, 931], [320, 720], [931, 415]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.55, mobile: true });
      await evaluate('new Promise(resolve=>setTimeout(resolve,180))');
      const result = await evaluate(`(()=>{
        const list=document.getElementById('aFileList');
        const rows=Array.from(list.querySelectorAll('.aRow'));
        const boxes=rows.map(row=>row.getBoundingClientRect());
        const escaped=[];const overlaps=[];
        rows.forEach((row,index)=>{
          const parent=boxes[index];
          row.querySelectorAll('.aFileThumb,.aFileIcon,.aFileDetail,.aName,.aMeta').forEach(child=>{
            const style=getComputedStyle(child);if(style.display==='none')return;
            const rect=child.getBoundingClientRect();
            if(rect.left<parent.left-1||rect.right>parent.right+1||rect.top<parent.top-1||rect.bottom>parent.bottom+1)escaped.push({name:row.querySelector('.aName').textContent,child:child.className,parent:parent.toJSON(),rect:rect.toJSON()});
          });
          boxes.forEach((other,otherIndex)=>{if(otherIndex>index&&Math.min(parent.right,other.right)-Math.max(parent.left,other.left)>1&&Math.min(parent.bottom,other.bottom)-Math.max(parent.top,other.top)>1)overlaps.push([index,otherIndex])});
        });
        return{viewport:[innerWidth,innerHeight],count:rows.length,escaped,overlaps,heights:boxes.map(rect=>rect.height),widthOverflow:list.scrollWidth>list.clientWidth+1};
      })()`);
      assert.equal(result.widthOverflow, false);
      assert.deepEqual(result.escaped, [], 'Card content must remain inside its owner');
      assert.deepEqual(result.overlaps, [], 'Cards must not overlap after resize');
      report.cards.push({ viewport: result.viewport, rows: result.count, minimumHeight: Math.min(...result.heights) });
    }
    await evaluate('document.querySelector("#aFileList .aRow:last-child").scrollIntoView({block:"end"});true');
    const scroll = await evaluate('(()=>{const list=document.getElementById("aFileList");const row=list.lastElementChild;return{scrollTop:list.scrollTop,lastBottom:row.getBoundingClientRect().bottom,listBottom:list.getBoundingClientRect().bottom}})()');
    assert(scroll.scrollTop > 0);
    assert(scroll.lastBottom <= scroll.listBottom + 1);
    await evaluate('AndroidFiles.close();AndroidResumeStore.create(localStorage).save("/storage/emulated/0/Download/test-hevc10-aac.mp4",8,20);__BplayerDesktop.loadVideo("/storage/emulated/0/Download/test-hevc10-aac.mp4",null);true');
    await until('AndroidPlayerTools.resumePending');
    await evaluate(`document.getElementById('mResumeName').textContent=${JSON.stringify('长文件名.'.repeat(100) + 'Pan.s.Labyrinth.2006.UHD.BluRay.2160p.10bit.HDR.2Audio.DTS-HD.MA.5.1.x265-beAst.mkv')};true`);
    for (const [width, height] of [[845, 919], [415, 931], [845, 919], [415, 931], [320, 720], [931, 415]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.55, mobile: true });
      await evaluate('new Promise(resolve=>setTimeout(resolve,180))');
      const result = await evaluate(`(()=>{
        const card=document.getElementById('mResumeCard');const rect=card.getBoundingClientRect();
        const name=document.getElementById('mResumeName');
        const buttons=Array.from(document.querySelectorAll('#mResumeActions button')).map(button=>{const box=button.getBoundingClientRect();return{text:button.textContent,rect:box.toJSON(),hit:button.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))}});
        return{viewport:[innerWidth,innerHeight],rect:rect.toJSON(),scrollWidth:card.scrollWidth,clientWidth:card.clientWidth,truncated:name.scrollWidth>name.clientWidth,buttons,pending:AndroidPlayerTools.resumePending};
      })()`);
      assert(result.pending);
      assert(result.rect.left >= 0 && result.rect.right <= width + 1);
      assert(result.rect.top >= 0 && result.rect.bottom <= height + 1);
      assert(result.scrollWidth <= result.clientWidth + 1);
      assert(result.truncated);
      for (const button of result.buttons) { assert(button.hit, button.text + ' must remain clickable'); assert(button.rect.left >= result.rect.left && button.rect.right <= result.rect.right + 1); }
      report.resume.push({ viewport: result.viewport, width: result.rect.width, buttons: result.buttons.map(button => button.hit) });
    }
    console.log(JSON.stringify({ passed: true, report }, null, 2));
  } finally {
    try {
      await call('Emulation.clearDeviceMetricsOverride', {});
      await evaluate(`AndroidFiles.close();if(AndroidPlayback.active)AndroidPlayback.exit();(()=>{const saved=${JSON.stringify(saved)};for(const key of ${JSON.stringify(keys)}){if(saved[key]===null)localStorage.removeItem(key);else localStorage.setItem(key,saved[key])}})();AndroidUI.setPlaybackActive(false);true`);
      await call('Page.reload', {});
    } finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
