const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async function () {
  const port = process.env.CDP_PORT || '9223';
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(entry => entry.type === 'page');
  assert(target, 'WebView target missing');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 25000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function until(expression) {
    return evaluate(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-started>12000){clearInterval(timer);reject(new Error('UI condition timeout'))}},80)})`);
  }
  async function screenshot(name) {
    const result = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(result.data, 'base64'));
  }
  try {
    if (process.env.INJECT_STORAGE === '1') {
      await evaluate(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-storage.js'), 'utf8'));
    }
    await evaluate('AndroidFiles.open("dir"); "opened"');
    await until('document.querySelector("#aPickHere:not(:disabled)")');
    const picker = await evaluate(`({
      bottomButtons:document.querySelectorAll('#aFileBar button').length,
      shortcuts:document.querySelectorAll('#aQuick button').length,
      label:document.getElementById('aPickHere').textContent,
      path:document.getElementById('aFilePath').textContent,
      overflow:document.getElementById('aFileBox').scrollWidth>innerWidth+1,
      videosDisabled:Array.from(document.querySelectorAll('#aFileList .aRow')).filter(row=>row.querySelector('.aMeta')).every(row=>row.disabled),
      width:innerWidth,height:innerHeight
    })`);
    assert.equal(picker.bottomButtons, 1);
    assert.equal(picker.shortcuts, 3);
    assert.equal(picker.label, '使用此文件夹');
    assert.equal(picker.overflow, false);
    assert.equal(picker.videosDisabled, true);
    await screenshot('storage-folder.png');
    await evaluate('document.getElementById("aNetworkTab").click(); "network"');
    await until('document.querySelector(".aAdd")');
    await screenshot('storage-sources.png');
    await evaluate('document.querySelector(".aAdd").click(); "form"');
    const protocols = await evaluate(`Array.from(document.querySelectorAll('#aSourceForm select option')).map(option=>option.value)`);
    assert.deepEqual(protocols, ['smb', 'webdav', 'sftp']);
    await evaluate(`document.querySelector('#aSourceForm select').value='webdav';document.querySelector('#aSourceForm select').dispatchEvent(new Event('change'))`);
    const webdav = await evaluate(`({urlVisible:!document.querySelector('input[name=url]').closest('label').hidden,hostHidden:document.querySelector('input[name=host]').closest('label').hidden,passwordType:document.querySelector('input[name=password]').type})`);
    assert.equal(webdav.urlVisible, true);
    assert.equal(webdav.hostHidden, true);
    assert.equal(webdav.passwordType, 'password');
    await screenshot('storage-webdav.png');
    await evaluate(`document.querySelector('#aSourceForm select').value='sftp';document.querySelector('#aSourceForm select').dispatchEvent(new Event('change'))`);
    await screenshot('storage-sftp.png');
    await evaluate(`Array.from(document.querySelectorAll('#aSourceForm .aFormActions button')).find(button=>button.textContent==='测试连接').click()`);
    await until('document.querySelector(".aFormMessage[data-kind=error]")');
    const alert = await evaluate(`(()=>{const element=document.querySelector('.aFormMessage[data-kind=error]');return {role:element.getAttribute('role'),text:element.textContent,border:getComputedStyle(element).borderTopWidth}})()`);
    assert.equal(alert.role, 'alert'); assert(parseFloat(alert.border) >= 1.5); assert.match(alert.text, /连接失败/);
    await screenshot('storage-error.png');
    await evaluate('AndroidFiles.back(); "back"');
    await until('document.querySelector(".aAdd")');
    assert.equal(await evaluate('!!document.getElementById("aDiscoverSmb")'), true);
    await evaluate('AndroidFiles.close(); "closed"');
    assert.equal(await evaluate('document.getElementById("aFileMask").hidden'), true);
    console.log(JSON.stringify({ passed: true, picker, protocols, webdav }, null, 2));
  } finally {
    socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
