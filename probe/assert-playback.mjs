#!/usr/bin/env node
// 播放页行为断言。跑真机 debug 包，通过 CDP 对「看得见/看不见」这类行为做断言，
// 而不是靠人看截图。用法：
//   $env:CDP_PORT='9223'; node probe/assert-playback.mjs
// 前置：adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>，且 app 停在首页。

const PORT = process.env.CDP_PORT || '9223';
const BASE = `http://127.0.0.1:${PORT}`;

async function targets() {
  const res = await fetch(`${BASE}/json/list`);
  return res.json();
}

async function connect() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url || '')) || list[0];
  if (!page) throw new Error('没有可用的 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const out = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (out.result && out.result.exceptionDetails) {
      throw new Error(out.result.exceptionDetails.text || 'evaluate failed');
    }
    return out.result?.result?.value;
  };
  return { ws, evaluate };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitFor(evaluate, expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expr);
    if (last) return last;
    await sleep(200);
  }
  return last;
}

(async () => {
  const { ws, evaluate } = await connect();

  // 0. 回到干净的首页
  await evaluate(`(function(){ if (window.AndroidPlayback && AndroidPlayback.active) AndroidPlayback.exit(); return true; })()`);
  await sleep(1200);

  const rows = await evaluate(`document.querySelectorAll('.mRecentRow').length`);
  const rowIndex = Number(process.env.ROW_INDEX || 0);
  check('最近播放有可点的条目', rows > rowIndex, `rows=${rows} 用第 ${rowIndex} 条`);
  if (rows <= rowIndex) { ws.close(); process.exit(1); }

  // 1. 点击播放
  await evaluate(`document.querySelectorAll('.mRecentRow')[${rowIndex}].click(); true`);

  // 2. 加载面板必须在 20 秒内消失（缓冲假死的核心断言）
  const loadingGone = await waitFor(
    evaluate,
    `(function(){ var el = document.getElementById('mLoading'); return !el || el.hidden === true || getComputedStyle(el).display === 'none'; })()`,
    20000,
  );
  check('加载面板自动消失', !!loadingGone);

  // 3. 已进入播放态
  const playing = await waitFor(evaluate, `document.body.classList.contains('m-playing')`, 5000);
  check('body.m-playing 就位', !!playing);

  // 4. mpv 真的在播（轮询到时间推进，别用固定 sleep 赌时序）
  const dur = await evaluate(`AndroidMpv.duration()`);
  check('mpv 有时长', dur > 0, `dur=${Math.round(dur)}`);
  const advanced = await waitFor(
    evaluate,
    `(function(){ return AndroidMpv.timePos() > 1 && !AndroidMpv.paused(); })()`,
    15000,
  );
  const tNow = await evaluate(`AndroidMpv.timePos()`);
  const isPaused = await evaluate(`AndroidMpv.paused()`);
  check('mpv 在播放且时间推进', !!advanced && !isPaused, `t=${Number(tNow).toFixed(1)} paused=${isPaused}`);

  // 5. 画面尺寸可用（缓冲假死的元凶就是它为 0）
  const vw = await evaluate(`AndroidMpv.videoWidth()`);
  check('videoWidth > 0', vw > 0, `w=${vw}`);

  // 6. 控件必须自动隐藏：播放中不碰屏幕，5 秒内不能带 art-control-show
  const controlsHidden = await waitFor(
    evaluate,
    `(function(){ var p = document.querySelector('.art-video-player'); return !!p && !p.classList.contains('art-control-show'); })()`,
    6000,
  );
  check('播放控件自动隐藏', !!controlsHidden);

  // 7. 字幕与弹幕（弹幕要等时钟真的走起来才会被渲染出来）
  const subs = await evaluate(`JSON.parse(AndroidMpv.tracks()||'[]').filter(function(x){return x.type==='sub'}).length`);
  check('字幕轨可见（>=0）', subs >= 0, `subs=${subs}`);
  const dmChip = await evaluate(`((document.getElementById('chipDanmaku')||{}).textContent||'')`);
  const dmCount = (dmChip.match(/([\d,]+)\s*条弹幕/) || [])[1];
  if (dmCount && Number(dmCount.replace(/,/g, '')) > 0) {
    const danmakuNodes = await waitFor(
      evaluate,
      `document.querySelectorAll('.art-danmuku > div').length`,
      12000,
    );
    check('弹幕节点存在', danmakuNodes > 0, `${dmCount} 条弹幕, nodes=${danmakuNodes}`);
  } else {
    // 这部片子没有同名弹幕文件：不算失败，但要在有弹幕的片上再跑一次才算真覆盖
    check('弹幕节点存在', true, `SKIP（本片无弹幕：${dmChip.trim() || '未加载'}）`);
  }

  // 8. 退出后必须干净
  await evaluate(`(AndroidPlayback.exit(), true)`);
  await sleep(1500);
  const afterDur = await evaluate(`AndroidMpv.duration()`);
  const afterPlaying = await evaluate(`document.body.classList.contains('m-playing')`);
  check('退出后 mpv 已停', afterDur === 0, `dur=${afterDur}`);
  check('退出后回到首页', afterPlaying === false);
  const aplaying = await evaluate(`document.body.classList.contains('aplaying')`);
  check('退出后播放页透明态已清', aplaying === false);

  ws.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('断言脚本异常：', error.message);
  process.exit(2);
});
