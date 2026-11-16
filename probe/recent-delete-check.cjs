const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-shell.js'), 'utf8');
const recentKey = source.match(/var RECENT_KEY = "([^"]+)"/)[1];
const ids = new Map();
let now = 10000;
let serial = 0;
const timers = new Map();
const writes = [];
const played = [];
const values = new Map();
const listeners = new Map();
function eventTarget(target) {
  target.listeners = new Map();
  target.addEventListener = (type, action) => {
    const actions = target.listeners.get(type) || [];
    actions.push(action); target.listeners.set(type, actions);
  };
  return target;
}
function fire(target, type, fields = {}) {
  const event = Object.assign({ target, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, fields);
  for (const action of target.listeners.get(type) || []) action(event);
  return event;
}
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentElement = null; this.dataset = {}; this.style = {}; this.hidden = false;
    this.scrollTop = 0; this.attributes = new Map(); this.classes = new Set(); this.isConnected = true;
    this.classList = { contains: name => this.classes.has(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name), toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); } };
    eventTarget(this);
  }
  set id(value) { this.identifier = value; ids.set(value, this); }
  get id() { return this.identifier; }
  set className(value) { this.classes = new Set(value.split(/\s+/)); }
  set textContent(value) { this.text = value; this.children.forEach(child => { child.isConnected = false; }); this.children = []; }
  get textContent() { return this.text || ''; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
    if (selector === '[data-path]') return descendants.filter(child => child.dataset.path);
    return [];
  }
  getBoundingClientRect() {
    if (this.id === 'mRecentList') return { top: 100, bottom: 300 };
    if (this.parentElement && this.parentElement.id === 'mRecentList') {
      const container = this.parentElement;
      const columns = container.classList.contains('is-grid') ? 2 : 1;
      const top = 100 + Math.floor(container.children.indexOf(this) / columns) * 60 - container.scrollTop;
      return { top, bottom: top + 60 };
    }
    return { top: 0, bottom: 0 };
  }
}
const document = eventTarget({ readyState: 'loading', createElement: tag => new Element(tag), getElementById: id => ids.get(id), querySelector: () => null });
document.head = new Element('head'); document.body = new Element('body'); document.documentElement = new Element('html');
const window = eventTarget({ AndroidPlayerTools: { back: () => false }, AndroidFiles: { back: () => false }, __BplayerDesktop: { loadVideo: selected => played.push(selected) } });
const context = vm.createContext({ window, document, localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => { values.set(key, value); writes.push(key); } }, Date: { now: () => now }, setTimeout: (action, delay) => { const id = ++serial; timers.set(id, { action, deadline: now + delay }); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 0, Math });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-navigation.js'), 'utf8'), context);
const expose = `window.__recentTest={setup:function(value){home=value;bindRecentList(document.getElementById('mRecentList'));},render:renderRecent,grid:function(value){recentGrid=value;renderRecent();},cancel:cancelRecentPress};`;
vm.runInContext(source.replace(/\}\)\(\);\s*$/, expose + '\n})();'), context);
const home = new Element('div'); home.id = 'mHome';
const box = new Element('div'); box.id = 'mRecentList'; home.appendChild(box);
const view = new Element('button'); view.id = 'mRecentView';
window.__recentTest.setup(home);
const navigation = window.AndroidNavigation;
const records = Array.from({ length: 8 }, (_, index) => ({ p: '/media/' + index + '.mp4', n: 'Movie ' + index, t: index }));
function seed() {
  navigation.clear(); window.__recentTest.cancel(false);
  if (box.children.length) fire(box.children[0], 'touchend');
  timers.clear(); now += 2000;
  values.set(recentKey, JSON.stringify(records)); values.set('resume-fixture', 'unchanged'); values.set('cover-fixture', 'unchanged');
  window.__recentTest.grid(false); box.scrollTop = 0; played.length = 0; writes.length = 0;
}
function advance(milliseconds) {
  now += milliseconds;
  for (const [id, timer] of [...timers]) if (timer.deadline <= now && timers.has(id)) { timers.delete(id); timer.action(); }
}
function touchStart(row, count = 1) { return fire(row, 'touchstart', { touches: Array.from({ length: count }, (_, index) => ({ identifier: index, clientX: 20, clientY: 20 })) }); }
function rowFor(selected) { return box.children.find(row => row.dataset.path === selected); }
function longPress(row) { touchStart(row); advance(550); assert.equal(navigation.top, 'recentActions'); }
let groups = 0;

