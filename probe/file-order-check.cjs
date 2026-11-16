const assert = require('node:assert/strict');
const order = require('../bplayer-android/ui/android-file-order.js');
const entries = [
  { name: '第10集.mp4', path: '/10', modified_ms: 100 },
  { name: '第2集.mp4', path: '/2', modified_ms: 300 },
  { name: '第1集.mkv', path: '/1', modified_ms: null },
  { name: '目录2', path: '/folder2', is_dir: true, modified_ms: 200 },
  { name: '目录10', path: '/folder10', is_dir: true, modified_ms: null },
];
const names = result => result.map(entry => entry.name);
assert.deepEqual(names(order.sort(entries, 'name', false)), ['目录2', '目录10', '第1集.mkv', '第2集.mp4', '第10集.mp4']);
assert.deepEqual(names(order.sort(entries, 'name', true)), ['目录10', '目录2', '第10集.mp4', '第2集.mp4', '第1集.mkv']);
assert.deepEqual(names(order.sort(entries, 'modified', true)), ['目录2', '目录10', '第2集.mp4', '第10集.mp4', '第1集.mkv']);
assert.deepEqual(names(order.sort(entries, 'modified', false)), ['目录2', '目录10', '第10集.mp4', '第2集.mp4', '第1集.mkv']);
assert.deepEqual(names(order.sort(entries, 'type', false)), ['目录2', '目录10', '第1集.mkv', '第2集.mp4', '第10集.mp4']);
assert.deepEqual(names(order.sort(entries, 'type', true)), ['目录10', '目录2', '第10集.mp4', '第2集.mp4', '第1集.mkv']);
assert.equal(order.timestamp({ modified_ms: 0 }), null);
assert.equal(order.timestamp({ modified_ms: NaN }), null);
assert.equal(entries[0].name, '第10集.mp4');
console.log('File sorting: 9 assertions passed');
