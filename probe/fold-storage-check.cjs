const assert = require('node:assert/strict');
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9223}/json/list`)).json();
  const socket = new WebSocket(targets.find(entry => entry.type === 'page').webSocketDebuggerUrl);
  const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const reply = JSON.parse(event.data); const request = pending.get(reply.id); if (!request) return; pending.delete(reply.id); clearTimeout(request.timer); if (reply.error) request.reject(new Error(JSON.stringify(reply.error))); else request.resolve(reply.result); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  function call(method, params) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) { const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails)); return reply.result.value; }
  const report = {};
  const savedView = await evaluate('({files:localStorage.getItem("bplayer.android.fileView"),recent:localStorage.getItem("bplayer.android.recentView")})');
  try {
    await evaluate('if(AndroidPlayback.active)__aAndroidBack();document.getElementById("settingsMask").hidden=true;AndroidFiles.open("file",null,"/storage/emulated/0/Download");true');
    await evaluate('new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(document.querySelector(".aRow")){clearInterval(timer);resolve(true)}else if(Date.now()-started>8000){clearInterval(timer);reject(new Error("No rows"))}},100)})');
    const before = await evaluate('Array.from(document.querySelectorAll(".aRow")).map(row=>row.dataset.path).sort()');
    await evaluate('document.getElementById("aFileSort").value="modified";document.getElementById("aFileSort").dispatchEvent(new Event("change"));true');
    assert.equal(await evaluate('document.getElementById("aFileDirection").textContent'), '新→旧');
    await evaluate('document.getElementById("aFileDirection").click();true');
    assert.equal(await evaluate('document.getElementById("aFileDirection").textContent'), '旧→新');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".aRow")).map(row=>row.dataset.path).sort()'), before);
    report.sorting = 'name/type/time controls, direction and unchanged entry set';
    await evaluate('document.getElementById("aFileSort").value="type";document.getElementById("aFileSort").dispatchEvent(new Event("change"));true');
    report.layouts = [];
    for (const [width, height] of [[415, 931], [845, 919], [931, 415], [600, 800]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.55, mobile: true });
      const result = await evaluate('new Promise(resolve=>setTimeout(()=>resolve({viewport:[innerWidth,innerHeight],overflow:document.getElementById("aFileBox").scrollWidth>innerWidth+1,sidebar:getComputedStyle(document.querySelector(".aFileLayout")).flexDirection,quick:getComputedStyle(document.getElementById("mQuickSettings")).display,tools:document.getElementById("aFileTools").getBoundingClientRect().width,recentGap:document.querySelector(".mBody").getBoundingClientRect().bottom-document.querySelector(".mRight").getBoundingClientRect().bottom}),200))');
      assert.equal(result.overflow, false);
      if (width < height) assert(result.recentGap >= 0 && result.recentGap <= 26, 'Recent section must use available height');
      assert.equal(result.sidebar, width >= 720 && height >= 540 ? 'row' : 'column');
      assert.equal(result.quick, width >= 720 ? 'block' : 'none');
      report.layouts.push(result);
    }
    await call('Emulation.clearDeviceMetricsOverride', {});
    await evaluate('AndroidFiles.close();if(!document.getElementById("mRecentList").classList.contains("is-grid"))document.getElementById("mRecentView").click();true');
    assert.equal(await evaluate('document.getElementById("mRecentList").classList.contains("is-grid")'), true);
    report.recent = 'grid toggle works';
    await evaluate('document.getElementById("mRecentView").click();AndroidFiles.open("file","network");true');
    await evaluate('new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(document.querySelector(".aAdd")){clearInterval(timer);resolve(true)}else if(Date.now()-started>8000){clearInterval(timer);reject(new Error("Sources not ready"))}},100)})');
    await evaluate('document.querySelector(".aAdd").click();true');
    assert.match(await evaluate('document.querySelector("input[name=share]").closest("label").innerText'), /可选/);
    assert.equal(await evaluate('document.getElementById("aFileTools").hidden'), true);
    report.smbForm = 'optional share name and directory-only sorting tools';
    console.log(JSON.stringify({ passed: true, report }, null, 2));
  } finally {
    try {
      await call('Emulation.clearDeviceMetricsOverride', {});
      await evaluate(`AndroidFiles.close();(()=>{const saved=${JSON.stringify(savedView)};for(const [key,value] of [["bplayer.android.fileView",saved.files],["bplayer.android.recentView",saved.recent]]){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value)}})();true`);
      await call('Page.reload', {});
    } finally { socket.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