seed();
let row = rowFor(records[2].p); touchStart(row); advance(200); fire(row, 'touchend'); fire(row, 'click');
assert.deepEqual(played, [records[2].p]); assert.equal(navigation.top, null); groups++;

seed(); row = rowFor(records[2].p); longPress(row);
assert.equal(JSON.parse(values.get(recentKey)).length, 8, 'Long press must only show confirmation');
assert.match(ids.get('mRecentActionNote').textContent, /不会删除视频、续播进度或封面/);
assert.equal(ids.get('mRecentActions').hidden, false);
fire(row, 'touchend'); fire(row, 'click'); assert.equal(played.length, 0);
fire(ids.get('mRecentDeleteCancel'), 'click'); assert.equal(navigation.top, null); assert.equal(JSON.parse(values.get(recentKey)).length, 8); groups++;

seed(); row = rowFor(records[3].p); longPress(row); window.__aAndroidBack(); advance(2000);
const release = fire(row, 'touchend'); assert.equal(release.defaultPrevented, true); fire(row, 'click');
assert.equal(played.length, 0, 'Long hold released after Back must not play'); assert.equal(navigation.top, null); groups++;

for (const cancel of ['move', 'scroll', 'multiple', 'cancel', 'blur', 'pagehide']) {
  seed(); row = rowFor(records[2].p); touchStart(row);
  if (cancel === 'move') fire(row, 'touchmove', { touches: [{ identifier: 0, clientX: 40, clientY: 20 }] });
  if (cancel === 'scroll') fire(box, 'scroll');
  if (cancel === 'multiple') fire(document, 'touchstart', { touches: [{}, {}] });
  if (cancel === 'cancel') fire(row, 'touchcancel');
  if (cancel === 'blur' || cancel === 'pagehide') fire(window, cancel);
  advance(600); assert.equal(navigation.top, null, cancel);
  fire(row, 'contextmenu'); assert.equal(navigation.top, null, cancel + ' immediate native contextmenu');
  advance(2000);
  fire(row, 'contextmenu'); assert.equal(navigation.top, cancel === 'cancel' ? 'recentActions' : null, cancel + ' late contextmenu');
  fire(row, 'touchend'); groups++;
}

seed(); row = rowFor(records[2].p);
const menu = fire(row, 'contextmenu'); assert(menu.defaultPrevented); assert.equal(navigation.top, 'recentActions');
fire(ids.get('mRecentActions'), 'click'); assert.equal(navigation.top, null); assert.equal(JSON.parse(values.get(recentKey)).length, 8); groups++;

for (const grid of [false, true]) {
  seed(); window.__recentTest.grid(grid); box.scrollTop = grid ? 60 : 120;
  const position = navigation.captureScroll(box);
  row = rowFor(records[5].p); fire(row, 'contextmenu');
  values.set(recentKey, JSON.stringify([...records].reverse()));
  fire(ids.get('mRecentDelete'), 'click');
  assert.equal(navigation.top, null); assert.equal(ids.get('mRecentActions').hidden, true);
  const remaining = JSON.parse(values.get(recentKey));
  assert.equal(remaining.length, 7); assert(!remaining.some(entry => entry.p === records[5].p), 'Delete uses stable path despite reorder');
  assert(remaining.some(entry => entry.p === records[2].p));
  const restored = rowFor(position.path).getBoundingClientRect().top - box.getBoundingClientRect().top;
  assert.equal(restored, position.offset, 'Surviving scroll anchor offset');
  assert.equal(values.get('resume-fixture'), 'unchanged'); assert.equal(values.get('cover-fixture'), 'unchanged');
  assert(writes.every(key => key === recentKey), 'Only history may be written'); groups++;
}

seed(); box.scrollTop = 120; row = rowFor(records[2].p); const next = rowFor(records[3].p);
const nextOffset = next.getBoundingClientRect().top - box.getBoundingClientRect().top;
fire(row, 'contextmenu'); fire(ids.get('mRecentDelete'), 'click');
assert.equal(rowFor(records[3].p).getBoundingClientRect().top - box.getBoundingClientRect().top, nextOffset, 'Deleted anchor falls back to surviving neighbor'); groups++;

seed(); row = rowFor(records[7].p); touchStart(row); window.__recentTest.render(); advance(600);
assert.equal(navigation.top, null, 'Rerender cancels detached row timer'); groups++;
console.log(`Recent deletion: ${groups} groups passed`);
