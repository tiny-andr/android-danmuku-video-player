const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/index.html'), 'utf8');
const start = html.indexOf("  var SETTINGS_KEY = 'bplayer_settings';");
const end = html.indexOf('  applyKeepScreenOn();', start);
assert(start >= 0 && end > start, 'Settings initialization must exist');
const source = html.slice(start, end + '  applyKeepScreenOn();'.length);

function initialize(saved, bridge = true) {
  const values = new Map(saved == null ? [] : [['bplayer_settings', saved]]);
  const calls = [];
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    window: bridge ? { AndroidUI: { setKeepScreenOn: enabled => calls.push(enabled) } } : {},
  });
  vm.runInContext(source, context);
  return { context, calls, values };
}

const fresh = initialize(null);
assert.equal(fresh.context.appSettings.keepScreenOn, true);
assert.deepEqual(fresh.calls, [true]);

const migrated = initialize(JSON.stringify({ ver: 3, autoAudio: false, autoSubtitle: true }));
assert.equal(migrated.context.appSettings.keepScreenOn, true);
assert.equal(migrated.context.appSettings.autoAudio, false);
assert.equal(migrated.context.appSettings.autoSubtitle, true);

const disabled = initialize(JSON.stringify({ ver: 3, autoAudio: false, autoSubtitle: true, keepScreenOn: false }));
assert.equal(disabled.context.appSettings.keepScreenOn, false);
assert.deepEqual(disabled.calls, [false]);
vm.runInContext('saveAppSettings()', disabled.context);
const persisted = JSON.parse(disabled.values.get('bplayer_settings'));
assert.deepEqual(persisted, { ver: 3, autoAudio: false, autoSubtitle: true, keepScreenOn: false });
assert.equal(initialize(JSON.stringify(persisted)).context.appSettings.keepScreenOn, false);

vm.runInContext('appSettings.keepScreenOn = true; saveAppSettings(); applyKeepScreenOn()', disabled.context);
assert.deepEqual(disabled.calls, [false, true]);
assert.equal(JSON.parse(disabled.values.get('bplayer_settings')).keepScreenOn, true);

assert.equal(initialize('{broken').context.appSettings.keepScreenOn, true);
assert.doesNotThrow(() => initialize(null, false));
console.log('Keep-screen-on settings: 6 groups passed');
