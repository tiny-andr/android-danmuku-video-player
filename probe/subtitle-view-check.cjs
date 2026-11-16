const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sidecars = require('../bplayer-android/ui/android-sidecars.js');

function fixture() {
  const nodes = []; const revoked = []; const timers = new Map(); const listeners = new Map(); let serial = 0;
  const container = { textContent: '' };
  Object.defineProperty(container, 'innerHTML', { set() { throw new Error('Subtitle must never render HTML'); } });
  const video = {
    currentTime: 2, paused: true,
    appendChild(node) { nodes.push(node); },
    addEventListener(name, action) { listeners.set(name, action); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const art = { video, template: { $subtitle: container }, subtitle: { style() {} } };
  const root = { AndroidSidecars: sidecars };
  const context = vm.createContext({ window: root, document: { createElement() {
    const handlers = new Map();
    return { track: { mode: 'disabled', cues: [] }, removed: false,
      addEventListener(name, action) { handlers.set(name, action); },
      remove() { this.removed = true; }, emit(name) { handlers.get(name)?.(); } };
  } }, URL: { createObjectURL() { return 'blob:' + ++serial; }, revokeObjectURL(url) { revoked.push(url); } },
  Blob, DOMException, setTimeout(action) { const id = ++serial; timers.set(id, action); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-subtitle-view.js'), 'utf8'), context);
  const view = root.AndroidSubtitleView.create(art);
  function ready(cues) { const node = nodes.at(-1); node.track.cues = cues; node.emit('load'); return node; }
  return { view, placement: root.AndroidSubtitleView.placement, nodes, revoked, timers, listeners, video, container, ready };
}

(async () => {
  const test = fixture(); const cue = { startTime: 1, endTime: 3, text: 'Safe &lt;words&gt; &amp;lt;' };
  for (const [width, height] of [[845, 919], [415, 931], [931, 415], [720, 1200], [1200, 720]]) {
    const options = { width, height, video: { x: 0, y: 0, width, height }, videoWidth: 1920, videoHeight: 820, fit: 'contain', textHeight: 26 };
    const boxHeight = Math.min(height, width * 820 / 1920);
    const frameBottom = (height + boxHeight) / 2;
    const inside = test.placement(options);
    assert(Math.abs(height - inside.bottom - (frameBottom - 12)) < 0.001);
    assert.equal(inside.position, 'inside');
    const below = test.placement({ ...options, position: 'below' });
    assert.equal(below.position, frameBottom + 34 <= height - 12 ? 'below' : 'inside');
    assert(height - below.bottom <= height - 12);
    const cover = test.placement({ ...options, fit: 'cover', position: 'below' });
    assert.equal(cover.position, 'inside'); assert.equal(cover.bottom, 12);
    const controls = test.placement({ ...options, controls: 130 });
    assert(controls.bottom >= 142);
    const portrait = test.placement({ ...options, videoWidth: 720, videoHeight: 1280 });
    assert(portrait.left >= 0 && portrait.left + portrait.width <= width + 0.001);
  }
  const shortFrame = test.placement({ width: 415, height: 931, video: { x: 0, y: 0, width: 415, height: 931 }, videoWidth: 1920, videoHeight: 200, fit: 'contain', textHeight: 75, position: 'below' });
  assert.equal(shortFrame.position, 'below'); assert.equal(shortFrame.maxHeight, 75);
  test.view.setPosition('below'); test.view.setPosition('inside');
  const first = test.view.load('WEBVTT', () => true);
  assert.equal(test.nodes[0].track.mode, 'hidden');
  const firstNode = test.ready([cue]);
  assert.equal(await first, 1);
  assert.equal(test.container.textContent, 'Safe <words> &lt;');
  assert.equal(firstNode.track.mode, 'disabled', 'Native captions must not duplicate custom text');
  assert.equal(test.view.count, 1);

  test.video.currentTime = 1.5;
  test.view.setOffset(1); assert.equal(test.container.textContent, '');
  test.view.setOffset(-1); assert.equal(test.container.textContent, 'Safe <words> &lt;');
  test.view.setOffset(-1); assert.equal(cue.startTime, 1); assert.equal(cue.endTime, 3);
  test.view.setOffset(99); assert.equal(test.view.offset, 10);
  test.view.setOffset(-99); assert.equal(test.view.offset, -10);
  test.view.setOffset(0); test.video.currentTime = 4; test.listeners.get('timeupdate')(); assert.equal(test.container.textContent, '');
  test.video.currentTime = 2; test.listeners.get('seeked')(); assert.equal(test.container.textContent, 'Safe <words> &lt;');

  const invalid = test.view.load('bad', () => true);
  const invalidNode = test.nodes.at(-1);
  invalidNode.emit('error');
  await assert.rejects(invalid, /字幕解析失败/);
  assert.equal(test.container.textContent, 'Safe <words> &lt;');
  assert.equal(firstNode.removed, false); assert.equal(invalidNode.removed, true);

  const empty = test.view.load('empty', () => true); test.ready([]);
  await assert.rejects(empty, /没有可显示/);
  assert.equal(firstNode.removed, false);

  let owner = true;
  const stale = test.view.load('stale', () => owner); owner = false; const staleNode = test.ready([{ startTime: 0, endTime: 9, text: 'Stale' }]);
  await assert.rejects(stale, error => error.name === 'AbortError');
  assert.equal(staleNode.removed, true); assert.equal(firstNode.removed, false);
  assert.equal(test.container.textContent, 'Safe <words> &lt;');

  const replaced = test.view.load('old pending', () => true);
  const replacedResult = replaced.catch(error => error.name);
  const replacedNode = test.nodes.at(-1);
  const current = test.view.load('new pending', () => true);
  assert.equal(await replacedResult, 'AbortError'); assert(replacedNode.removed);
  replacedNode.track.cues = [{ startTime: 0, endTime: 9, text: 'Late old result' }]; replacedNode.emit('load');
  assert.equal(firstNode.removed, false);
  test.ready([{ startTime: 1, endTime: 5, text: 'New' }]); await current;
  assert(firstNode.removed); assert.equal(test.container.textContent, 'New');

  const overlap = test.view.load('overlap', () => true);
  test.ready([{ startTime: 2, endTime: 3, text: 'Third' }, { startTime: 0, endTime: 10, text: 'First' }, { startTime: 1, endTime: 4, text: 'Second' }]);
  await overlap;
  assert.equal(test.container.textContent, 'First\nSecond\nThird');
  test.video.currentTime = 5; test.listeners.get('timeupdate')(); assert.equal(test.container.textContent, 'First');
  test.video.currentTime = 10; test.listeners.get('timeupdate')(); assert.equal(test.container.textContent, '');

  const timed = test.view.load('timeout', () => true);
  const timeout = Array.from(test.timers.values()).at(-1); timeout();
  await assert.rejects(timed, /超时/);
  assert.equal(test.view.count, 3);

  const cancelled = test.view.load('cancelled', () => true); const cancellation = cancelled.catch(error => error.name);
  test.view.clear(); assert.equal(await cancellation, 'AbortError');
  assert.equal(test.view.count, 0); assert.equal(test.container.textContent, '');
  assert(test.nodes.every(node => node.removed)); assert.equal(test.timers.size, 0);
  assert.equal(test.revoked.length, test.nodes.length);
  test.view.dispose(); assert.equal(test.listeners.size, 0);
  await assert.rejects(test.view.load('disposed', () => true), error => error.name === 'AbortError');
  console.log('Subtitle view: atomic load, ownership, safe text, delay, overlaps, timeout and resource cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
