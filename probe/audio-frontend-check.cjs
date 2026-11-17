const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../bplayer-android/ui/android-audio.js');

function timers() {
  const waiting = new Map(); let serial = 0;
  return { waiting, setTimeout(action) { const id = ++serial; waiting.set(id, action); return id; }, clearTimeout(id) { waiting.delete(id); }, fire() { const entry = waiting.entries().next().value; assert(entry, 'timer missing'); waiting.delete(entry[0]); entry[1](); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function bridgeFixture() {
  const clock = timers(); const calls = []; let serial = 0;
  const environment = { crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++serial).padStart(12, '0') },
    AndroidAudioNative: { request(id, command, args) { calls.push({ id, command, args: JSON.parse(args) }); } } };
  const tasks = api.createTasks(environment, clock);
  function reply(call, result, error) { environment.__aAudioReply(call.id, error ? { ok: false, error } : { ok: true, result }); }
  function latest(command) { return calls.filter(call => call.command === command).at(-1); }
  return { tasks, environment, clock, calls, reply, latest };
}

class Emitter {
  constructor() { this.handlers = new Map(); }
  addEventListener(name, action) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(action); }
  removeEventListener(name, action) { this.handlers.get(name)?.delete(action); }
  emit(name) { for (const action of Array.from(this.handlers.get(name) || [])) action(); }
  get listenerCount() { return Array.from(this.handlers.values()).reduce((sum, values) => sum + values.size, 0); }
}
function trackFixture(videoOptions) {
  const clock = timers(); const audios = []; const video = Object.assign(new Emitter(), { paused: true, ended: false, seeking: false, readyState: 4, currentTime: 90, playbackRate: 1.5, volume: 0.6, muted: false }, videoOptions);
  class Audio extends Emitter {
    constructor() {
      super(); this.paused = true; this.readyState = 0; this.duration = 7200; this.position = 0; this.seeking = false; this.playCalls = 0; this.pauseCalls = 0; this.seekCalls = []; this.srcValue = ''; this.muted = false; this.pendingPlay = null;
      audios.push(this);
    }
    set src(value) { assert.equal(this.crossOrigin, 'anonymous', 'CORS must precede src'); assert.equal(this.muted, true, 'Candidate audio must initially be silent'); this.srcValue = value; }
    get src() { return this.srcValue; }
    set currentTime(value) { this.position = value; this.seeking = true; this.seekCalls.push(value); this.emit('seeking'); }
    get currentTime() { return this.position; }
    load() { this.loads = (this.loads || 0) + 1; }
    pause() { this.paused = true; this.pauseCalls++; }
    play() { this.playCalls++; this.paused = false; assert.equal(this.seeking, false, 'Must never play during an unfinished seek'); if (this.deferPlay) return new Promise((resolve, reject) => { this.pendingPlay = { resolve, reject }; }); return Promise.resolve(); }
    removeAttribute(name) { if (name === 'src') this.srcValue = ''; }
    metadata() { this.readyState = 4; this.emit('loadedmetadata'); }
    seeked() { this.seeking = false; this.emit('seeked'); }
  }
  const controller = api.createTrack({ video }, { Audio, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { controller, audios, video, clock };
}

(async () => {
  let groups = 0;
  {
    const test = bridgeFixture(); const request = test.tasks.request('audio_probe', { path: '/video.mkv', session: 'session' });
    assert.equal(test.tasks.state.pending, 1); test.reply(test.latest('audio_probe'), { tracks: [] }); assert.deepEqual(await request, { tracks: [] });
    test.reply(test.latest('audio_probe'), { stale: true }); assert.equal(test.tasks.state.pending, 0); assert.equal(test.clock.waiting.size, 0);
    const failed = test.tasks.request('audio_prepare', { session: 'session' }); test.reply(test.latest('audio_prepare'), null, 'read-only source'); await assert.rejects(failed, /read-only source/);
    const timed = test.tasks.request('audio_probe', { session: 'session' }); const timedCall = test.latest('audio_probe'); test.clock.fire(); await assert.rejects(timed, error => error.name === 'TimeoutError'); test.reply(timedCall, { stale: true });
    const cancelled = test.tasks.request('audio_prepare', { session: 'old' }); cancelled.cancel(); await assert.rejects(cancelled, error => error.name === 'AbortError');
    const old = test.tasks.request('audio_probe', { session: 'old' }); const fresh = test.tasks.request('audio_probe', { session: 'fresh' });
    test.tasks.cancelSession('old'); await assert.rejects(old, error => error.name === 'AbortError'); test.reply(test.latest('audio_probe'), { fresh: true }); assert.deepEqual(await fresh, { fresh: true });
    let events = 0; const remove = test.tasks.subscribe(() => events++); test.environment.__aAudioEvent('progress', { jobId: 'one' }); remove(); test.environment.__aAudioEvent('progress', { jobId: 'one' }); assert.equal(events, 1);
    const cleanup = test.tasks.request('audio_probe', { session: 'fresh' }); test.tasks.dispose(); await assert.rejects(cleanup, error => error.name === 'AbortError'); assert.equal(test.tasks.state.pending, 0); assert.equal(test.clock.waiting.size, 0); assert.equal(test.environment.__aAudioReply, undefined); groups++;
  }
  {
    const test = trackFixture(); const loading = test.controller.update({ url: 'https://audio.invalid/cache.mka', offset: 5 }); const audio = test.audios[0];
    assert.equal(audio.playCalls, 0); test.video.currentTime = 120; audio.metadata(); assert.deepEqual(audio.seekCalls, [115]); assert.equal(audio.playCalls, 0);
    audio.emit('canplay'); assert.equal(audio.playCalls, 0, 'Canplay must not bypass pending seek'); audio.seeked(); await loading; assert.equal(audio.playCalls, 0, 'Paused video must remain silent after mounting');
    assert.equal(audio.playbackRate, 1.5); assert.equal(audio.volume, 0.6); test.video.muted = true; test.video.emit('volumechange'); assert.equal(audio.muted, true);
    test.video.paused = false; test.video.emit('playing'); await tick(); assert.equal(audio.playCalls, 1); assert.equal(audio.currentTime, 115);
    test.video.paused = true; test.video.emit('pause'); assert.equal(audio.paused, true); test.controller.dispose(); assert.equal(audio.src, ''); assert.equal(audio.listenerCount, 0); assert.equal(test.video.listenerCount, 0); groups++;
  }
  {
    const test = trackFixture({ paused: false, currentTime: 50 }); const loading = test.controller.update({ url: 'cache.mka' }); const audio = test.audios[0];
    audio.metadata(); test.video.currentTime = 75; audio.seeked(); assert.deepEqual(audio.seekCalls, [50, 75]); assert.equal(audio.playCalls, 0, 'Latest video position must be reached before sound'); audio.seeked(); await loading; await tick(); assert.equal(audio.playCalls, 1);
    test.video.seeking = true; test.video.currentTime = 120; test.video.emit('seeking'); assert(audio.paused); test.video.seeking = false; test.video.emit('seeked'); assert.equal(audio.currentTime, 120); assert.equal(audio.playCalls, 1); audio.seeked(); await tick(); assert.equal(audio.playCalls, 2);
    test.video.emit('waiting'); assert(audio.paused); test.video.emit('timeupdate'); assert.equal(audio.playCalls, 2); test.video.emit('playing'); await tick(); assert.equal(audio.playCalls, 3);
    audio.emit('waiting'); test.video.emit('timeupdate'); assert(audio.paused); audio.emit('canplay'); await tick(); assert.equal(audio.playCalls, 4);
    test.controller.dispose(); groups++;
  }
  {
    const test = trackFixture({ paused: false, currentTime: 2 }); const loading = test.controller.update({ url: 'offset.mka', offset: 10 }); const audio = test.audios[0]; audio.metadata(); await loading; assert.equal(audio.playCalls, 0);
    test.video.currentTime = 12; test.video.emit('timeupdate'); assert.equal(audio.currentTime, 2); assert.equal(audio.playCalls, 0); audio.seeked(); await tick(); assert.equal(audio.playCalls, 1);
    test.video.currentTime = 1; test.video.emit('timeupdate'); assert(audio.paused); test.controller.dispose(); groups++;
  }
  {
    const test = trackFixture(); let owner = true; const first = test.controller.update({ url: 'old.mka', valid: () => owner }); const firstFailure = first.catch(error => error.name); const audio = test.audios[0]; const oldHandler = Array.from(audio.handlers.get('loadedmetadata'))[0];
    const second = test.controller.update({ url: 'new.mka' }); assert.equal(await firstFailure, 'AbortError'); assert.equal(audio.src, ''); assert.equal(audio.listenerCount, 0); oldHandler(); audio.metadata(); audio.seeked(); assert.equal(audio.playCalls, 0);
    const fresh = test.audios[1]; fresh.metadata(); fresh.seeked(); await second; assert.equal(test.controller.audio, fresh);
    owner = false; test.controller.reset(); fresh.emit('canplay'); assert.equal(fresh.playCalls, 0); assert.equal(test.controller.audio, null); test.controller.dispose(); groups++;
  }
  {
    const test = trackFixture({ paused: false }); const loading = test.controller.update({ url: 'deferred-play.mka' }); const audio = test.audios[0]; audio.deferPlay = true; audio.metadata(); audio.seeked(); await loading; assert.equal(audio.playCalls, 1); test.video.paused = true; test.video.emit('pause'); audio.pendingPlay.resolve(); await tick(); assert(audio.paused); test.controller.dispose(); groups++;
  }
  {
    const test = trackFixture(); const loading = test.controller.update({ url: 'broken.mka' }); const audio = test.audios[0]; audio.emit('error'); await assert.rejects(loading, /无法播放/); assert.equal(audio.src, ''); assert.equal(audio.listenerCount, 0);
    const timed = test.controller.update({ url: 'slow.mka' }); test.clock.fire(); await assert.rejects(timed, /超时/); assert.equal(test.controller.audio, null); test.controller.dispose(); groups++;
  }
  {
    assert(api.codec('A_PCM/BLURAY').needsConversion); // 白名单收紧后 PCM 也走转换（「拿不准的一律转，最差多转一次不会静音」），这里断言当前行为。assert(api.codec('A_PCM/PCM_S16LE').needsConversion); assert(api.codec('A_PCM/INT/LIT').needsConversion); assert(api.codec('A_DTS').needsConversion); assert(api.codec('pcm_bluray').needsConversion); assert(api.codec('A_TRUEHD').needsConversion); assert(!api.codec('A_AAC').needsConversion); groups++;
  }
  {
    const test = bridgeFixture(); const progress = []; const mounts = []; const failures = []; let autoEnabled = true; let resets = 0;
    const controller = api.createSession(test.tasks, { autoEnabled: () => autoEnabled, mount: selection => { mounts.push(selection); return Promise.resolve(); }, progress: payload => progress.push(payload), error: error => failures.push(error), resetTrack: () => resets++ });
    const oldOpen = controller.open('/same.mkv'); const oldProbe = test.latest('audio_probe'); const oldSession = oldProbe.args.session;
    const freshOpen = controller.open('/same.mkv'); const probe = test.latest('audio_probe'); assert.notEqual(probe.args.session, oldSession); assert.equal(test.tasks.currentSession, probe.args.session);
    test.reply(oldProbe, { tracks: [{ kind: 'audio', codec: 'A_DTS', default: true }] }); await oldOpen; assert.equal(test.calls.filter(call => call.command === 'audio_prepare').length, 0);
    test.reply(probe, { tracks: [{ kind: 'audio', codec: 'A_AAC', default: true }, { kind: 'audio', codec: 'A_DTS', default: false }] }); await freshOpen;
    assert.equal(test.calls.filter(call => call.command === 'audio_prepare').length, 0, 'Non-default unsupported track must not trigger automatic conversion');
    const first = controller.select(1, true); const preparedA = test.latest('audio_prepare'); const second = controller.select(0, true); const preparedB = test.latest('audio_prepare');
    test.reply(preparedA, { jobId: 'old-job', target: '/old.mka', cached: true, offset: 0 }); await first; assert.equal(mounts.length, 0);
    test.reply(preparedB, { jobId: 'new-job', target: '/new.mka', cached: false, offset: 0 }); await tick(); const start = test.latest('audio_start'); assert.equal(start.args.jobId, 'new-job');
    const base = { jobId: 'new-job', session: probe.args.session, video: '/same.mkv', audioIndex: 0 };
    for (const bad of [{ jobId: 'old-job' }, { session: oldSession }, { video: '/another.mkv' }, { audioIndex: 1 }]) test.environment.__aAudioEvent('progress', Object.assign({}, base, bad, { percent: 50 }));
    assert.equal(progress.length, 1, 'Only local initial progress should exist'); test.environment.__aAudioEvent('progress', Object.assign({}, base, { percent: 75 })); assert.equal(progress.length, 2);
    test.environment.__aAudioEvent('done', Object.assign({}, base, { path: '/new.mka', offset: 12 })); await tick(); assert.equal(mounts.length, 1); assert.equal(mounts[0].offset, 12); assert.equal(controller.state.phase, 'ready');
    test.reply(start, null, 'Late start acknowledgement failure'); await second; assert.equal(failures.length, 0, 'Late start reply cannot undo completed mount');
    controller.reset(); assert.equal(test.tasks.currentSession, null); assert.equal(controller.state, null); assert.equal(mounts[0].valid(), false); assert(resets > 0); controller.dispose(); test.tasks.dispose(); groups++;
  }
  {
    const test = bridgeFixture(); const mounts = []; const disabled = []; const failures = [];
    const controller = api.createSession(test.tasks, { autoEnabled: () => false, mount: selection => { mounts.push(selection); return Promise.resolve(); }, disabled: value => disabled.push(value), error: value => failures.push(value) });
    const opening = controller.open('/default.mkv'); test.reply(test.latest('audio_probe'), { tracks: [{ kind: 'audio', codec: 'A_DTS', default: true }] }); await tick(); const prepared = test.latest('audio_prepare');
    assert.equal(test.calls.filter(call=>call.command==='audio_cancel'&&!call.args.jobId).length,0,'Initial selection must not terminally cancel its whole session');
    test.reply(prepared, { jobId: 'cached', target: '/cached.mka', cached: true, offset: 2, legacy: true }); await opening; assert.equal(mounts.length, 1); assert.equal(mounts[0].legacy, true); assert.equal(test.calls.filter(call => call.command === 'audio_start').length, 0);
    const retry = controller.select(0, false); test.reply(test.latest('audio_prepare'), { jobId: 'uncached', target: '/new.mka', cached: false, offset: 0 }); await retry; assert.equal(disabled.length, 1); assert.equal(test.calls.filter(call => call.command === 'audio_start').length, 0);
    const manual = controller.select(0, true); test.reply(test.latest('audio_prepare'), { jobId: 'manual', target: '/new.mka', cached: false, offset: 0 }); await tick(); const start = test.latest('audio_start'); test.reply(start, { jobId: 'manual', target: '/new.mka' }); await manual;
    const state = controller.state; test.environment.__aAudioEvent('error', { jobId: 'manual', session: state.session, video: state.video, audioIndex: 0, message: 'Decoder AC4 unavailable' }); assert.match(failures[0], /AC4/); assert.equal(controller.state.phase, 'error');
    const cancelled = controller.select(0, true); const stalePrepare = test.latest('audio_prepare'); controller.cancel(); test.reply(stalePrepare, { jobId: 'late', target: '/late.mka', cached: true }); await cancelled; assert.equal(mounts.length, 1);
    controller.dispose(); test.tasks.dispose(); groups++;
  }
  {
    const test = bridgeFixture(); const controller = api.createSession(test.tasks, { autoEnabled: () => true, mount: () => Promise.resolve() });
    const opening = controller.open('/preferred.mp4'); test.reply(test.latest('audio_probe'), { tracks: [{ kind: 'audio', codec: 'A_AAC', default: false }, { kind: 'audio', codec: 'A_AAC', default: true }] }); await tick(); assert.equal(test.latest('audio_prepare').args.audioIndex, 1, 'Non-first default audio must be pinned, not silently choose first language');
    test.reply(test.latest('audio_prepare'), { jobId: 'preferred', target: '/preferred.mka', cached: true }); await opening; controller.dispose(); test.tasks.dispose(); groups++;
  }
  {
    const test=bridgeFixture();const failures=[];const controller=api.createSession(test.tasks,{autoEnabled:()=>true,mount:()=>Promise.resolve(),error:message=>failures.push(message)});
    const session=controller.begin('/retry.mkv');assert.equal(test.tasks.currentSession,session);assert.equal(test.calls.length,0);
    const probing=controller.probe();test.reply(test.latest('audio_probe'),{tracks:[{kind:'audio',codec:'A_AAC',default:true}]});await probing;
    const failed=controller.select(0,true);test.reply(test.latest('audio_prepare'),null,'Temporary share error');await failed;
    assert.equal(failures.length,1);assert.equal(test.calls.filter(call=>call.command==='audio_cancel').length,0,'Failed prepare without a job must allow same-session retry');
    const retry=controller.select(0,true);test.reply(test.latest('audio_prepare'),{jobId:'retry-job',target:'/retry.mka',cached:true});await retry;
    assert.equal(controller.state.phase,'ready');assert.equal(controller.state.session,session);
    controller.reset();assert(test.calls.some(call=>call.command==='audio_cancel'&&call.args.session===session&&call.args.jobId===null),'Only reset sends terminal whole-session cancellation');
    controller.dispose();test.tasks.dispose();groups++;
  }
  const html = fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/index.html'), 'utf8');
  assert(html.includes('<script src="android-audio.js"></script>')); assert(!html.includes('artplayerPluginAudioTrack({'));
  assert(html.includes('ensureAudioSession().begin(normPath(path));')); assert(!html.includes('switchToAudioCache(')); assert(!html.includes("invoke('transcode_target'"));
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if (script[1].trim()) new vm.Script(script[1]);
  console.log(`Audio frontend: ${groups} groups passed; bridge/session ownership, paused/seek barriers, native default selection, cache policy, timeout/cancellation and index syntax verified`);
})().catch(error => { console.error(error); process.exitCode = 1; });
