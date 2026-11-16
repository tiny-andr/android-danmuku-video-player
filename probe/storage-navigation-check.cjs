const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ordering = require('../bplayer-android/ui/android-file-order.js');

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.parentNode = null;
    this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = {}; this.hidden = false;
    this.className = ''; this.id = ''; this.scrollTop = 0; this.value = ''; this.disabled = false; this._text = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      toggle: (name, value) => { const enabled = value == null ? !this.classList.contains(name) : value; if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; },
    };
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...children); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatchEvent(event) { event.target = this; for (const handler of this.listeners[event.type] || []) handler.call(this, event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  matches(selector) {
    if (selector === '[data-path]') return this.dataset.path != null;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim()); const result = [];
    for (const child of this.children) { if (selectors.some(value => child.matches(value))) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    const list = this.document.getElementById('aFileList');
    if (this === list) return { top: 100, bottom: 340, height: 240, left: 0, right: 400, width: 400 };
    if (this.parentNode === list) {
      const index = list.children.indexOf(this); const grid = list.classList.contains('is-grid');
      const height = grid ? 160 : 60; const top = 100 + (grid ? Math.floor(index / 2) : index) * height - list.scrollTop;
      return { top, bottom: top + height, height, left: 0, right: 400, width: 400 };
    }
    return { top: 0, bottom: 20, height: 20, left: 0, right: 400, width: 400 };
  }
  scrollIntoView() {}
}

function environment() {
  const document = {
    createElement(tag) { return new Element(tag, document); },
    getElementById(id) { return [...document.head.querySelectorAll('#' + id), ...document.body.querySelectorAll('#' + id)][0] || null; },
  };
  document.head = new Element('head', document); document.body = new Element('body', document);
  const values = new Map(); const calls = []; const thumbnails = []; const callerLayers = ['info', 'subtitlePanel'];
  let offline = false; let deferred = null; let emptyDirectory = false; let invalidations = 0; let clears = 0;
  const sourceId = '11111111-1111-4111-8111-111111111111'; const root = '/@network/' + sourceId;
  const sources = Array.from({ length: 8 }, (_, index) => ({ id: index ? 'source-' + index : sourceId, name: 'NAS ' + index, host: 'nas-' + index, protocol: 'smb', share: 'Videos' }));
  function entries(dir) {
    return [{ name: 'Season', path: dir + '/Season', is_dir: true },
      ...Array.from({ length: 22 }, (_, index) => ({ name: 'Episode' + String(index).padStart(2, '0') + '.mp4', path: dir + '/Episode' + String(index).padStart(2, '0') + '.mp4', size: 100 + index, modified_ms: 1000 + index })),
      ...Array.from({ length: 12 }, (_, index) => { const name = 'Subtitle' + String(index).padStart(2, '0') + '.' + ['srt', 'ASS', 'ssa', 'VTT'][index % 4]; return { name, path: dir + '/' + name, size: 20 + index, modified_ms: 2000 + index }; }),
      ...Array.from({ length: 8 }, (_, index) => { const name = 'Comments' + String(index).padStart(2, '0') + '.' + ['xml', 'JSON'][index % 2]; return { name, path: dir + '/' + name, size: 30 + index, modified_ms: 3000 + index }; }),
      ...['readme.txt', 'sound.mp3', 'picture.jpg', 'video.mp4.bak'].map(name => ({ name, path: dir + '/' + name, size: 1 }))];
  }
  function listing(dir) { calls.push(dir); if (deferred) { const result = deferred; deferred = null; return result; } if (offline && dir.startsWith('/@network/')) return Promise.reject(new Error('Offline fixture')); return Promise.resolve({ dir, entries: emptyDirectory ? [] : entries(dir) }); }
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const window = {
    __TAURI__: { core: { invoke: (command, args) => { if (command === 'list_dir') return listing(args.dir); throw new Error('Unexpected local command ' + command); }, convertFileSrc: value => value } },
    AndroidFileOrder: ordering,
    AndroidNavigation: { invalidate() { invalidations++; }, clear() { clears++; callerLayers.length = 0; } },
    AndroidThumbnailsView: { observe(image, target) { thumbnails.push(target); return () => {}; } },
    AndroidNetwork: {
      request(id, command, raw) {
        const args = JSON.parse(raw);
        const result = command === 'network_sources' ? Promise.resolve(sources) : command === 'list_dir' ? listing(args.dir) : Promise.reject(new Error('Unexpected network command'));
        result.then(value => window.__aNetworkReply(id, { ok: true, result: value }), error => window.__aNetworkReply(id, { ok: false, error: error.message }));
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-storage.js'), 'utf8'), { window, document, localStorage, Map, Promise, setTimeout, clearTimeout, console });
  return { window, document, calls, root, sourceId, values, thumbnails, callerLayers,
    setOffline(value) { offline = value; }, setEmpty(value) { emptyDirectory = value; },
    defer(promise) { deferred = promise; }, get invalidations() { return invalidations; }, get clears() { return clears; } };
}
const settle = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve)); };
const serialize = value => JSON.parse(JSON.stringify(value));

(async () => {
  const env = environment(); const files = env.window.AndroidFiles; const get = id => env.document.getElementById(id);
  const rows = () => get('aFileList').querySelectorAll('.aRow');
  const anchor = () => { const list = get('aFileList'); const row = list.querySelectorAll('[data-path]').find(item => item.getBoundingClientRect().bottom > 101); return { path: row?.dataset.path, offset: row ? row.getBoundingClientRect().top - 100 : 0 }; };
  const assertPosition = position => { const row = get('aFileList').querySelectorAll('[data-path]').find(item => item.dataset.path === position.path); assert(row); assert.equal(row.getBoundingClientRect().top - 100, position.offset); };
  const report = [];
  let picker = files.open('file', null, '/sdcard/Download'); await settle();
  assert(files.active); assert.equal(env.invalidations, 1);
  get('aFileList').scrollTop = 310; let previousAnchor = anchor();
  get('aFileView').click(); assertPosition(previousAnchor);
  previousAnchor = anchor(); get('aFileDirection').click(); assertPosition(previousAnchor);
  previousAnchor = anchor(); get('aFileSort').value = 'modified'; get('aFileSort').dispatchEvent({ type: 'change' }); assertPosition(previousAnchor);
  const initialAnchor = anchor();
  report.push('sort and view changes preserve path/offset anchor');

  rows().find(row => row.dataset.path.endsWith('/Season')).click(); await settle();
  assert.equal(get('aFilePath').textContent, '手机存储/Download/Season');
  assert(files.back()); await settle(); assert.deepEqual(anchor(), initialAnchor);
  report.push('system Back and Up preserve parent directory position');

  const selectedPath = rows().find(row => row.dataset.path.endsWith('Episode12.mp4')).dataset.path;
  files.close(selectedPath); assert.equal(await picker, selectedPath);
  assert.equal(files.takeSelection('other'), null);
  const snapshot = files.takeSelection(selectedPath); assert(snapshot);
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.position)); assert.equal(files.takeSelection(selectedPath), null);
  assert.equal(snapshot.mode, 'file'); assert.equal(snapshot.requestedDir, '/sdcard/Download');
  assert(!JSON.stringify(snapshot).includes('password')); assert(!Object.hasOwn(snapshot, 'entries'));
  const copy = serialize(snapshot);
  picker = files.restore(snapshot); await settle(); assert.deepEqual(anchor(), initialAnchor); assert.equal(get('aFileSort').value, 'modified'); assert(get('aFileList').classList.contains('is-grid'));
  assert.deepEqual(serialize(snapshot), copy);
  files.close(null); assert.equal(await picker, null); assert.equal(files.takeSelection(selectedPath), null);
  report.push('immutable one-shot file snapshot and restore without entries or credentials');

  picker = files.open('dir', null, '/sdcard/Download'); await settle();
  assert(rows().filter(row => !row.querySelector('.aArrow')).every(row => row.disabled));
  get('aFileList').scrollTop = 230; get('aPickHere').click(); assert.equal(await picker, '/sdcard/Download');
  const folder = files.takeSelection('/sdcard/Download'); assert.equal(folder.mode, 'dir');
  picker = files.restore(folder); await settle(); assert.equal(get('aPickerTitle').textContent, '选择文件夹'); assert(!get('aPickHere').disabled); assert.deepEqual(anchor(), { path: folder.position.path, offset: folder.position.offset });
  files.close(null); await picker; report.push('folder selection snapshot restores dir mode and confirmation');

  picker = files.open('file', null, '/sdcard'); await settle(); get('aFileUp').click(); assert.equal(await picker, null); assert(!files.active);
  picker = files.open('file', 'network'); await settle();
  get('aFileList').scrollTop = 180; get('aFileList').dispatchEvent({ type: 'scroll' }); const sourceScroll = get('aFileList').scrollTop;
  get('aFileList').querySelectorAll('.aSource')[3].querySelector('.aEdit').click(); assert(!get('aSourceForm').hidden);
  files.back(); await settle(); assert.equal(get('aFileList').scrollTop, sourceScroll);
  get('aFileList').querySelector('.aSourceOpen').click(); await settle();
  get('aFileList').scrollTop = 200; rows()[0].click(); await settle();
  assert.equal(get('aFilePath').textContent, 'NAS 0/Season'); files.back(); await settle(); assert.equal(get('aFileList').scrollTop, 200);
  files.back(); await settle(); assert.equal(get('aFileList').scrollTop, sourceScroll);
  files.back(); assert.equal(await picker, null);
  report.push('source root returns to remembered sources list; sources and local root close picker');

  picker = files.open('file', null, '/sdcard/Download/Local'); await settle();
  get('aNetworkTab').click(); await settle(); get('aFileList').querySelector('.aSourceOpen').click(); await settle(); rows()[0].click(); await settle();
  get('aLocalTab').click(); await settle(); assert.equal(get('aFilePath').textContent, '手机存储/Download/Local');
  get('aNetworkTab').click(); await settle(); assert.equal(get('aFilePath').textContent, 'NAS 0/Season');
  get('aFileList').scrollTop = 230; const networkAnchor = anchor();
  const networkPath = rows().find(row => row.dataset.path.endsWith('Episode04.mp4')).dataset.path; files.close(networkPath); await picker; const networkSnapshot = files.takeSelection(networkPath);
  env.setOffline(true); picker = files.restore(networkSnapshot); await settle();
  assert.equal(get('aFilePath').textContent, 'NAS 0/Season'); assert.match(get('aFileList').textContent, /Offline fixture/); assert(!get('aFileHead').hidden);
  env.setOffline(false); get('aFileList').querySelector('button').click(); await settle(); assert.deepEqual(anchor(), networkAnchor);
  files.close(null); await picker;
  report.push('local/network positions independent; offline restore retains route and retry anchor');

  let complete; const delayed = new Promise(resolve => { complete = resolve; }); env.defer(delayed);
  picker = files.open('file', null, '/sdcard/Slow'); await settle(); get('aNetworkTab').click(); await settle();
  const currentPath = get('aFilePath').textContent; complete({ dir: '/sdcard/Slow', entries: [] }); await settle(); assert.equal(get('aFilePath').textContent, currentPath);
  files.close(null); await picker;
  picker = files.open('file', null, '/sdcard/Download'); await settle(); files.close(selectedPath); await picker;
  assert(files.takeSelection(selectedPath));
  picker = files.open('file', null, '/sdcard/Download'); await settle(); assert.equal(files.takeSelection(selectedPath), null); files.close(null); await picker;
  report.push('stale async responses and old selections cannot replace active route');

  picker = files.open('file', null, '/sdcard/Attachments'); await settle();
  assert.equal(rows().length, 23); assert(rows().filter(row => !row.querySelector('.aArrow')).every(row => /\.mp4$/i.test(row.dataset.path)));
  if (!get('aFileList').classList.contains('is-grid')) get('aFileView').click();
  get('aFileList').scrollTop = 490; const videoPosition = anchor();
  const videoPath = rows().find(row => !row.querySelector('.aArrow')).dataset.path;
  files.close(videoPath); await picker; const videoSnapshot = files.takeSelection(videoPath);
  assert(videoSnapshot.grid); const gridPreference = JSON.parse(env.values.get('bplayer.android.fileView')).grid;
  assert(gridPreference); const thumbnailCount = env.thumbnails.length;
  const savedLayers = env.callerLayers.slice();
  const attachmentSnapshots = {};
  for (const [attachmentMode, title, extensions, icon, count, scrollTop] of [
    ['subtitle', '选择字幕', /\.(srt|ass|ssa|vtt)$/i, '字', 13, 200],
    ['danmaku', '选择弹幕', /\.(xml|json)$/i, '弹', 9, 360],
  ]) {
    picker = files.open(attachmentMode, null, '/sdcard/Attachments'); await settle();
    assert.equal(get('aPickerTitle').textContent, title);
    assert.equal(rows().length, count); assert.equal(get('aFileView').hidden, true); assert.equal(get('aFileTools').hidden, false);
    assert.equal(get('aFileList').classList.contains('is-grid'), false); assert.equal(get('aFileBar').hidden, true);
    assert.equal(get('aFileList').scrollTop, 0, 'Attachment mode cannot reuse video or other attachment scroll');
    assert(rows().filter(row => !row.querySelector('.aArrow')).every(row => extensions.test(row.dataset.path) && !row.disabled && row.querySelector('.aFileIcon').textContent === icon));
    assert.equal(get('aFileList').querySelectorAll('img').length, 0); assert.equal(env.thumbnails.length, thumbnailCount);
    get('aFileView').click(); assert.equal(get('aFileList').classList.contains('is-grid'), false); assert.equal(env.thumbnails.length, thumbnailCount);
    rows().find(row => row.querySelector('.aArrow')).click(); await settle();
    assert.equal(get('aFilePath').textContent, '手机存储/Attachments/Season');
    files.back(); await settle(); assert.equal(get('aFilePath').textContent, '手机存储/Attachments');
    get('aFileList').scrollTop = scrollTop; const position = anchor();
    get('aFileDirection').click(); assertPosition(position);
    const target = rows().find(row => !row.querySelector('.aArrow')).dataset.path;
    rows().find(row => row.dataset.path === target).click(); assert.equal(await picker, target);
    const savedAttachment = files.takeSelection(target);
    assert.equal(savedAttachment.version, 1); assert.equal(savedAttachment.mode, attachmentMode); assert.equal(savedAttachment.grid, false);
    assert(Object.isFrozen(savedAttachment)); assert.equal(files.takeSelection(target), null);
    attachmentSnapshots[attachmentMode] = savedAttachment;
    assert.equal(JSON.parse(env.values.get('bplayer.android.fileView')).grid, gridPreference);
    assert.deepEqual(env.callerLayers, savedLayers); assert.equal(env.clears, 0);
  }
  report.push('all four modes filter supported files; attachments use list icons with zero thumbnail requests');

  for (const attachmentMode of ['subtitle', 'danmaku']) {
    const savedAttachment = attachmentSnapshots[attachmentMode];
    picker = files.restore(savedAttachment); await settle();
    assert.equal(get('aPickerTitle').textContent, attachmentMode === 'subtitle' ? '选择字幕' : '选择弹幕');
    assertPosition(savedAttachment.position); assert.equal(get('aFileList').classList.contains('is-grid'), false);
    assert.equal(get('aFileView').hidden, true); assert.equal(env.thumbnails.length, thumbnailCount);
    files.close(null); assert.equal(await picker, null); assert.equal(files.takeSelection(savedAttachment.selectedPath), null);
    assert.deepEqual(env.callerLayers, savedLayers);
  }
  picker = files.open('file', null, '/sdcard/Attachments'); await settle(); assertPosition(videoPosition); assert(get('aFileList').classList.contains('is-grid')); assert.equal(get('aFileView').hidden, false);
  files.close(null); await picker;
  picker = files.restore(videoSnapshot); await settle(); assertPosition(videoSnapshot.position); assert(get('aFileList').classList.contains('is-grid')); files.close(null); await picker;
  report.push('mode-prefixed anchors and version-1 snapshots preserve independent video/subtitle/danmaku positions');

  env.setEmpty(true);
  for (const attachmentMode of ['subtitle', 'danmaku']) {
    picker = files.open(attachmentMode, null, '/sdcard/Empty'); await settle();
    assert.match(get('aFileList').textContent, attachmentMode === 'subtitle' ? /字幕.*SRT/ : /弹幕.*XML/);
    assert.equal(get('aFileView').hidden, true); assert.equal(get('aFileTools').hidden, false);
    files.close(null); assert.equal(await picker, null);
  }
  env.setEmpty(false);
  picker = files.open('subtitle', null, env.root + '/Attachments'); await settle();
  assert.equal(rows().length, 13); const remoteSubtitle = rows().find(row => !row.querySelector('.aArrow')).dataset.path;
  rows().find(row => row.dataset.path === remoteSubtitle).click(); assert.equal(await picker, remoteSubtitle); assert.equal(files.takeSelection(remoteSubtitle).section, 'network');
  assert.deepEqual(env.callerLayers, savedLayers); assert.equal(env.clears, 0);
  report.push('attachment empty states, network filtering and cancellation leave caller overlay stack intact');
  console.log(JSON.stringify({ passed: true, groups: report.length, report }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
