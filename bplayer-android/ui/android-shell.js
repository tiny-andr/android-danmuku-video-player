/* Android 壳：
 * 1. 桌面版把选文件/选目录交给 invoke('pick_video'|'pick_folder')，Android 没有 rfd；
 *    这里用 Rust 的 list_dir 渲染触摸友好的文件浏览器，返回真实路径（asset 协议只认真实路径）。
 * 2. 界面按手机横屏重排：启动页 = 选片 + 最近播放；播放页 = 视频铺满 + 顶部悬浮条。
 * 3. 状态栏/刘海用 env(safe-area-inset-*) 动态让位；播放时通过 AndroidUI 隐藏系统栏。
 */
(function () {
  "use strict";

  var RECENT_KEY = "bplayer.android.recent.v1";

  var home = null;
  var topbar = null;
  var infoPanel = null;
  var playing = false;
  var loading = false;
  var loadPanel = null;
  var loadTimer = null;
  var requestedPath = "";
  var expectedUrl = "";
  var failedLoad = false;
  var hookedArt = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* ------------------------------------------------------------------ *
   * 全局样式（手机布局 / 安全区 / 播放页 / 播放列表 / 提示层级）
   * ------------------------------------------------------------------ */
  function injectBaseCss() {
    var css =
      "html,body{-webkit-tap-highlight-color:transparent;}" +

      /* ---- 启动页 ---- */
      "#mHome{position:fixed;inset:0;z-index:99900;display:flex;flex-direction:column;" +
      "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) " +
      "env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);" +
      "background:radial-gradient(900px 460px at 84% -12%, rgba(123,92,255,.24), transparent 62%)," +
      "radial-gradient(720px 420px at -10% 34%, rgba(251,114,153,.15), transparent 64%)," +
      "linear-gradient(160deg,#0f1118 0%,#0a0c11 100%);}" +
      "#mHome.hide{display:none;}" +
      ".mBody{flex:1;display:flex;gap:24px;padding:14px 26px;min-height:0;}" +
      ".mLeft{flex:1.15;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:16px;}" +
      ".mBrand{display:flex;align-items:center;gap:14px;}" +
      ".mLogo{width:52px;height:52px;border-radius:15px;flex:none;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(135deg,#fb7299,#7b5cff);color:#fff;font-size:22px;" +
      "box-shadow:0 12px 30px -12px rgba(251,114,153,.65);}" +
      ".mBrand h1{margin:0;font-size:25px;letter-spacing:.5px;color:#f2f5ff;}" +
      ".mBrand p{margin:3px 0 0;font-size:12.5px;color:#8b95ab;}" +
      ".mHomeGear{margin-left:auto;flex:none;width:40px;height:40px;border-radius:50%;" +
      "border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#aab3c6;" +
      "font-size:17px;font-family:inherit;}" +
      ".mHomeGear:active{background:rgba(251,114,153,.22);color:#fff;}" +
      ".mActions{display:flex;gap:12px;}" +
      ".mBtn{flex:1;min-width:0;min-height:66px;display:flex;flex-direction:column;justify-content:center;gap:3px;" +
      "padding:12px 16px;border-radius:14px;border:1px solid transparent;font-family:inherit;text-align:left;" +
      "cursor:pointer;color:#fff;transition:transform .12s;}" +
      ".mBtn:active{transform:scale(.985);}" +
      ".mBtn b{font-size:16px;font-weight:600;}" +
      ".mBtn small{font-size:11.5px;opacity:.78;line-height:1.3;}" +
      ".mPrimary{background:linear-gradient(135deg,#fb7299,#8a63ff);box-shadow:0 12px 26px -12px rgba(251,114,153,.6);}" +
      ".mSecondary{background:rgba(255,255,255,.055);border-color:rgba(255,255,255,.13);}" +
      ".mHint{margin:0;font-size:11px;color:#6d778c;line-height:1.65;}" +
      ".mRight{flex:1;max-width:44%;min-width:0;display:flex;flex-direction:column;" +
      "background:rgba(22,26,36,.74);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:12px 12px 8px;}" +
      ".mRightHead{display:flex;align-items:center;gap:8px;padding:0 4px 8px;}" +
      ".mRightHead h2{margin:0;flex:1;font-size:12.5px;font-weight:500;color:#8b95ab;letter-spacing:.3px;}" +
      "#mClearRecent{background:none;border:0;color:#5f6a7f;font-size:11px;padding:6px;}" +
      "#mClearRecent:active{color:#fb7299;}" +
      ".mRecentList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:0;}" +
      ".mRecentRow{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;" +
      "background:rgba(255,255,255,.035);cursor:pointer;}" +
      ".mRecentRow:active{background:rgba(251,114,153,.13);}" +
      ".mRecentRow .ic{flex:none;width:32px;height:32px;border-radius:9px;background:#202a3d;" +
      "display:flex;align-items:center;justify-content:center;font-size:14px;}" +
      ".mRecentRow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font-size:12.5px;color:#dfe5f2;}" +
      ".mRecentRow .go{flex:none;font-size:11px;color:#7f8ba3;}" +
      ".mEmpty{color:#5f6a7f;font-size:11.5px;text-align:center;padding:22px 6px;line-height:1.7;}" +
      "@media (max-width:680px){.mRight{display:none;}.mBody{padding:12px 16px;}}" +
      /* 竖屏启动页：不再强制横屏，按钮在上、最近播放下 */
      "@media (orientation:portrait){#mHome .mBody{flex-direction:column;gap:14px;padding:10px 16px 12px;}" +
      "#mHome .mLeft{flex:none;justify-content:flex-start;gap:13px;}" +
      "#mHome .mRight{flex:0 1 auto;display:flex;max-width:none;max-height:44vh;min-height:120px;}" +
      "#mHome .mBrand h1{font-size:22px;}#mHome .mLogo{width:44px;height:44px;font-size:19px;}" +
      "#mHome .mBtn{min-height:58px;padding:10px 12px;}#mHome .mBtn b{font-size:15px;}}" +

      /* ---- 播放页顶部悬浮条 ---- */
      "#mTop{position:fixed;top:0;left:0;right:0;z-index:100000;display:flex;align-items:center;gap:10px;" +
      "padding:calc(env(safe-area-inset-top,0px) + 6px) calc(env(safe-area-inset-right,0px) + 12px) 10px " +
      "calc(env(safe-area-inset-left,0px) + 12px);" +
      "background:rgba(0,0,0,.94);border-bottom:1px solid #ffffff18;" +
      "opacity:0;transform:translateY(-10px);pointer-events:none;transition:opacity .2s,transform .2s;}" +
      "#mTop.show{opacity:1;transform:none;pointer-events:auto;}" +
      "#mTop .mIconBtn{flex:none;width:42px;height:42px;border-radius:50%;border:0;background:rgba(255,255,255,.12);" +
      "color:#fff;font-size:20px;line-height:42px;padding:0;font-family:inherit;}" +
      "#mTop .mIconBtn:active{background:rgba(255,255,255,.26);}" +
      "#mBack{font-size:27px;font-weight:300;line-height:38px;}" +
      "#mTop #mRotateBtn{width:auto;min-width:58px;padding:0 10px;border-radius:13px;font-size:12px;line-height:normal;}" +
      "#mInfoBtn{font-size:16px;font-family:Georgia,serif;font-style:italic;}" +
      ".mTitleBox{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}" +
      "#mTitle{font-size:14px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.85);}" +
      "#mDan{font-size:11px;color:#a9ecc4;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;text-shadow:0 1px 4px #000;}" +

      /* ---- 信息卡：替代桌面底部信息条，兼作音轨/字幕/屏蔽/设置入口 ---- */
      "#mInfo{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 12px);" +
      "z-index:100060;max-height:72vh;overflow:auto;display:flex;flex-direction:column;gap:11px;" +
      "background:rgba(18,21,29,.97);border:1px solid rgba(255,255,255,.12);border-radius:16px;" +
      "padding:13px 15px;color:#e8ecf5;box-shadow:0 24px 70px -24px rgba(0,0,0,.85);}" +
      "#mInfo[hidden]{display:none!important;}" +
      ".mi-head{display:flex;align-items:center;gap:10px;}" +
      ".mi-head b{flex:1;font-size:14px;}" +
      ".mi-close{flex:none;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.16);" +
      "background:none;color:#aab3c6;font-family:inherit;font-size:14px;}" +
      ".mi-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 16px;}" +
      ".mi-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;" +
      "border-bottom:1px solid rgba(255,255,255,.06);padding-bottom:5px;min-width:0;}" +
      ".mi-k{color:#8b95ab;flex:none;}" +
      ".mi-v{color:#e8ecf5;text-align:right;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;font-variant-numeric:tabular-nums;}" +
      ".mi-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}" +
      ".mi-actions button{min-height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.14);" +
      "background:rgba(255,255,255,.06);color:#dfe5f2;font-family:inherit;font-size:12px;padding:4px;}" +
      ".mi-actions button:active{background:rgba(251,114,153,.25);}" +
      ".mi-actions button:disabled{opacity:.32;}" +

      /* ---- 播放中：舞台铺满 ---- */
      "body.m-playing{overflow:hidden;}" +
      "body.m-playing .wrap{padding:0!important;height:100vh!important;}" +
      "body.m-playing .placeholder{display:none!important;}" +
      /* .stage 带着 rise 动画的 transform 填充帧（identity 也算 transform），
       * 会成为 fixed 后代的包含块，所以全屏必须落在 .stage 上并清掉 transform。 */
      "body.m-playing .stage{position:fixed!important;inset:0!important;width:100vw!important;" +
      "height:100vh!important;z-index:99990!important;border:0!important;border-radius:0!important;" +
      "box-shadow:none!important;transform:none!important;animation:none!important;}" +
      "body.m-playing #player{position:static!important;width:100%!important;height:100%!important;}" +
      "#player .art-video-player .art-bottom{background-image:linear-gradient(#000e,#000f)!important;background-size:100% var(--m-controls-height,76px)!important;background-repeat:no-repeat!important;overflow:visible!important;opacity:0!important;}" +
      "#player .art-video-player.art-control-show .art-bottom{opacity:1!important;}" +
      "#player .art-video-player .art-controls,#player .art-video-player .art-progress{transform:none!important;pointer-events:none!important;}" +
      "#player .art-video-player.art-control-show .art-controls,#player .art-video-player.art-control-show .art-progress{pointer-events:auto!important;}" +
      "#player .art-controls{height:auto!important;min-height:44px;flex-wrap:wrap;gap:0 4px;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 4px);}" +
      "#player .art-controls-left,#player .art-controls-right{height:44px!important;min-width:0;margin:0!important;}" +
      "#player .art-controls-right{margin-left:auto!important;gap:0;}#player .art-controls-center{display:none!important;}" +
      "#player .art-controls .art-control{min-width:40px!important;min-height:44px!important;}#player .art-control-time{min-width:0!important;font-size:11px!important;padding:0 4px!important;}" +
      "#player .mDanControls{display:flex;align-items:center;flex:none;height:44px;}" +
      "#player .mDanControls .artplayer-plugin-danmuku{width:auto!important;height:44px!important;gap:0!important;}" +
      "#player .mDanControls .apd-emitter{display:none!important;}" +
      "#player .mDanControls>.artplayer-plugin-danmuku>.apd-toggle>.apd-icon,#player .mDanControls>.artplayer-plugin-danmuku>.apd-config>.apd-icon{fill:#f2f4ff!important;opacity:1!important;}" +
      "#player .mDanControls .apd-toggle,#player .mDanControls .apd-config{min-width:44px;height:44px;display:flex;align-items:center;justify-content:center;}" +
      "#player .mDanControls .apd-config-panel{position:fixed!important;left:12px!important;right:12px!important;bottom:calc(var(--m-controls-height,76px) + 8px)!important;width:auto!important;max-width:480px;margin:0 auto;padding:0!important;max-height:calc(100vh - var(--m-controls-height,76px) - 88px);overflow:auto;opacity:0!important;pointer-events:none!important;z-index:100080;}" +
      "#player .mDanControls.is-config-open .apd-config-panel{opacity:1!important;pointer-events:auto!important;}" +
      "#player .mDanControls .apd-config-panel-inner{background:#090b11fa!important;border:1px solid #ffffff30;border-radius:15px;padding:16px!important;font-size:13px;}" +
      "#player .mDanControls .apd-value{font-size:12px;}" +

      /* ---- 播放列表 / 设置升级为手机尺寸 ---- */
      "#playlist{z-index:100100!important;width:min(340px,74vw)!important;" +
      "padding-bottom:env(safe-area-inset-bottom,0px)!important;}" +
      /* 桌面版 .playlist 是 .wrap 直接子元素，会吃到 rise 动画的 transform:none
       * 填充帧，抽屉因此永远展开；用 !important 压回滑出状态。 */
      ".playlist:not(.open){transform:translateX(110%)!important;}" +
      ".playlist.open{transform:none!important;}" +
      ".pl-head{padding-top:calc(14px + env(safe-area-inset-top,0px))!important;min-height:54px;}" +
      ".pl-head button{width:36px!important;height:36px!important;font-size:15px;}" +
      ".pl-item{min-height:44px;font-size:13px!important;}" +
      ".settings-modal{max-height:calc(100vh - 24px);}" +
      /* 桌面浮窗在手机上统一改成底部面板，并压到播放页之上 */
      ".block-panel{z-index:100050!important;left:12px!important;right:12px!important;" +
      "bottom:calc(env(safe-area-inset-bottom,0px) + 12px)!important;width:auto!important;" +
      "max-width:none!important;max-height:72vh;overflow:auto;}" +
      ".settings-mask{z-index:100070!important;padding:env(safe-area-inset-top,0px) 8px env(safe-area-inset-bottom,0px);}" +
      ".settings-modal{width:100%!important;max-width:none!important;" +
      "max-height:calc(100vh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px) - 16px)!important;padding:16px!important;}" +

      /* ---- 提示要压在启动页/播放页之上 ---- */
      ".toast{z-index:200010!important;}" +
      ".pill{z-index:100001!important;}";
    var style = document.createElement("style");
    style.id = "aBaseStyle";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  injectBaseCss();

  /* ------------------------------------------------------------------ *
   * 文件浏览器
   * ------------------------------------------------------------------ */
  function showStorageError(error) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    var text = document.getElementById("toastText");
    if (text) text.textContent = "读取失败：" + (error.message || String(error));
    toast.classList.add("show");
    setTimeout(function () { toast.classList.remove("show"); }, 6000);
  }

  function openBrowser(m) {
    return window.AndroidFiles.open(m);
  }

  /* ------------------------------------------------------------------ *
   * 最近播放
   * ------------------------------------------------------------------ */
  function normPath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "/");
  }

  function readRecent() {
    try {
      var a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (!Array.isArray(a)) return [];
      var seen = {};
      return a.filter(function (x) {
        if (!x || !x.p) return false;
        x.p = normPath(x.p);
        if (seen[x.p]) return false;
        seen[x.p] = 1;
        return true;
      });
    } catch (e) { return []; }
  }

  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) {}
  }

  function rememberVideo(path, name) {
    path = normPath(path);
    if (!path) return;
    var list = readRecent().filter(function (x) { return x.p !== path; });
    list.unshift({ p: path, n: name || path.split("/").pop() || "", t: Date.now() });
    writeRecent(list);
    renderRecent();
  }

  function renderRecent() {
    if (!home) return;
    var box = document.getElementById("mRecentList");
    if (!box) return;
    box.textContent = "";
    var list = readRecent();
    writeRecent(list); // 顺手把历史上重复/多斜杠的路径清一遍
    if (!list.length) {
      var empty = el("div", "mEmpty", "还没有播放记录\n选一部片子开始吧");
      empty.style.whiteSpace = "pre-line";
      box.appendChild(empty);
      return;
    }
    list.slice(0, 5).forEach(function (item) {
      var row = el("div", "mRecentRow");
      row.appendChild(el("span", "ic", "🎞"));
      row.appendChild(el("span", "nm", item.n || item.p));
      row.appendChild(el("span", "go", "继续"));
      row.title = item.p;
      row.addEventListener("click", function () {
        if (!window.__BplayerDesktop) return;
        window.__BplayerDesktop.loadVideo(item.p, null);
      });
      box.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动页
   * ------------------------------------------------------------------ */
  function buildHome() {
    if (home) return;
    home = el("div");
    home.id = "mHome";
    home.innerHTML =
      '<div class="mBody">' +
        '<div class="mLeft">' +
          '<div class="mBrand"><div class="mLogo">▶</div>' +
            '<div><h1>Bplayer</h1><p>本地视频 · 弹幕播放器</p></div>' +
            '<button type="button" class="mHomeGear" id="mHomeSettings" title="设置">⚙</button></div>' +
          '<div class="mActions">' +
            '<button type="button" id="mOpenVideo" class="mBtn mPrimary">' +
              '<b>选择视频</b><small>单个文件 · 自动配对同名弹幕</small></button>' +
            '<button type="button" id="mOpenFolder" class="mBtn mSecondary">' +
              '<b>选择文件夹</b><small>整季连播 · 自动生成剧集列表</small></button>' +
          '</div>' +
          '<button type="button" id="mOpenNetwork" class="mBtn mSecondary">' +
            '<b>网络存储</b><small>SMB / WebDAV / SFTP · 连接 NAS 与服务器</small></button>' +
          '<p class="mHint">本地与网络视频 · 同名弹幕与外挂字幕自动加载</p>' +
        '</div>' +
        '<div class="mRight">' +
          '<div class="mRightHead"><h2>最近播放</h2>' +
            '<button type="button" id="mClearRecent">清空</button></div>' +
          '<div class="mRecentList" id="mRecentList"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(home);

    function openVideo() {
      var btn = document.getElementById("btnOpenVideo");
      if (btn) btn.click();
    }
    function openFolder() {
      var btn = document.getElementById("btnOpenFolder");
      if (btn) btn.click();
    }
    document.getElementById("mOpenVideo").addEventListener("click", openVideo);
    document.getElementById("mOpenFolder").addEventListener("click", openFolder);
    var networkButton = document.getElementById("mOpenNetwork");
    networkButton.style.flex = "none";
    networkButton.addEventListener("click", function () {
      window.AndroidFiles.open("file", "network").then(function (path) {
        if (path && window.__BplayerDesktop) return window.__BplayerDesktop.loadVideo(path, null);
      }).catch(showStorageError);
    });
    document.getElementById("mHomeSettings").addEventListener("click", function () {
      var b = document.getElementById("btnSettings");
      if (b) b.click();
    });
    document.getElementById("mClearRecent").addEventListener("click", function () {
      writeRecent([]);
      renderRecent();
    });
    renderRecent();
  }

  /* ------------------------------------------------------------------ *
   * 播放页顶部悬浮条
   * ------------------------------------------------------------------ */
  function buildTopbar() {
    if (topbar) return;
    topbar = el("div");
    topbar.id = "mTop";
    topbar.innerHTML =
      '<button type="button" class="mIconBtn" id="mBack" title="返回">‹</button>' +
      '<div class="mTitleBox"><div id="mTitle">—</div><div id="mDan"></div></div>' +
      '<button type="button" class="mIconBtn" id="mRotateBtn" title="切换为横屏" aria-label="切换为横屏">横屏</button>' +
      '<button type="button" class="mIconBtn" id="mInfoBtn" title="视频信息与功能">i</button>' +
      '<button type="button" class="mIconBtn" id="mPlBtn" title="播放列表">≡</button>';
    document.body.appendChild(topbar);
    buildInfoPanel();

    document.getElementById("mBack").addEventListener("click", exitPlaying);
    document.getElementById("mInfoBtn").addEventListener("click", function () {
      if (!infoPanel) return;
      var opening = infoPanel.hidden;
      openInfo(opening);
    });
    document.getElementById("mPlBtn").addEventListener("click", function () {
      var pl = document.getElementById("playlist");
      if (pl) pl.classList.add("open");
    });
    document.getElementById("mRotateBtn").addEventListener("click", function () {
      if (!playing) return;
      closeDanmakuSettings();
      var direction = innerWidth > innerHeight ? "portrait" : "landscape";
      try { if (window.AndroidUI && window.AndroidUI.setPlaybackOrientation) window.AndroidUI.setPlaybackOrientation(direction); } catch (error) {}
      var art = window.Bplayer && window.Bplayer.art;
      if (art) art.controls.show = true;
    });
  }

  function buildInfoPanel() {
    if (infoPanel) return;
    infoPanel = el("div");
    infoPanel.id = "mInfo";
    infoPanel.hidden = true;
    infoPanel.innerHTML =
      '<div class="mi-head"><b>视频信息</b>' +
        '<button type="button" class="mi-close" id="mInfoClose" title="关闭">✕</button></div>' +
      '<div class="mi-grid">' +
        '<div class="mi-row"><span class="mi-k">时长</span><span class="mi-v" id="miDuration">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">分辨率</span><span class="mi-v" id="miRes">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">视频大小</span><span class="mi-v" id="miSize">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">弹幕数量</span><span class="mi-v" id="miCount">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">弹幕解析</span><span class="mi-v" id="miParse">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">当前进度</span><span class="mi-v" id="miTime">—</span></div>' +
      '</div>' +
      '<div class="mi-actions">' +
        '<button type="button" id="mActAudio">音轨</button>' +
        '<button type="button" id="mActSub">字幕</button>' +
        '<button type="button" id="mActBlock">弹幕屏蔽</button>' +
        '<button type="button" id="mActSettings">设置</button>' +
      '</div>';
    document.body.appendChild(infoPanel);

    document.getElementById("mInfoClose").addEventListener("click", function () {
      infoPanel.hidden = true;
    });
    function forward(btnId) {
      infoPanel.hidden = true;
      var b = document.getElementById(btnId);
      if (b && !b.hidden) b.click();
    }
    document.getElementById("mActAudio").addEventListener("click", function () {
      forward("btnAudioEntry");
    });
    document.getElementById("mActSub").addEventListener("click", function () {
      forward("btnSubtitleEntry");
    });
    document.getElementById("mActBlock").addEventListener("click", function () {
      forward("btnBlockEntry");
    });
    document.getElementById("mActSettings").addEventListener("click", function () {
      infoPanel.hidden = true;
      var b = document.getElementById("btnSettings");
      if (b) b.click();
    });
  }

  function fillInfo() {
    if (!infoPanel) return;
    function copy(from, to) {
      var s = document.getElementById(from);
      var d = document.getElementById(to);
      if (d) d.textContent = s && s.textContent.trim() ? s.textContent.trim() : "—";
    }
    copy("infoDuration", "miDuration");
    copy("infoRes", "miRes");
    copy("infoSize", "miSize");
    copy("infoCount", "miCount");
    copy("infoParse", "miParse");
    copy("infoTime", "miTime");
    var ab = document.getElementById("btnAudioEntry");
    var sb = document.getElementById("btnSubtitleEntry");
    var ba = document.getElementById("mActAudio");
    var bs = document.getElementById("mActSub");
    if (ba) ba.disabled = !ab || ab.hidden;
    if (bs) bs.disabled = !sb || sb.hidden;
  }

  function openInfo(on) {
    if (!infoPanel) return;
    if (on) {
      ["audioPanel", "subtitlePanel", "densityPanel", "blockPanel"].forEach(function (id) {
        var p = document.getElementById(id);
        if (p) p.hidden = true;
      });
      var pl = document.getElementById("playlist");
      if (pl) pl.classList.remove("open");
      fillInfo();
    }
    infoPanel.hidden = !on;
  }

  function setImmersive(on) {
    try {
      if (window.AndroidUI && window.AndroidUI.setImmersive) {
        window.AndroidUI.setImmersive(!!on);
      }
    } catch (e) {}
  }

  function ensureLoadPanel() {
    if (loadPanel) return;
    var style = el("style");
    style.textContent = "#mLoading{position:fixed;inset:0;z-index:200005;background:#090c12;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:calc(env(safe-area-inset-top,0px) + 24px) calc(env(safe-area-inset-right,0px) + 24px) calc(env(safe-area-inset-bottom,0px) + 24px) calc(env(safe-area-inset-left,0px) + 24px);color:#dce3f5;font:14px system-ui,sans-serif;text-align:center}#mLoading[hidden]{display:none!important}#mLoadingName{font-size:17px;font-weight:600;max-width:min(100%,640px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#mLoadingMessage{max-width:560px;line-height:1.7;white-space:pre-line;overflow-wrap:anywhere;color:#9ca9c2}#mLoading.failed #mLoadingMessage{color:#ff9fb4}#mLoadingSpinner{width:32px;height:32px;border:3px solid #b28bff30;border-top-color:#b28bff;border-radius:50%;animation:mLoadingSpin .8s linear infinite}#mLoading.failed #mLoadingSpinner{display:none}#mLoadingActions{display:flex;gap:12px}#mLoadingActions button{min-height:44px;padding:10px 22px;border-radius:12px;border:1px solid #ffffff25;background:#ffffff0a;color:#eee;font:inherit}#mLoadingRetry{background:#8b68ef44!important}@keyframes mLoadingSpin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
    loadPanel = el("div"); loadPanel.id = "mLoading"; loadPanel.hidden = true;
    loadPanel.setAttribute("role", "status");
    loadPanel.innerHTML = '<div id="mLoadingSpinner"></div><div id="mLoadingName"></div><div id="mLoadingMessage"></div><div id="mLoadingActions"><button type="button" id="mLoadingCancel">返回文件列表</button><button type="button" id="mLoadingRetry" hidden>重试</button></div>';
    document.body.appendChild(loadPanel);
    document.getElementById("mLoadingCancel").addEventListener("click", cancelLoading);
    document.getElementById("mLoadingRetry").addEventListener("click", function () {
      if (requestedPath && window.__BplayerDesktop) window.__BplayerDesktop.loadVideo(requestedPath, null);
    });
  }

  function beginLoading(path, name) {
    ensureLoadPanel(); clearTimeout(loadTimer);
    requestedPath = path; expectedUrl = ""; loading = true; failedLoad = false; playing = false;
    closeDanmakuSettings(); setVideoOrientation(0, 0);
    releaseVideo();
    document.body.classList.add("m-playing");
    if (home) home.classList.add("hide");
    if (topbar) topbar.classList.remove("show");
    openInfo(false);
    var playlist = document.getElementById("playlist");
    if (playlist) playlist.classList.remove("open");
    loadPanel.classList.remove("failed"); loadPanel.hidden = false;
    loadPanel.setAttribute("role", "status");
    document.getElementById("mLoadingName").textContent = name;
    document.getElementById("mLoadingMessage").textContent = "正在打开视频…";
    document.getElementById("mLoadingRetry").hidden = true;
    setImmersive(true); setPlaybackActive(true); window.AndroidGestures.setActive(false);
    loadTimer = setTimeout(function () { failLoading("连接或缓冲超时，请检查网络后重试。"); }, 30000);
  }

  function sourceLoading(url) {
    try { expectedUrl = new URL(url, location.href).href; } catch (error) { expectedUrl = url; }
    if (loading) document.getElementById("mLoadingMessage").textContent = "正在缓冲视频…";
  }

  function matchesSource(art) {
    return !!(requestedPath && expectedUrl && art && art.video && art.video.src === expectedUrl && art.video.currentSrc === expectedUrl);
  }

  function failLoading(message) {
    if (!requestedPath) return;
    ensureLoadPanel(); clearTimeout(loadTimer);
    loading = true; failedLoad = true; playing = false;
    if (window.__BplayerDesktop && window.__BplayerDesktop.cancelLoad) window.__BplayerDesktop.cancelLoad();
    releaseVideo(); setPlaybackActive(false); window.AndroidGestures.setActive(false);
    loadPanel.hidden = false; loadPanel.classList.add("failed"); loadPanel.setAttribute("role", "alert");
    document.getElementById("mLoadingMessage").textContent = "视频打开失败\n" + message;
    document.getElementById("mLoadingRetry").hidden = false;
  }

  function cancelLoading() {
    var dir = requestedPath.replace(/\/[^/]+$/, "");
    exitPlaying();
    window.AndroidFiles.open("file", null, dir).then(function (value) {
      if (value && window.__BplayerDesktop) window.__BplayerDesktop.loadVideo(value, null);
    }).catch(showStorageError);
  }

  function releaseVideo() {
    var art = window.Bplayer && window.Bplayer.art;
    if (!art || !art.video) return;
    try { art.pause(); art.video.removeAttribute("src"); art.video.load(); } catch (error) {}
  }

  function setPlaybackActive(on) {
    try { if (window.AndroidUI && window.AndroidUI.setPlaybackActive) window.AndroidUI.setPlaybackActive(!!on); } catch (error) {}
  }

  function setVideoOrientation(width, height) {
    try { if (window.AndroidUI && window.AndroidUI.setVideoOrientation) window.AndroidUI.setVideoOrientation(width || 0, height || 0); } catch (error) {}
  }

  function updateRotateButton() {
    var button = document.getElementById("mRotateBtn");
    if (!button) return;
    var label = innerWidth > innerHeight ? "竖屏" : "横屏";
    button.textContent = label;
    button.title = "切换为" + label;
    button.setAttribute("aria-label", "切换为" + label);
  }

  function closeDanmakuSettings() {
    var controls = document.querySelector(".mDanControls");
    if (!controls || !controls.classList.contains("is-config-open")) return false;
    controls.classList.remove("is-config-open");
    var button = controls.querySelector(".apd-config");
    if (button) button.setAttribute("aria-expanded", "false");
    return true;
  }

  function sizePlaybackControls() {
    var art = window.Bplayer && window.Bplayer.art;
    var controls = document.querySelector("#player .art-controls");
    var progress = document.querySelector("#player .art-progress");
    if (!controls) return;
    var height = Math.ceil(controls.offsetHeight + (progress ? progress.offsetHeight : 0) + 8);
    document.documentElement.style.setProperty("--m-controls-height", height + "px");
    if (art && art.controls.show) updateRotateButton();
  }

  function mountDanmakuControls(art) {
    var plugin = art.plugins && art.plugins.artplayerPluginDanmuku;
    var right = art.template && art.template.$controlsRight;
    if (!plugin || !right || right.querySelector(".mDanControls")) return;
    var controls = el("div", "mDanControls");
    right.insertBefore(controls, right.firstChild);
    plugin.mount(controls);
    var toggle = controls.querySelector(".apd-toggle");
    var config = controls.querySelector(".apd-config");
    if (toggle) {
      toggle.setAttribute("role", "button"); toggle.setAttribute("tabindex", "0");
      toggle.setAttribute("aria-label", "弹幕开关");
      toggle.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle.click(); }
      });
    }
    if (config) {
      config.setAttribute("role", "button"); config.setAttribute("tabindex", "0");
      config.setAttribute("aria-label", "弹幕设置"); config.setAttribute("aria-expanded", "false");
      config.addEventListener("click", function (event) {
        if (event.target.closest(".apd-config-panel")) return;
        event.stopPropagation();
        var opening = !controls.classList.contains("is-config-open");
        controls.classList.toggle("is-config-open", opening);
        config.setAttribute("aria-expanded", String(opening));
        sizePlaybackControls(); art.controls.show = true;
      });
      config.addEventListener("keydown", function (event) {
        if (event.target !== config) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); config.click(); }
        if (event.key === "Escape") closeDanmakuSettings();
      });
    }
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(sizePlaybackControls);
      observer.observe(art.template.$controls);
      art.on("destroy", function () { observer.disconnect(); });
    }
    sizePlaybackControls();
  }

  function updateTopbar() {
    if (!topbar) return;
    updateRotateButton();
    var cv = document.getElementById("chipVideo");
    var cd = document.getElementById("chipDanmaku");
    var title = cv ? cv.textContent.replace(/^\s*🎬\s*/, "").split(" · ")[0] : "";
    title = title.replace(/\.[a-z0-9]{2,5}$/i, ""); // 顶部标题不带扩展名
    var dan = cd ? cd.textContent.replace(/^\s*💬\s*/, "") : "";
    var t = document.getElementById("mTitle");
    var d = document.getElementById("mDan");
    if (t && title) t.textContent = title;
    if (d) d.textContent = dan;
    if (infoPanel && !infoPanel.hidden) fillInfo();
  }

  function rememberCurrent() {
    var art = window.Bplayer && window.Bplayer.art;
    var v = art && art.video;
    var src = v && (v.currentSrc || v.src);
    if (!src) return;
    var path = window.__BplayerDesktop && window.__BplayerDesktop.currentPath;
    if (!path) {
      try { path = decodeURIComponent(new URL(src).pathname || ""); }
      catch (e) { path = src.replace(/^https?:\/\/asset\.localhost/, ""); }
    }
    if (!path) return;
    var name = path.split("/").pop() || "";
    rememberVideo(path, name);
  }

  function enterPlaying() {
    var art = window.Bplayer && window.Bplayer.art;
    if (!matchesSource(art) || failedLoad || art.video.readyState < 2 || !art.video.videoWidth) return;
    var first = !playing;
    playing = true; loading = false; clearTimeout(loadTimer);
    if (loadPanel) loadPanel.hidden = true;
    document.body.classList.add("m-playing");
    if (home) home.classList.add("hide");
    if (topbar) topbar.classList.add("show");
    var pl = document.getElementById("playlist");
    if (pl) pl.classList.remove("open");
    openInfo(false);
    setImmersive(true); setPlaybackActive(!art.video.paused);
    setVideoOrientation(art.video.videoWidth, art.video.videoHeight);
    window.AndroidGestures.setActive(true);
    updateTopbar();
    if (first) {
      setTimeout(function () { try { art.resize(); } catch (e) {} }, 80);
      rememberCurrent();
    }
  }

  function exitPlaying() {
    closeDanmakuSettings();
    playing = false; loading = false; failedLoad = false; requestedPath = ""; expectedUrl = ""; clearTimeout(loadTimer);
    if (loadPanel) loadPanel.hidden = true;
    if (window.__BplayerDesktop && window.__BplayerDesktop.cancelLoad) window.__BplayerDesktop.cancelLoad();
    releaseVideo();
    document.body.classList.remove("m-playing");
    if (home) home.classList.remove("hide");
    if (topbar) topbar.classList.remove("show");
    openInfo(false);
    setImmersive(false); setPlaybackActive(false); setVideoOrientation(0, 0);
    window.AndroidGestures.setActive(false);
    renderRecent();
  }

  function attachArt(art) {
    if (!art || art === hookedArt) return;
    hookedArt = art; window.AndroidGestures.attach(art);
    mountDanmakuControls(art);
    art.on("control", function (show) {
      var panelOpen = document.querySelector(".mDanControls.is-config-open");
      if (!show && panelOpen && playing) { art.controls.show = true; return; }
      if (topbar && playing) topbar.classList.toggle("show", !!show);
      if (show) sizePlaybackControls();
    });
    art.on("video:loadedmetadata", function () {
      if (matchesSource(art) && !failedLoad && art.video.videoWidth) setVideoOrientation(art.video.videoWidth, art.video.videoHeight);
    });
    art.on("video:loadeddata", enterPlaying);
    art.on("video:canplay", enterPlaying);
    art.on("video:playing", enterPlaying);
    art.on("video:play", function () { if (matchesSource(art)) setPlaybackActive(true); });
    art.on("video:pause", function () { if (matchesSource(art)) setPlaybackActive(false); });
    art.on("video:ended", function () { if (matchesSource(art)) setPlaybackActive(false); });
    art.on("video:error", function () {
      if (matchesSource(art) && !failedLoad) failLoading("网络读取中断，或此视频编码不受当前内核支持。");
    });
  }

  function hookArt() {
    setInterval(function () { attachArt(window.Bplayer && window.Bplayer.art); }, 400);
  }

  window.AndroidPlayback = {
    begin: beginLoading, source: sourceLoading, attach: attachArt, fail: failLoading,
    get loading() { return loading; },
    get active() { return playing || loading; }
  };

  function observeInfo() {
    var cv = document.getElementById("chipVideo");
    var cd = document.getElementById("chipDanmaku");
    if (window.MutationObserver) {
      var mo = new MutationObserver(updateTopbar);
      if (cv) mo.observe(cv, { childList: true, characterData: true, subtree: true });
      if (cd) mo.observe(cd, { childList: true, characterData: true, subtree: true });
    }
  }

  /* 系统返回键：设置/信息卡/浮窗 → 文件浏览器 → 播放列表 → 播放页 → 退出应用 */
  window.__aAndroidBack = function () {
    var mask = document.getElementById("settingsMask");
    if (mask && !mask.hidden) {
      var sc = document.getElementById("settingsClose");
      if (sc) sc.click(); else mask.hidden = true;
      return true;
    }
    if (infoPanel && !infoPanel.hidden) { infoPanel.hidden = true; return true; }
    var panels = ["audioPanel", "subtitlePanel", "densityPanel", "blockPanel"];
    for (var i = 0; i < panels.length; i++) {
      var p = document.getElementById(panels[i]);
      if (p && !p.hidden) { p.hidden = true; return true; }
    }
    if (closeDanmakuSettings()) return true;
    if (window.AndroidFiles.back()) return true;
    if (loading) { cancelLoading(); return true; }
    var pl = document.getElementById("playlist");
    if (pl && pl.classList.contains("open")) { pl.classList.remove("open"); return true; }
    if (playing) { exitPlaying(); return true; }
    try {
      if (window.AndroidUI && window.AndroidUI.exitApp) window.AndroidUI.exitApp();
    } catch (e) {}
    return true;
  };

  function polishSettings() {
    var opt = document.getElementById("optAutostart");
    if (opt && opt.closest) {
      var row = opt.closest(".settings-row");
      if (row) row.style.display = "none"; // 手机没有开机启动项
    }
    var modal = document.querySelector("#settingsMask .settings-modal");
    var head = modal && modal.querySelector(".settings-head");
    if (head && !document.getElementById("mSettingsNote")) {
      var note = el("div", "settings-desc", "Android 版：音轨 / 字幕自动转换需要后台 ffmpeg，当前版本保留开关，转码在后续版本接入。");
      note.id = "mSettingsNote";
      note.style.paddingLeft = "0";
      head.parentNode.insertBefore(note, head.nextSibling);
    }
  }

  function boot() {
    buildHome();
    buildTopbar();
    polishSettings();
    hookArt();
    observeInfo();
    window.addEventListener("resize", updateRotateButton);
    document.addEventListener("click", function (event) {
      if (!document.querySelector(".mDanControls.is-config-open") || event.target.closest(".mDanControls")) return;
      closeDanmakuSettings();
      if (!event.target.closest("button,.art-controls,#mTop,#mInfo")) event.stopPropagation();
    }, true);
    // 不再锁定方向：旋转后重排播放器（启动页靠 CSS 自动切竖排）
    window.addEventListener("orientationchange", function () {
      setTimeout(function () {
        try {
          var art = window.Bplayer && window.Bplayer.art;
          if (art) art.resize();
        } catch (e) {}
        window.dispatchEvent(new Event("resize"));
        if (infoPanel && !infoPanel.hidden) fillInfo();
      }, 260);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 主流程在 initDesktop() 里提前捕获 invoke，这里显式暴露代理函数，
  // index.html 改为优先使用它（见 initDesktop / placeholder 点击两处）。
  window.__aInvoke = function (cmd, args) {
    if (cmd === "pick_video") return openBrowser("file");
    if (cmd === "pick_folder") return openBrowser("dir");
    return window.AndroidFiles.invoke(cmd, args);
  };
})();
