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
  var playbackOrigin = null;
  var homePosition = null;
  var navigation = window.AndroidNavigation;
  var syncingPlayerSettings = false;

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
      ".mRecentRow{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}" +
      "#mRecentActions{position:fixed;inset:0;z-index:200006;display:grid;grid-template-columns:minmax(0,1fr);align-items:end;justify-items:center;background:#0009;padding:calc(env(safe-area-inset-top,0px) + 16px) calc(env(safe-area-inset-right,0px) + 16px) calc(env(safe-area-inset-bottom,0px) + 16px) calc(env(safe-area-inset-left,0px) + 16px);box-sizing:border-box;}#mRecentActions[hidden]{display:none!important;}" +
      "#mRecentActionCard{width:100%;max-width:430px;min-width:0;max-height:100%;overflow:auto;padding:18px;box-sizing:border-box;border:1px solid #ffffff24;border-radius:18px;background:#151823;color:#edf0fa;font:14px system-ui,sans-serif;}#mRecentActionCard h2{margin:0 0 10px;font-size:17px;}#mRecentActionName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}#mRecentActionCard p{color:#a9b4cd;line-height:1.6;}#mRecentActionCard button{display:block;width:100%;min-height:46px;margin-top:10px;padding:10px;border:1px solid #ffffff24;border-radius:12px;background:#ffffff08;color:#edf0fa;font:inherit;}#mRecentActionCard #mRecentDelete{color:#ffb2c3;background:#e8547820;border-color:#e8547855;}" +
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
      "#mHome .mRight{flex:1;display:flex;max-width:none;max-height:none;min-height:0;}" +
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
      ".mi-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}" +
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
      ".mDirectAction{display:none;}" +
      "#mTop button:disabled{opacity:.38;}" +
      "#mRecentView{min-width:38px;min-height:38px;border:1px solid #ffffff20;border-radius:10px;background:#ffffff08;color:#c8d2e7;font:12px inherit;}" +
      ".mRecentThumb{display:none;width:100%;aspect-ratio:16/9;object-fit:cover;background:#202a3d;border-radius:9px;}" +
      ".mRecentThumb:not([src]){visibility:hidden;}" +
      ".mRecentList.is-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));align-content:start;gap:10px;}" +
      ".mRecentList.is-grid .mRecentRow{position:relative;display:grid;gap:7px;padding:8px;align-content:start;}" +
      ".mRecentList.is-grid .mRecentThumb{display:block;}.mRecentList.is-grid .ic{position:absolute;left:8px;top:8px;width:calc(100% - 16px);height:auto;aspect-ratio:16/9;font-size:28px;}.mRecentList.is-grid .mRecentThumb.thumbnail-ready+.ic{display:none;}" +
      ".mRecentList.is-grid .nm{width:100%;font-size:12px;}.mRecentList.is-grid .go{font-size:11px;}" +
      "@media(min-width:720px){#mTop .mDirectAction{display:block;width:auto;min-width:48px;padding:0 10px;border-radius:12px;font-size:12px;line-height:normal;}#mInfo{left:auto;width:min(460px,calc(100vw - 32px));right:16px;}" +
      ".settings-modal{width:min(620px,calc(100vw - 48px))!important;max-width:620px!important;}" +
      ".block-panel{left:auto!important;right:16px!important;width:min(420px,calc(100vw - 32px))!important;max-width:420px!important;}}" +
      "@media(min-width:720px) and (min-height:540px){#mHome .mBody{flex-direction:row;gap:24px;padding:24px;}#mHome .mLeft{flex:0 0 40%;justify-content:center;}#mHome .mRight{flex:1;max-width:none;max-height:none;min-height:0;}#mHome .mActions{flex-direction:column;}#mHome .mBtn{flex:none;min-height:76px;}#mHome .mRecentList{gap:10px;}#mHome .mRecentRow{min-height:58px;}}" +
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
    navigation.invalidate();
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

  var recentGrid = false;
  var recentThumbnailCleanups = [];
  var recentPress = null;
  var recentClickBlockedUntil = 0;
  var recentTouchCancelledUntil = 0;
  var recentTouchConsumed = false;
  var recentTouchActive = false;
  var recentTouchCancelled = false;
  var recentActions = null;
  var recentActionPath = "";

  function cancelRecentPress(blockClick) {
    if (!recentPress) return;
    clearTimeout(recentPress.timer);
    if (blockClick || recentPress.opened) { recentClickBlockedUntil = Date.now() + 1000; recentTouchConsumed = true; }
    if (blockClick) recentTouchCancelled = true;
    recentPress = null;
  }

  function recentPositionAfterDelete(path) {
    var box = document.getElementById("mRecentList");
    var position = navigation.captureScroll(box);
    if (!position || position.path !== path) return position;
    var rows = Array.from(box.querySelectorAll("[data-path]"));
    var index = rows.findIndex(function (row) { return row.dataset.path === path; });
    var replacement = rows[index + 1] || rows[index - 1];
    if (replacement) {
      position.path = replacement.dataset.path;
      position.offset = replacement.getBoundingClientRect().top - box.getBoundingClientRect().top;
    }
    return position;
  }

  function ensureRecentActions() {
    if (recentActions) return;
    recentActions = el("div"); recentActions.id = "mRecentActions"; recentActions.hidden = true;
    recentActions.setAttribute("role", "dialog"); recentActions.setAttribute("aria-modal", "true");
    recentActions.setAttribute("aria-labelledby", "mRecentActionTitle");
    recentActions.setAttribute("aria-describedby", "mRecentActionNote");
    var card = el("div"); card.id = "mRecentActionCard";
    var title = el("h2", "", "最近播放记录"); title.id = "mRecentActionTitle";
    var name = el("div"); name.id = "mRecentActionName";
    var note = el("p", "", "只移除这条播放历史，不会删除视频、续播进度或封面。"); note.id = "mRecentActionNote";
    var remove = el("button", "", "删除这条记录"); remove.id = "mRecentDelete"; remove.type = "button";
    var cancel = el("button", "", "取消"); cancel.id = "mRecentDeleteCancel"; cancel.type = "button";
    remove.addEventListener("click", function () {
      if (navigation.top !== "recentActions" || !recentActionPath) return;
      var path = recentActionPath;
      var position = recentPositionAfterDelete(path);
      writeRecent(readRecent().filter(function (item) { return item.p !== path; }));
      navigation.close("recentActions");
      renderRecent(position);
    });
    cancel.addEventListener("click", function () { navigation.close("recentActions"); });
    recentActions.addEventListener("click", function (event) {
      if (event.target === recentActions) navigation.close("recentActions");
    });
    card.append(title, name, note, remove, cancel); recentActions.appendChild(card); document.body.appendChild(recentActions);
    navigation.register("recentActions", function () { recentActions.hidden = false; }, function () {
      recentActions.hidden = true; recentActionPath = ""; cancelRecentPress(true);
    });
  }

  function openRecentActions(path) {
    if (!home || home.classList.contains("hide")) return;
    var item = readRecent().find(function (entry) { return entry.p === path; });
    if (!item) return;
    ensureRecentActions();
    navigation.open("recentActions");
    recentActionPath = path;
    document.getElementById("mRecentActionName").textContent = item.n || item.p;
    document.getElementById("mRecentActionName").title = item.n || item.p;
    recentClickBlockedUntil = Date.now() + 1000;
  }

  function bindRecentRow(row, path) {
    row.addEventListener("touchstart", function (event) {
      cancelRecentPress(false);
      recentTouchActive = true;
      if (event.touches.length !== 1) { recentTouchCancelled = true; recentTouchCancelledUntil = Date.now() + 1000; return; }
      var touch = event.touches[0];
      recentTouchCancelledUntil = 0; recentTouchConsumed = false; recentTouchCancelled = false;
      var press = { path: path, identifier: touch.identifier, x: touch.clientX, y: touch.clientY, opened: false, timer: null };
      recentPress = press;
      press.timer = setTimeout(function () {
        if (recentPress !== press || !row.isConnected || navigation.top) return;
        press.opened = true;
        openRecentActions(path);
      }, 550);
    }, { passive: true });
    row.addEventListener("touchmove", function (event) {
      if (!recentPress) return;
      var touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== recentPress.identifier || Math.hypot(touch.clientX - recentPress.x, touch.clientY - recentPress.y) > 10) {
        recentTouchCancelledUntil = Date.now() + 1000; cancelRecentPress(true);
      }
    }, { passive: true });
    row.addEventListener("touchend", function (event) {
      if (recentTouchConsumed || (recentPress && recentPress.opened)) { event.preventDefault(); recentClickBlockedUntil = Date.now() + 1000; }
      cancelRecentPress(false); recentTouchConsumed = false; recentTouchActive = false;
      if (recentTouchCancelled) recentTouchCancelledUntil = Date.now() + 1000;
    }, { passive: false });
    row.addEventListener("touchcancel", function () { recentTouchCancelledUntil = Date.now() + 1000; cancelRecentPress(true); recentTouchActive = false; });
    row.addEventListener("contextmenu", function (event) {
      event.preventDefault(); event.stopPropagation();
      if ((recentTouchActive && recentTouchCancelled) || Date.now() < recentTouchCancelledUntil) return;
      cancelRecentPress(true); openRecentActions(path);
    });
    row.addEventListener("click", function (event) {
      if (Date.now() < recentClickBlockedUntil || navigation.top === "recentActions") { event.preventDefault(); event.stopPropagation(); return; }
      cancelRecentPress(false);
      if (window.__BplayerDesktop) window.__BplayerDesktop.loadVideo(path, null, null, homeOrigin());
    });
  }

  function bindRecentList(box) {
    box.addEventListener("scroll", function () {
      if (!recentPress) return;
      recentTouchCancelledUntil = Date.now() + 1000; cancelRecentPress(true);
    }, { passive: true });
    document.addEventListener("touchstart", function (event) {
      if (event.touches.length > 1) { recentTouchCancelledUntil = Date.now() + 1000; cancelRecentPress(true); }
    }, { capture: true, passive: true });
    window.addEventListener("blur", function () { cancelRecentPress(true); });
    window.addEventListener("pagehide", function () { cancelRecentPress(true); });
  }

  try { recentGrid = localStorage.getItem("bplayer.android.recentView") === "grid"; } catch (error) {}
  function renderRecent(position) {
    cancelRecentPress(false);
    recentThumbnailCleanups.forEach(function (cleanup) { cleanup(); });
    recentThumbnailCleanups = [];
    if (!home) return;
    var box = document.getElementById("mRecentList");
    if (!box) return;
    if (position) homePosition = position;
    else if (!home.classList.contains("hide")) homePosition = navigation.captureScroll(box);
    box.classList.toggle("is-grid", recentGrid);
    var viewButton = document.getElementById("mRecentView");
    viewButton.textContent = recentGrid ? "列表" : "预览图";
    viewButton.setAttribute("aria-pressed", String(recentGrid));
    box.textContent = "";
    var list = readRecent();
    writeRecent(list); // 顺手把历史上重复/多斜杠的路径清一遍
    if (!list.length) {
      var empty = el("div", "mEmpty", "还没有播放记录\n选一部片子开始吧");
      empty.style.whiteSpace = "pre-line";
      box.appendChild(empty);
      return;
    }
    list.slice(0, 8).forEach(function (item) {
      var row = el("div", "mRecentRow");
      if (recentGrid) {
        var image = el("img", "mRecentThumb"); image.alt = ""; row.appendChild(image);
        if (window.AndroidThumbnailsView) recentThumbnailCleanups.push(window.AndroidThumbnailsView.observe(image, item.p, { cacheOnly: true }));
      }
      row.appendChild(el("span", "ic", "🎞"));
      row.appendChild(el("span", "nm", item.n || item.p));
      row.appendChild(el("span", "go", "继续"));
      row.title = item.p; row.dataset.path = item.p;
      bindRecentRow(row, item.p);
      box.appendChild(row);
    });
    if (!home.classList.contains("hide")) navigation.restoreScroll(box, homePosition);
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
            '<button type="button" id="mRecentView" aria-label="切换最近播放视图">预览图</button>' +
            '<button type="button" id="mClearRecent">清空</button></div>' +
          '<div class="mRecentList" id="mRecentList"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(home);
    bindRecentList(document.getElementById("mRecentList"));

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
      navigation.invalidate();
      window.AndroidFiles.open("file", "network").then(function (path) {
        if (path && window.__BplayerDesktop) return window.__BplayerDesktop.loadVideo(path, null);
      }).catch(showStorageError);
    });
    document.getElementById("mHomeSettings").addEventListener("click", function () {
      var b = document.getElementById("btnSettings");
      if (b) b.click();
    });
    document.getElementById("mRecentView").addEventListener("click", function () {
      recentGrid = !recentGrid;
      try { localStorage.setItem("bplayer.android.recentView", recentGrid ? "grid" : "list"); } catch (error) {}
      renderRecent();
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
      '<button type="button" class="mIconBtn mDirectAction" id="mQuickAudio">音轨</button>' +
      '<button type="button" class="mIconBtn mDirectAction" id="mQuickSub">字幕</button>' +
      '<button type="button" class="mIconBtn mDirectAction" id="mQuickSettings">设置</button>' +
      '<button type="button" class="mIconBtn" id="mRotateBtn" title="切换为横屏" aria-label="切换为横屏">横屏</button>' +
      '<button type="button" class="mIconBtn" id="mInfoBtn" title="视频信息与功能">i</button>' +
      '<button type="button" class="mIconBtn" id="mPlBtn" title="播放列表">≡</button>';
    document.body.appendChild(topbar);
    buildInfoPanel();
    [["mQuickAudio", "mActAudio"], ["mQuickSub", "mActSub"], ["mQuickSettings", "mActSettings"]].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener("click", function () {
        navigation.clear();
        document.getElementById(pair[1]).click();
      });
    });

    document.getElementById("mBack").addEventListener("click", function () { window.__aAndroidBack(); });
    document.getElementById("mInfoBtn").addEventListener("click", function () {
      if (!infoPanel) return;
      var opening = infoPanel.hidden;
      openInfo(opening);
    });
    document.getElementById("mPlBtn").addEventListener("click", function () {
      navigation.open("playlist");
    });
    document.getElementById("mRotateBtn").addEventListener("click", function () {
      if (!playing) return;
      navigation.close("danmaku");
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
        '<button type="button" id="mActDanmaku">载入弹幕</button>' +
        '<button type="button" id="mActBlock">弹幕屏蔽</button>' +
        '<button type="button" id="mActSettings">设置</button>' +
      '</div>';
    document.body.appendChild(infoPanel);

    document.getElementById("mInfoClose").addEventListener("click", function () {
      navigation.close("mInfo");
    });
    function forward(btnId) {
      var b = document.getElementById(btnId);
      if (b && !b.hidden && !b.disabled) navigation.forward(function () { b.click(); });
    }
    document.getElementById("mActAudio").addEventListener("click", function () {
      forward("btnAudioEntry");
    });
    document.getElementById("mActSub").addEventListener("click", function () {
      forward("btnSubtitleEntry");
    });
    document.getElementById("mActDanmaku").addEventListener("click", function () { forward("btnDanmakuEntry"); });
    document.getElementById("mActBlock").addEventListener("click", function () {
      forward("btnBlockEntry");
    });
    document.getElementById("mActSettings").addEventListener("click", function () {
      forward("btnSettings");
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
    var qa = document.getElementById("mQuickAudio");
    var qs = document.getElementById("mQuickSub");
    if (qa) qa.disabled = !ab || ab.hidden;
    if (qs) qs.disabled = !sb || sb.hidden;
  }

  function openInfo(on) {
    if (on) navigation.open("mInfo"); else navigation.close("mInfo");
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
    loadPanel.innerHTML = '<div id="mLoadingSpinner"></div><div id="mLoadingName"></div><div id="mLoadingMessage"></div><div id="mLoadingActions"><button type="button" id="mLoadingCancel">返回</button><button type="button" id="mLoadingRetry" hidden>重试</button></div>';
    document.body.appendChild(loadPanel);
    document.getElementById("mLoadingCancel").addEventListener("click", cancelLoading);
    document.getElementById("mLoadingRetry").addEventListener("click", function () {
      if (requestedPath && window.__BplayerDesktop) window.__BplayerDesktop.loadVideo(requestedPath, null);
    });
  }

  function beginLoading(path, name, origin) {
    if (origin) playbackOrigin = origin;
    else if (!playbackOrigin) playbackOrigin = homeOrigin();
    if (playbackOrigin.type === "playlist") {
      var index = playbackOrigin.snapshot.episodes.findIndex(function (episode) { return episode.path === path; });
      if (index >= 0) playbackOrigin.snapshot.index = index;
    }
    navigation.invalidate(); navigation.clear();
    if (playbackThumbnail) { playbackThumbnail.cancel(); playbackThumbnail = null; }
    playbackCaptureAttempts = 0; playbackCaptured = false; playbackCaptureAt = 0;
    window.AndroidPlayerTools.begin(path);
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
    window.AndroidPlayerTools.finish();
    if (window.__BplayerDesktop && window.__BplayerDesktop.cancelLoad) window.__BplayerDesktop.cancelLoad();
    releaseVideo(); setPlaybackActive(false); window.AndroidGestures.setActive(false);
    loadPanel.hidden = false; loadPanel.classList.add("failed"); loadPanel.setAttribute("role", "alert");
    document.getElementById("mLoadingMessage").textContent = "视频打开失败\n" + message;
    document.getElementById("mLoadingRetry").hidden = false;
  }

  function cancelLoading() { exitPlaying(); }

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
    var art = window.Bplayer && window.Bplayer.art;
    if (window.AndroidPlayerTools) window.AndroidPlayerTools.onControls(art && art.controls.show);
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
        if (opening) navigation.open("danmaku"); else navigation.close("danmaku");
        sizePlaybackControls(); art.controls.show = true;
        if (window.AndroidPlayerTools) window.AndroidPlayerTools.onControls(true);
      });
      config.addEventListener("keydown", function (event) {
        if (event.target !== config) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); config.click(); }
        if (event.key === "Escape") navigation.close("danmaku");
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
    fillInfo();
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

  var playbackThumbnail = null;
  var playbackCaptureAttempts = 0;
  var playbackCaptureAt = 0;
  var playbackCaptured = false;
  function cacheCurrentThumbnail() {
    if (playbackThumbnail || playbackCaptured || playbackCaptureAttempts >= 6 || !requestedPath || !window.AndroidThumbnailsView) return;
    var now = Date.now();
    if (now - playbackCaptureAt < 2000) return;
    var art = window.Bplayer && window.Bplayer.art;
    if (!matchesSource(art)) return;
    playbackCaptureAttempts++; playbackCaptureAt = now;
    var path = requestedPath;
    var task = window.AndroidThumbnailsView.capture(art.video, path, window.__BplayerDesktop.currentStat);
    if (!task) return;
    playbackThumbnail = task;
    task.promise.then(function (result) {
      if (playbackThumbnail !== task || requestedPath !== path) return;
      playbackThumbnail = null;
      playbackCaptured = result && result.status === "captured";
    });
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
    setImmersive(true); setPlaybackActive(true);
    setVideoOrientation(art.video.videoWidth, art.video.videoHeight);
    window.AndroidGestures.setActive(true);
    updateTopbar();
    if (first) {
      setTimeout(function () { try { art.resize(); } catch (e) {} }, 80);
      rememberCurrent();
      cacheCurrentThumbnail();
      window.AndroidPlayerTools.ready();
    }
  }

  function exitPlaying() {
    var origin = playbackOrigin; playbackOrigin = null;
    navigation.invalidate(); navigation.clear();
    if (playbackThumbnail) { playbackThumbnail.cancel(); playbackThumbnail = null; }
    window.AndroidPlayerTools.finish();
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
    restoreOrigin(origin);
  }

  function homeOrigin() {
    var box = document.getElementById("mRecentList");
    homePosition = navigation.captureScroll(box);
    return { type: "home", position: homePosition };
  }

  function restoreOrigin(origin) {
    if (!origin) return;
    if (origin.type === "browser") {
      window.AndroidFiles.restore(origin.snapshot).then(function (path) {
        if (!path || !window.__BplayerDesktop) return;
        if (origin.snapshot.mode === "dir") return window.__BplayerDesktop.openFolder(path);
        return window.__BplayerDesktop.loadVideo(path, null);
      }).catch(showStorageError);
    } else if (origin.type === "playlist" && window.__BplayerDesktop) {
      window.__BplayerDesktop.restorePlaylist(origin.snapshot);
    } else {
      homePosition = origin.position;
      navigation.restoreScroll(document.getElementById("mRecentList"), homePosition);
    }
  }

  function attachArt(art) {
    if (!art || art === hookedArt) return;
    hookedArt = art; window.AndroidGestures.attach(art);
    window.AndroidPlayerTools.attach(art);
    mountDanmakuControls(art);
    art.on("setting", function (show) {
      if (syncingPlayerSettings) return;
      if (show) navigation.open("playerSettings"); else navigation.close("playerSettings");
    });
    art.on("control", function (show) {
      if (window.AndroidPlayerTools.locked || window.AndroidPlayerTools.resumePending) {
        if (topbar) topbar.classList.remove("show");
        window.AndroidPlayerTools.onControls(false);
        return;
      }
      window.AndroidPlayerTools.onControls(show);
      var panelOpen = document.querySelector(".mDanControls.is-config-open");
      if (!show && panelOpen && playing) { art.controls.show = true; return; }
      if (topbar && playing) topbar.classList.toggle("show", !!show);
      if (show) sizePlaybackControls();
    });
    art.on("video:loadedmetadata", function () {
      if (matchesSource(art) && !failedLoad && art.video.videoWidth) setVideoOrientation(art.video.videoWidth, art.video.videoHeight);
    });
    art.on("video:timeupdate", cacheCurrentThumbnail);
    art.on("video:seeked", cacheCurrentThumbnail);
    art.on("video:loadeddata", enterPlaying);
    art.on("video:canplay", enterPlaying);
    art.on("video:playing", enterPlaying);
    art.on("video:play", function () { if (matchesSource(art)) setPlaybackActive(true); });
    art.on("video:pause", function () { if (matchesSource(art)) setPlaybackActive(playing && !art.video.ended); });
    art.on("video:ended", function () { if (matchesSource(art)) setPlaybackActive(false); });
    art.on("video:error", function () {
      if (matchesSource(art) && !failedLoad) failLoading("网络读取中断，或此视频编码不受当前内核支持。");
    });
  }

  function hookArt() {
    setInterval(function () { attachArt(window.Bplayer && window.Bplayer.art); }, 400);
  }

  window.AndroidPlayback = {
    begin: beginLoading, source: sourceLoading, attach: attachArt, fail: failLoading, exit: exitPlaying,
    homeOrigin: homeOrigin, restoreOrigin: restoreOrigin,
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
      ["btnAudioEntry", "btnSubtitleEntry"].forEach(function (id) {
        var button = document.getElementById(id);
        if (button) mo.observe(button, { attributes: true, attributeFilter: ["hidden", "disabled"] });
      });
    }
  }

  /* 系统返回键：设置/信息卡/浮窗 → 文件浏览器 → 播放列表 → 播放页 → 退出应用 */
  window.__aAndroidBack = function () {
    if (navigation.top === "recentActions") { navigation.close("recentActions"); return true; }
    if (window.AndroidPlayerTools.back()) return true;
    if (window.AndroidFiles.back()) return true;
    if (loading) { cancelLoading(); return true; }
    if (navigation.cancelPending()) return true;
    if (navigation.close()) return true;
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
    ["audioPanel", "subtitlePanel", "danmakuPanel", "densityPanel", "blockPanel", "settingsMask"].forEach(function (id) {
      navigation.register(id, function () { document.getElementById(id).hidden = false; }, function () { document.getElementById(id).hidden = true; });
    });
    navigation.register("mInfo", function () { fillInfo(); infoPanel.hidden = false; }, function () { infoPanel.hidden = true; });
    navigation.register("playlist", function () { document.getElementById("playlist").classList.add("open"); }, function () { document.getElementById("playlist").classList.remove("open"); }, function () {
      if (window.__BplayerDesktop) window.__BplayerDesktop.playlistClosed();
    });
    navigation.register("danmaku", function () {
      var controls = document.querySelector(".mDanControls");
      if (controls) { controls.classList.add("is-config-open"); controls.querySelector(".apd-config").setAttribute("aria-expanded", "true"); }
    }, closeDanmakuSettings);
    function playerSettings(on) {
      var art = window.Bplayer && window.Bplayer.art;
      if (!art) return;
      syncingPlayerSettings = true;
      try { art.setting.show = on; } finally { syncingPlayerSettings = false; }
    }
    navigation.register("playerSettings", function () { playerSettings(true); }, function () { playerSettings(false); });
    polishSettings();
    hookArt();
    observeInfo();
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || (!playing && !loading && !navigation.top && !window.AndroidFiles.active)) return;
      event.preventDefault(); event.stopImmediatePropagation(); window.__aAndroidBack();
    }, true);
    window.addEventListener("android-touch-lock", function () {
      navigation.clear();
    });
    window.addEventListener("resize", function () {
      updateRotateButton();
      var art = window.Bplayer && window.Bplayer.art;
      if (art) art.resize();
      sizePlaybackControls();
      if (infoPanel && !infoPanel.hidden) fillInfo();
    });
    document.addEventListener("click", function (event) {
      if (!document.querySelector(".mDanControls.is-config-open") || event.target.closest(".mDanControls")) return;
      navigation.close("danmaku");
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
