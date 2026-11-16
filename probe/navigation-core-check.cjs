const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-navigation.js'), 'utf8'), context);
const navigation = context.window.AndroidNavigation;
const visible = new Set();
let playlistCloses = 0;
for (const id of ['info', 'audio', 'subtitle', 'block', 'settings', 'playlist', 'danmaku']) {
  navigation.register(id, () => visible.add(id), () => visible.delete(id), id === 'playlist' ? () => playlistCloses++ : null);
}
let groups = 0;
for (const id of ['audio', 'subtitle', 'block', 'settings']) {
  navigation.open('info');
  navigation.forward(() => navigation.open(id));
  assert.deepEqual([...visible], [id]);
  assert.equal(navigation.top, id);
  assert.equal(navigation.close('info'), false);
  assert.equal(navigation.close(id), true);
  assert.deepEqual([...visible], ['info']);
  assert.equal(navigation.close(), true);
  assert.equal(navigation.top, null);
  groups++;
}
for (const id of ['audio', 'subtitle', 'settings', 'playlist', 'danmaku']) {
  navigation.open('info');
  navigation.open(id);
  assert.deepEqual([...visible], [id]);
  navigation.close();
  assert.equal(visible.size, 0);
  groups++;
}
assert.equal(playlistCloses, 1);
navigation.open('playlist'); navigation.clear();
assert.equal(playlistCloses, 1, 'Programmatic cleanup must not navigate to the playlist caller');
assert.equal(navigation.close(), false);
groups++;

let cancels = 0;
const cancelled = navigation.task(() => cancels++);
assert.equal(cancelled.valid(), true);
assert.equal(navigation.cancelPending(), true);
assert.equal(cancelled.valid(), false);
assert.equal(cancels, 1);
assert.equal(navigation.cancelPending(), false);
const replaced = navigation.task(() => cancels++);
navigation.open('settings');
assert.equal(replaced.valid(), false);
assert.equal(cancels, 1, 'Replacing navigation must not restore the abandoned caller over the new screen');
const old = navigation.task(() => cancels++);
const current = navigation.task(() => cancels++);
old.finish();
assert.equal(navigation.cancelPending(), true);
assert.equal(current.valid(), false);
assert.equal(cancels, 2);
const finished = navigation.task(() => cancels++);
finished.finish();
assert.equal(navigation.cancelPending(), false);
assert.equal(finished.valid(), true);
groups++;

const container = { scrollTop: 60, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => rows };
const rows = [
  { dataset: { path: 'first' }, getBoundingClientRect: () => ({ top: 40 - container.scrollTop, bottom: 90 - container.scrollTop }) },
  { dataset: { path: 'second' }, getBoundingClientRect: () => ({ top: 120 - container.scrollTop, bottom: 180 - container.scrollTop }) },
];
const position = navigation.captureScroll(container);
assert.equal(position.path, 'second');
container.scrollTop = 0;
navigation.restoreScroll(container, position);
assert.equal(container.scrollTop, 60);
rows.pop(); container.scrollTop = 0;
navigation.restoreScroll(container, position);
assert.equal(container.scrollTop, 60, 'Missing anchors fall back to numeric scroll');
groups++;
const html=fs.readFileSync(path.join(__dirname,'../bplayer-android/ui/index.html'),'utf8');
for(const [name,id] of [['refreshAudioMenu','audioPanel']]){
  navigation.register(id,()=>visible.add(id),()=>visible.delete(id));
  navigation.open('info');navigation.forward(()=>navigation.open(id));
  const button={hidden:false};
  context.$=()=>button;context.closePanel=panel=>navigation.close(panel);
  context.probeTracks=[];context.subItems=[];
  const start=html.indexOf('    function '+name+'()');
  const end=html.indexOf('      btn.hidden = false;',start);
  assert(start>=0&&end>start);
  vm.runInContext(html.slice(start,end)+'    }\n'+name+'();',context);
  assert.equal(button.hidden,true);assert.equal(navigation.top,'info');
  groups++;
}
navigation.register('subtitlePanel',()=>visible.add('subtitlePanel'),()=>visible.delete('subtitlePanel'));
navigation.open('info');navigation.forward(()=>navigation.open('subtitlePanel'));
const subtitleButton={hidden:true};context.$=()=>subtitleButton;
context.currentVideoPath='/storage/example.mp4';context.window.AndroidPlayback={active:true};
const subtitleStart=html.indexOf('    function refreshSubtitleMenu()');
const subtitleEnd=html.indexOf("      $('subtitleCount')",subtitleStart);
assert(subtitleStart>=0&&subtitleEnd>subtitleStart);
vm.runInContext(html.slice(subtitleStart,subtitleEnd)+'    }\nrefreshSubtitleMenu();',context);
assert.equal(subtitleButton.hidden,false);assert.equal(navigation.top,'subtitlePanel');
navigation.close('subtitlePanel');assert.equal(navigation.top,'info');groups++;
console.log(`Navigation core: ${groups} groups passed`);
