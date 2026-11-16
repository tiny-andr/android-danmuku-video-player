const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const calls = [];
const events = new Map();
const pageEvents = new Map();
const document = { visibilityState: 'visible', addEventListener(name, callback) { events.set(name, callback); }, documentElement: { clientWidth: 800, clientHeight: 800 } };
const cancellations = [];
let intersection;
const root = {
  AndroidThumbnails: {
    request(id, command, args) { calls.push({ id, command, args: JSON.parse(args) }); },
    cancel(id) { cancellations.push(id); },
  },
  IntersectionObserver: class {
    constructor(callback) { intersection = callback; }
    observe() {}
    unobserve() {}
  },
  addEventListener(name, callback) { pageEvents.set(name, callback); },
};
const context = vm.createContext({ window: root, document, setTimeout, clearTimeout, Promise, Map, Array, Number });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-thumbnails.js'), 'utf8'), context);
const view = root.AndroidThumbnailsView;
function image() {
  const classes = new Set();
  return { src: '', classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } },
    removeAttribute(name) { if (name === 'src') this.src = ''; }, classes };
}
function visible(element, enabled) { intersection([{ target: element, isIntersecting: enabled }]); }
function reply(call, result) { root.__aThumbnailReply(call.id, { ok: true, result }); }
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const first = image();
  const cleanup = view.observe(first, '/storage/emulated/0/Movies/one.mp4', { size: 100, modified_ms: 12 });
  assert.equal(calls.length, 0);
  visible(first, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.size, 100);
  assert.equal(calls[0].args.cacheOnly, true, 'Every visible image probes cache first');
  const staleId = calls[0].id;
  visible(first, false);
  assert.deepEqual(cancellations, [staleId]);
  root.__aThumbnailReply(staleId, { ok: true, result: { image: 'data:image/jpeg;base64,AA==' } });
  await tick();
  assert.equal(first.src, '');
  visible(first, true);
  reply(calls.at(-1), { image: 'data:image/jpeg;base64,AA==', status: 'cache' });
  await tick();
  assert.equal(first.src, 'data:image/jpeg;base64,AA==');
  assert(first.classes.has('thumbnail-ready'));
  cleanup();

  const recent = image();
  view.observe(recent, '/@network/12345678-1234-1234-1234-123456789abc/share/two.mkv', { cacheOnly: true });
  visible(recent, true);
  assert.equal(calls.at(-1).args.cacheOnly, true);
  assert.equal(calls.at(-1).args.size, undefined);
  const beforeMissing = calls.length;
  reply(calls.at(-1), { image: null, status: 'missing' });
  await tick();
  assert.equal(calls.length, beforeMissing, 'Recent cache misses never open remote videos');
  assert.equal(recent.src, '');

  const blocked = view.request('/storage/emulated/0/Movies/blocker.mp4');
  const blockedCall = calls.at(-1);
  const background = view.request('/storage/emulated/0/Movies/background.mp4');
  const cachedImage = image();
  view.observe(cachedImage, '/storage/emulated/0/Movies/cached.mp4');
  visible(cachedImage, true);
  assert.equal(calls.at(-1).args.cacheOnly, true);
  reply(calls.at(-1), { image: 'data:image/jpeg;base64,AQ==', status: 'cache' });
  await tick();
  assert.equal(cachedImage.src, 'data:image/jpeg;base64,AQ==', 'Cached images must paint while decode is blocked');
  assert.equal(view.stats.active, true);

  const visibleImage = image();
  const cleanupVisible = view.observe(visibleImage, '/storage/emulated/0/Movies/visible.mp4');
  visible(visibleImage, true);
  reply(calls.at(-1), { image: null, status: 'missing' });
  await tick();
  assert.equal(view.stats.queued, 2);
  reply(blockedCall, { image: null, status: 'unavailable' });
  await blocked.promise;
  assert(calls.at(-1).args.path.endsWith('/visible.mp4'));
  assert.equal(calls.at(-1).args.cacheOnly, false);
  cleanupVisible();
  assert(calls.at(-1).args.path.endsWith('/background.mp4'));
  background.cancel(); view.clear();

  const failedImage = image();
  view.observe(failedImage, '/storage/emulated/0/Movies/failed.mp4', { size: 10, modified_ms: 1 });
  visible(failedImage, true);
  reply(calls.at(-1), { image: null, status: 'missing' }); await tick();
  assert.equal(calls.at(-1).args.cacheOnly, false);
  reply(calls.at(-1), { image: null, status: 'timeout' }); await tick();
  visible(failedImage, false); visible(failedImage, true);
  const retryCount = calls.length;
  reply(calls.at(-1), { image: null, status: 'missing' }); await tick();
  assert.equal(calls.length, retryCount, 'Scrolling must not repeatedly decode failed files during cooldown');
  view.observe(failedImage, '/storage/emulated/0/Movies/failed.mp4', { size: 10, modified_ms: 2 });
  visible(failedImage, true); reply(calls.at(-1), { image: null, status: 'missing' }); await tick();
  assert.equal(calls.at(-1).args.cacheOnly, false, 'Changed metadata invalidates failure cooldown');
  view.clear();

  const hiddenImage = image();
  const cleanupHidden = view.observe(hiddenImage, '/storage/emulated/0/Movies/hidden.mp4');
  visible(hiddenImage, true);
  const hiddenCall = calls.at(-1);
  const hiddenWarmup = view.request('/storage/emulated/0/Movies/warmup.mp4');
  const beforeHidden = calls.length;
  document.visibilityState = 'hidden'; events.get('visibilitychange')();
  assert(cancellations.includes(hiddenCall.id));
  assert.equal((await hiddenWarmup.promise).status, 'cancelled');
  assert.equal(calls.length, beforeHidden);
  visible(hiddenImage, true); assert.equal(calls.length, beforeHidden);
  document.visibilityState = 'visible'; events.get('visibilitychange')(); visible(hiddenImage, true);
  assert.equal(calls.length, beforeHidden + 1);
  reply(hiddenCall, { image: 'data:image/jpeg;base64,AA==' }); await tick();
  assert.equal(hiddenImage.src, '');
  reply(calls.at(-1), { image: 'data:image/jpeg;base64,AQ==' }); await tick();
  assert.equal(hiddenImage.src, 'data:image/jpeg;base64,AQ=='); cleanupHidden();

  const cacheCalls = calls.length;
  const cacheRequests = Array.from({ length: 12 }, (_, index) => view.request('/storage/emulated/0/Movies/cache' + index + '.mp4', { cacheOnly: true }));
  assert.equal(calls.length - cacheCalls, 4);
  assert.equal(view.stats.cacheActive, 4);
  assert.equal(view.stats.cacheQueued, 8);
  cacheRequests.forEach(task => task.cancel()); await Promise.all(cacheRequests.map(task => task.promise));
  assert.equal(view.stats.cacheActive, 0); assert.equal(view.stats.cacheQueued, 0);
  const requests = Array.from({ length: 60 }, (_, index) => view.request('/storage/emulated/0/Movies/' + index + '.mp4'));
  requests.forEach(task => task.cancel());
  const results = await Promise.all(requests.map(task => task.promise));
  assert(results.some(result => result.status === 'busy'));
  view.clear();
  const stores=[];
  root.AndroidThumbnails.store=(id,args)=>stores.push({id,args:JSON.parse(args)});
  let brightness=0;
  const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([brightness,brightness,brightness,255])})}),toDataURL:()=> 'data:image/jpeg;base64,AQ=='};
  document.createElement=()=>canvas;
  const video={readyState:2,videoWidth:1920,videoHeight:1080};
  assert.equal(view.capture(video,'/storage/emulated/0/Movies/captured.mp4',{size:100}),null,'Black playback frames must not be cached');
  brightness=90;
  const capture=view.capture(video,'/storage/emulated/0/Movies/captured.mp4',{size:100,modified_ms:5});
  assert(capture);assert.equal(stores.length,1);assert.equal(canvas.width,320);assert.equal(canvas.height,180);
  assert.equal(stores[0].args.image,'data:image/jpeg;base64,AQ==');
  assert.equal(stores[0].args.modified_ms,5);
  root.__aThumbnailReply(stores[0].id,{ok:true,result:{status:'captured'}});
  assert.equal((await capture.promise).status,'captured');
  assert.equal(view.capture(video,'/storage/emulated/0/Movies/captured.mp4',null),null);
  canvas.getContext=()=>{throw new Error('Tainted canvas')};
  assert.equal(view.capture(video,'/storage/emulated/0/Movies/captured.mp4',{size:100}),null);
  console.log('Thumbnail frontend: cache fast lane, cache-only isolation, priority, failure cooldown, bounded lanes, visibility, stale replies and zero-read playback capture passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
