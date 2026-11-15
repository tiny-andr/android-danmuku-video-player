const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../bplayer-android/ui/android-resume-store.js');
const KEY = 'bplayer.android.resume.v1';
const DAY = 24 * 60 * 60 * 1000;
let tests = 0;

function fixture(initial) {
  let clock = 100 * DAY;
  const values = new Map();
  if (initial !== undefined) values.set(KEY, initial);
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  };
  return {
    storage,
    store: api.create(storage, () => clock),
    tick(milliseconds = 1) { clock += milliseconds; },
    read() { return JSON.parse(values.get(KEY)); },
    raw() { return values.get(KEY); },
    now() { return clock; }
  };
}
function test(name, callback) {
  callback(); tests++;
}

test('browser and CommonJS exports', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-resume-store.js'), 'utf8'), context);
  assert.equal(typeof context.window.AndroidResumeStore.create, 'function');
  assert.equal(typeof api.create, 'function');
});

test('normalizes only local leading slashes and backslashes', () => {
  const context = fixture();
  context.store.save('\\\\sdcard\\Download\\电影 合集 + %20.mp4', 30, 100);
  assert.equal(context.store.get('/sdcard/Download/电影 合集 + %20.mp4').position, 30);
  context.store.save('/sdcard//Download/keep  spaces.mp4', 15, 100);
  assert.equal(context.store.get('/sdcard/Download/keep  spaces.mp4'), null);
  assert(context.store.get('/sdcard//Download/keep  spaces.mp4'));
});

test('preserves stable raw network paths', () => {
  const context = fixture();
  const video = '/@network/6a3c7ef1-52dc-48eb-8748-de47f1a99917/原始中文 空格%2F+片名.mkv';
  context.store.save(video, 46, 250);
  assert.deepEqual(context.store.get(video), { path: video, position: 46, duration: 250, updatedAt: context.now() });
  assert.equal(context.store.get(decodeURIComponent(video)), null);
});

test('updates overwrite, order and returned object isolation', () => {
  const context = fixture();
  context.store.save('/first.mp4', 10, 100); context.tick();
  context.store.save('/second.mp4', 20, 100); context.tick();
  context.store.save('/first.mp4', 40, 100);
  assert.equal(context.read().items.length, 2);
  assert.deepEqual(context.read().items.map(item => item.path), ['/first.mp4', '/second.mp4']);
  const item = context.store.get('/first.mp4'); item.position = 1;
  assert.equal(context.store.get('/first.mp4').position, 40);
  context.store.remove('///first.mp4'); assert.equal(context.store.get('/first.mp4'), null);
});

test('start and near-ending save remove previous records', () => {
  const context = fixture();
  for (const position of [0, 4.999, -5, 97, 100, 110]) {
    context.store.save('/video', 25, 100);
    context.store.save('/video', position, 100);
    assert.equal(context.store.get('/video'), null);
  }
  context.store.save('/video', 5, 100); assert.equal(context.store.get('/video').position, 5);
  context.store.save('/short', 17, 20); assert.equal(context.store.get('/short'), null);
  context.store.save('/long', 985, 1000); assert.equal(context.store.get('/long'), null);
  context.store.save('/long', 984.999, 1000); assert(context.store.get('/long'));
});

test('duration changes remove stale identities but boundary differences are accepted', () => {
  const context = fixture();
  context.store.save('/video', 25, 100);
  assert(context.store.get('/video', 105));
  assert.equal(context.store.get('/video', 105.001), null);
  assert.equal(context.store.get('/video'), null);
  context.store.save('/short', 5, 20);
  assert(context.store.get('/short', 23));
  assert.equal(context.store.get('/short', 23.001), null);
});

test('nonfinite and invalid durations never become records', () => {
  const context = fixture();
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '20']) {
    assert.doesNotThrow(() => context.store.save('/video', invalid, 100));
    assert.equal(context.store.get('/video'), null);
    context.store.save('/video', 20, invalid);
    assert.equal(context.store.get('/video'), null);
  }
  for (const duration of [0, -5]) { context.store.save('/video', 20, duration); assert.equal(context.store.get('/video'), null); }
  context.store.save('/valid', 20, 100);
  for (const duration of [NaN, Infinity, 0, -1, null]) assert.equal(context.store.get('/valid', duration), null);
  assert(context.store.get('/valid'));
});

test('malformed JSON and unknown versions are harmless and recover on save', () => {
  for (const raw of ['{oops', 'null', '[]', '{"version":2,"items":[]}', '{"version":1,"items":{}}']) {
    const context = fixture(raw);
    assert.equal(context.store.get('/video'), null);
    context.store.save('/video', 10, 100);
    assert.equal(context.read().version, 1);
    assert(context.store.get('/video'));
  }
});

test('rejects token URLs without serializing them', () => {
  const context = fixture();
  for (const video of ['http://127.0.0.1:3333/token/video', 'https://asset.localhost/video', 'ASSET:/sdcard/video', ' HTTPS://host/token']) {
    context.store.save(video, 10, 100);
    assert.equal(context.store.get(video), null);
    context.store.remove(video);
  }
  assert.equal(context.raw(), undefined);
});

test('keeps newest 100 records and refreshes on save', () => {
  const context = fixture();
  for (let index = 0; index < 105; index++) { context.store.save('/video' + index, 10, 100); context.tick(); }
  assert.equal(context.read().items.length, 100);
  assert.equal(context.store.get('/video0'), null);
  assert.equal(context.read().items[0].path, '/video104');
  context.store.save('/video5', 30, 100);
  assert.equal(context.read().items[0].path, '/video5');
});

test('expiry and corrupt persisted rows are cleaned', () => {
  const context = fixture();
  context.store.save('/old', 10, 100); context.tick(30 * DAY - 1);
  assert(context.store.get('/old')); context.tick();
  assert.equal(context.store.get('/old'), null); assert.equal(context.read().items.length, 0);
  context.storage.setItem(KEY, JSON.stringify({ version: 1, items: [
    { path: '/good', position: 20, duration: 100, updatedAt: context.now() },
    { path: '/good', position: 10, duration: 100, updatedAt: context.now() - 1 },
    { path: 'http://host/token', position: 20, duration: 100, updatedAt: context.now() },
    { path: '/bad', position: -1, duration: 100, updatedAt: context.now() },
    { path: '/bad', position: 20, duration: 100, updatedAt: context.now() + 1 },
    { path: '/bad', position: 20, duration: 100, updatedAt: 'yesterday' }, null
  ] }));
  assert.equal(context.store.get('/good').position, 20);
  assert.equal(context.read().items.length, 1);
});

test('storage throws and missing storage do not escape', () => {
  for (const storage of [undefined, null, {}, { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('quota'); } }]) {
    const store = api.create(storage);
    assert.equal(store.get('/video'), null);
    assert.doesNotThrow(() => store.save('/video', 10, 100));
    assert.doesNotThrow(() => store.remove('/video'));
  }
  const context = fixture(); context.store.save('/video', 10, 100);
  const store = api.create({ getItem: context.storage.getItem, setItem() { throw new Error('quota'); } }, () => context.now());
  assert.equal(store.get('/video').position, 10);
  assert.doesNotThrow(() => store.save('/video', 20, 100));
  assert.doesNotThrow(() => store.remove('/video'));
});

console.log(JSON.stringify({ passed: true, tests }));
