#!/usr/bin/env node
// 新旧版本 UI 结构对比探针。同一份采集逻辑分别跑在 Pad（v0.1.4 老包）和手机（新版）上，
// 输出 JSON 后逐项 diff，用来找「老版本有、新版本没有」或「两边长得不一样」的地方。
//
//   $env:CDP_PORT='9223'; node probe/parity-probe.mjs > tmp/parity-phone.json
//   $env:CDP_PORT='9224'; node probe/parity-probe.mjs > tmp/parity-pad.json
//
// 采集只读 DOM，不点击、不改状态，可以在任意页面状态下跑。

const PORT = process.env.CDP_PORT || '9223';

async function connect() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url || '')) || list[0];
  if (!page) throw new Error('没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const evaluate = (expr) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, (msg) => {
      if (msg.result?.exceptionDetails) resolve({ __error: msg.result.exceptionDetails.text });
      else resolve(msg.result?.result?.value);
    });
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { ws, evaluate };
}

const PROBE = `(function () {
  function txt(el) { return (el && (el.getAttribute('title') || el.textContent || '')).trim().slice(0, 40); }
  function list(sel) {
    var out = [];
    document.querySelectorAll(sel).forEach(function (el) { out.push(el.id || txt(el) || el.className); });
    return out;
  }
  function visible(el) {
    if (!el) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
  }
  var art = window.Bplayer && window.Bplayer.art;

  return {
    // ---- 运行环境 ----
    env: {
      hasMpv: !!window.AndroidMpv,
      hasAudioNative: !!window.AndroidAudioNative,
      buildKind: (function () { try { return AndroidUI.buildKind(); } catch (e) { return '?'; } })(),
      bodyClass: document.body.className,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
    },
    // ---- 首页 ----
    home: {
      toolbarIds: list('.toolbar button, .toolbar .field'),
      homeText: (document.querySelector('.home') || document.body).textContent.replace(/\\s+/g, ' ').trim().slice(0, 200),
      recentRows: document.querySelectorAll('.mRecentRow').length,
    },
    // ---- 播放页顶栏 ----
    top: {
      childIds: list('#mTop > *'),
      buttons: list('#mTop button'),
      visible: visible(document.getElementById('mTop')),
    },
    // ---- 播放器底部控制条 ----
    controls: {
      left: list('#player .art-controls-left .art-control'),
      right: list('#player .art-controls-right .art-control'),
      center: list('#player .art-controls-center .art-control'),
      settingsButtons: list('#player .art-settings button'),
    },
    // ---- 信息卡 ----
    info: {
      rows: list('#mInfo .mi-row .mi-k'),
      actions: list('#mInfo button'),
    },
    // ---- 字幕面板 ----
    subtitle: {
      panelExists: !!document.getElementById('subtitlePanel'),
      listItems: list('#subtitleList > *'),
      countText: (document.getElementById('subtitleCount') || {}).textContent || '',
    },
    // ---- 音轨面板 ----
    audio: {
      panelExists: !!document.getElementById('audioPanel'),
      listItems: list('#audioTrackList > *'),
      countText: (document.getElementById('audioTrackCount') || {}).textContent || '',
    },
    // ---- 设置 ----
    settings: {
      keys: list('#settingsMask .set-row, #settingsMask label, #settingsMask .set-key'),
      ids: list('#settingsMask [id]'),
    },
    // ---- 字幕渲染方式 ----
    subtitleRender: {
      webSubtitleView: !!window.AndroidSubtitleView,
      mountedSubId: (art && art.subtitle && art.subtitle.style && art.subtitle.style.display) || '',
      mpvSid: (function () { try { return window.AndroidMpv ? AndroidMpv.sid() : null; } catch (e) { return 'err'; } })(),
    },
  };
})()`;

(async () => {
  const { ws, evaluate } = await connect();
  const data = await evaluate(PROBE);
  ws.close();
  process.stdout.write(JSON.stringify(data, null, 2));
})().catch((error) => {
  console.error('探针失败：', error.message);
  process.exit(2);
});
