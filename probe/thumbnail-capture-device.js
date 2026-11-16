(async () => {
  const saved = Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('bplayer')).map(key => [key, localStorage.getItem(key)]));
  const path = '/storage/emulated/0/Download/test-hevc10-aac.mp4';
  const originalReply = window.__aThumbnailReply;
  const waiters = new Map();
  const until = condition => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error('Thumbnail capture test timeout')); }
    }, 100);
  });
  function check(condition, message) { if (!condition) throw new Error(message); }
  function store(args, index) {
    return new Promise((resolve, reject) => {
      const id = 'capture-validation-' + index;
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error('Store validation timeout')); }, 5000);
      waiters.set(id, result => { clearTimeout(timer); resolve(result); });
      AndroidThumbnails.store(id, JSON.stringify(args));
    });
  }
  try {
    check(!AndroidPlayback.active, 'Do not interrupt user playback');
    AndroidResumeStore.create(localStorage).remove(path);
    await __BplayerDesktop.loadVideo(path, null);
    await until(() => AndroidPlayback.active && !AndroidPlayback.loading && Bplayer.art.video.readyState >= 2);
    Bplayer.art.pause(); Bplayer.art.currentTime = 8;
    await until(() => !Bplayer.art.video.seeking);
    await new Promise(resolve => setTimeout(resolve, 150));
    const started = performance.now();
    const capture = AndroidThumbnailsView.capture(Bplayer.art.video, path, __BplayerDesktop.currentStat);
    check(capture, 'Playable video must permit canvas capture');
    const result = await capture.promise;
    const elapsedMs = Math.round(performance.now() - started);
    check(result.status === 'captured', 'Capture must persist');
    const cached = await AndroidThumbnailsView.request(path, Object.assign({}, __BplayerDesktop.currentStat, { cacheOnly: true })).promise;
    check(cached.status === 'cache' && cached.image, 'Capture must be readable without opening the video');
    window.__aThumbnailReply = (id, envelope) => {
      if (waiters.has(id)) { waiters.get(id)(envelope.result); waiters.delete(id); }
      else originalReply(id, envelope);
    };
    const canvas = document.createElement('canvas'); canvas.width = 321; canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 321, 2);
    const base = { path, size: 100, modified_ms: 0, image: 'data:image/jpeg;base64,AA==' };
    const cases = [base, Object.assign({}, base, { path: '/data/private.mp4' }), Object.assign({}, base, { size: 0 }),
      Object.assign({}, base, { modified_ms: -1 }), Object.assign({}, base, { image: canvas.toDataURL('image/jpeg') }),
      Object.assign({}, base, { image: canvas.toDataURL('image/png') })];
    for (let index = 0; index < cases.length; index++) {
      check((await store(cases[index], index)).status === 'invalid', 'Invalid capture accepted: ' + index);
    }
    return JSON.stringify({ passed: true, elapsedMs, status: result.status, cacheStatus: cached.status,
      extraVideoReadsForCapture: 0, invalidCapturesRejected: cases.length });
  } finally {
    window.__aThumbnailReply = originalReply;
    if (AndroidPlayback.active) AndroidPlayback.exit();
    AndroidFiles.close(); AndroidNavigation.clear(); AndroidUI.setPlaybackActive(false);
    Object.keys(localStorage).filter(key => key.startsWith('bplayer')).forEach(key => localStorage.removeItem(key));
    Object.entries(saved).forEach(([key, value]) => localStorage.setItem(key, value));
    setTimeout(() => location.reload(), 100);
  }
})()
