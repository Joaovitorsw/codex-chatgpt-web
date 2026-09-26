const languages = require("./languages.json");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  Tray,
} = require("electron");
const { BrowserHost, navigationErrorForLog } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { LimitsController } = require("./limits-controller.cjs");
const { SOURCE_URL: LIMITS_SOURCE_URL } = require("./limits-store.cjs");
const { releaseRetainedConversation } = require("./retained-turn-release.cjs");
const { createRetainedConversationStore } = require("./retained-conversation-store.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { DEVELOPMENT_PROFILE, resolveLauncherProfile } = require("./profile.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createUpdateController } = require("./update.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
const LAUNCHER_PROFILE = resolveLauncherProfile({ appData: app.getPath("appData") });
const IS_DEV_PROFILE = LAUNCHER_PROFILE.kind === DEVELOPMENT_PROFILE;
const CORE_HOME = LAUNCHER_PROFILE.coreHome;
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const GITHUB_URL = "https://github.com/miuuyy/codex-chatgpt-web";
const X_URL = "https://x.com/miu21590";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, X_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL, LIMITS_SOURCE_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");
const BUNDLED_SKILLS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "skills")
  : path.join(__dirname, "..", "assets", "skills");
const {
  listBundledSkills,
  syncBundledSkills,
  validateBundledSkillSelection,
} = require("./bundled-skills.cjs");

const launchEnvironment = {
  CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.codexwebgpt.launcher.dev" : "dev.codexwebgpt.launcher");
}
const launcherUserData = LAUNCHER_PROFILE.userData;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let startupWindow = null;
let mainWindowReadyToShow = false;
let mainWindowShowRequested = false;
let startupFailed = false;
let browserHost = null;
let runtimeHost = null;
let browserControl = null;
let runtimeSupervisor = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let updateController = null;
let limitsController = null;
let pendingPreferenceTimer = null;
let applyingPendingFreshConversation = false;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  let reportedFailure = null;
  const check = async () => {
    const current = stateStore.read();
    if (current.coreSetupComplete !== true || current.codexCatalogVerified === true) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) {
        const result = health?.last_model_catalog_result;
        if (!result || !Number.isInteger(result.status) || result.status < 400 || result.status > 599
          || !Number.isInteger(result.request) || result.request < 1 || lastOperation?.status === "running") return;
        const identity = `${health.pid}:${result.request}:${result.at}`;
        if (identity === reportedFailure) return;
        reportedFailure = identity;
        const reason = typeof result.failure?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(result.failure.code)
          ? result.failure.code
          : ["config", "request", "transport", "upstream", "catalog"].includes(result.failure?.stage) ? result.failure.stage : "catalog";
        const state = stateStore.update({ codexRestartRequired: false });
        send("launcher:state-changed", state);
        logger.warn("codex.model_catalog_failed", { status: result.status, reason, request: result.request });
        publishOperation({
          name: "catalog-verification", status: "failed",
          message: nativeCopyFor(current.language).catalogFailure
            .replace("{status}", String(result.status)).replace("{reason}", reason),
        });
        return;
      }
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
      stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

async function restoreCodexRouteAfterRuntimeFailure({ logger, stateStore }) {
  try {
    const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
    if (!route.installed || route.active) return { restored: false };
    const state = stateStore.update({
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    logger.warn("bridge.route_restored_after_runtime_failure", {
      changed: route.changed === true,
    });
    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
    return { restored: false, error: message };
  }
}

function trayImage() {
  if (process.platform !== "darwin") {
    return nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M4.1 3.4h6.4l3.4 3.4v7.8H7.5l-3.4-3.4V3.4Z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><path d="m7 7 2-2 2 2M7 11l2 2 2-2" fill="none" stroke="white" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
}

const NATIVE_COPY = Object.freeze({
  "en": Object.freeze({
    openLauncher: "Open Codex Web GPT",
    quit: "Quit",
    exportDiagnostics: "Export privacy-safe diagnostics",
    cancel: "Cancel",
    remove: "Remove",
    removeTitle: "Remove Codex Web GPT",
    removeMessage: "Remove the ChatGPT Web models from Codex and restore the previous model route?",
    removeDetail: "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
    restore: "Restore",
    restoreTitle: "Restore native Codex",
    restoreMessage: "Back up the current Codex configuration and restore native Codex routing?",
    restoreDetail: "No active task or launcher runtime will be stopped. Authentication and unrelated settings are preserved; restart Codex once afterward.",
    retry: "Retry",
    startupTitle: "Codex Web GPT could not start",
    startupDetail: "Retry starts the launcher again without changing your saved settings or ChatGPT profile.",
    startupCleanupFailed: "Startup cleanup failed",
    catalogFailure: "Codex reached the launcher, but loading its model catalog failed (HTTP {status}; {reason}). Check Activity for details and export a safe log if it persists.",
  }),
  "zh-CN": Object.freeze({
    openLauncher: "打开 Codex Web GPT",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
    retry: "重试",
    startupTitle: "Codex Web GPT 无法启动",
    startupDetail: "重试会重新启动应用，不会更改已保存的设置或 ChatGPT 登录配置。",
    startupCleanupFailed: "启动清理失败",
    catalogFailure: "Codex 已连接到启动器，但模型列表加载失败（HTTP {status}；{reason}）。请查看“活动”了解详情；若问题持续，请导出安全日志。",
  }),
  "zh-TW": Object.freeze({
    openLauncher: "開啟 Codex Web GPT",
    quit: "結束",
    exportDiagnostics: "匯出隱私安全診斷",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "從 Codex 中移除 ChatGPT Web 模型並還原先前的模型路由？",
    removeDetail: "啟動器中的 ChatGPT 登入設定檔會保留。Codex 需要重新啟動一次。",
    retry: "重試",
    startupTitle: "Codex Web GPT 無法啟動",
    startupDetail: "重試會重新啟動應用程式，不會變更已儲存的設定或 ChatGPT 登入設定檔。",
    startupCleanupFailed: "啟動清理失敗",
    catalogFailure: "Codex 已連線到啟動器，但模型清單載入失敗（HTTP {status}；{reason}）。請查看「活動」了解詳情；若問題持續，請匯出安全日誌。",
  }),
  "ja": Object.freeze({
    openLauncher: "Codex Web GPT を開く",
    quit: "終了",
    exportDiagnostics: "プライバシー保護済みの診断情報をエクスポート",
    cancel: "キャンセル",
    remove: "削除",
    removeTitle: "Codex Web GPT を削除",
    removeMessage: "Codex から ChatGPT Web モデルを削除し、以前のモデルルートを復元しますか？",
    removeDetail: "ランチャーの ChatGPT ログインプロファイルは保持されます。Codex を一度再起動する必要があります。",
    retry: "再試行",
    startupTitle: "Codex Web GPT を起動できませんでした",
    startupDetail: "保存済みの設定と ChatGPT プロファイルを変更せずに、ランチャーを再起動します。",
    startupCleanupFailed: "起動後のクリーンアップに失敗しました",
    catalogFailure: "Codex はランチャーに接続しましたが、モデル一覧を読み込めませんでした（HTTP {status}、{reason}）。「アクティビティ」で詳細を確認し、問題が続く場合は安全なログをエクスポートしてください。",
  }),
  "ko": Object.freeze({
    openLauncher: "Codex Web GPT 열기",
    quit: "종료",
    exportDiagnostics: "개인정보가 보호된 진단 정보 내보내기",
    cancel: "취소",
    remove: "제거",
    removeTitle: "Codex Web GPT 제거",
    removeMessage: "Codex에서 ChatGPT Web 모델을 제거하고 이전 모델 경로를 복원할까요?",
    removeDetail: "런처의 ChatGPT 로그인 프로필은 유지됩니다. Codex를 한 번 다시 시작해야 합니다.",
    retry: "다시 시도",
    startupTitle: "Codex Web GPT를 시작할 수 없습니다",
    startupDetail: "저장된 설정이나 ChatGPT 프로필을 변경하지 않고 런처를 다시 시작합니다.",
    startupCleanupFailed: "시작 정리에 실패했습니다",
    catalogFailure: "Codex가 런처에 연결했지만 모델 목록을 불러오지 못했습니다(HTTP {status}; {reason}). 활동에서 세부 정보를 확인하고 문제가 계속되면 안전한 로그를 내보내 주세요.",
  }),
  "pt-BR": Object.freeze({
    openLauncher: "Abrir Codex Web GPT",
    quit: "Sair",
    exportDiagnostics: "Exportar diagnóstico seguro",
    cancel: "Cancelar",
    remove: "Remover",
    removeTitle: "Remover Codex Web GPT",
    removeMessage: "Remover os modelos ChatGPT Web do Codex e restaurar a rota anterior?",
    removeDetail: "O perfil de login do ChatGPT será preservado. O Codex precisará ser reiniciado uma vez.",
    restore: "Reverter",
    restoreTitle: "Reverter para o Codex nativo",
    restoreMessage: "Fazer backup da configuração atual e restaurar a rota nativa do Codex?",
    restoreDetail: "Nenhuma tarefa ativa nem o runtime do launcher será encerrado. A autenticação e configurações não relacionadas serão preservadas; depois, reinicie o Codex uma vez.",
    retry: "Tentar novamente",
    startupTitle: "O Codex Web GPT não pôde iniciar",
    startupDetail: "A nova tentativa reinicia o launcher sem alterar suas configurações salvas ou o perfil do ChatGPT.",
    startupCleanupFailed: "Falha na limpeza da inicialização",
    catalogFailure: "O Codex alcançou o launcher, mas não conseguiu carregar o catálogo de modelos (HTTP {status}; {reason}). Consulte Atividade e exporte um log seguro se o problema persistir.",
  }),
});

function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

function updateTrayMenu(language) {
  if (!tray) return;
  const copy = nativeCopyFor(language);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.openLauncher, click: () => showMainWindow() },
    { type: "separator" },
    { label: copy.quit, click: () => { void requestQuit(); } },
  ]));
}

function createTray(logger, language) {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(LAUNCHER_PROFILE.displayName);
    updateTrayMenu(language);
    tray.on("click", () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  // A Windows login launch may still be materializing the packaged runtime when the user opens
  // the desktop shortcut. Electron delivers `second-instance` immediately, before `createWindow`
  // has produced anything to show. Preserve that foreground request until the real window reaches
  // `ready-to-show`; otherwise the already-running `--hidden` instance silently consumes it.
  mainWindowShowRequested = true;
  if (startupWindow && !startupWindow.isDestroyed()) {
    if (startupWindow.isMinimized()) startupWindow.restore();
    startupWindow.show();
    startupWindow.focus();
    return;
  }
  if ((!mainWindowReadyToShow && !startupFailed) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShowRequested = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createStartupWindow() {
  const portuguese = /^pt(?:-|$)/i.test(app.getLocale());
  const title = portuguese ? "Abrindo Codex Web GPT" : "Opening Codex Web GPT";
  const detail = portuguese
    ? "Preparando o ambiente local. A interface principal abrirá automaticamente."
    : "Preparing the local environment. The main interface will open automatically.";
  const window = new BrowserWindow({
    width: 560,
    height: 330,
    minWidth: 560,
    minHeight: 330,
    show: false,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: "#101010",
    icon: APP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const html = `<!doctype html><html lang="${portuguese ? "pt-BR" : "en"}"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>${title}</title><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0;background:#101010;color:#f4f4f4;font:14px system-ui,-apple-system,'Segoe UI',sans-serif}
    body{display:grid;place-items:center}.card{width:420px}.mark{width:34px;height:34px;border:1px solid #4b4b4b;border-radius:10px;display:grid;place-items:center;margin-bottom:24px;color:#ddd;font-weight:650}
    h1{margin:0 0 9px;font-size:20px;letter-spacing:-.02em}p{margin:0;color:#9c9c9c;line-height:1.55}.track{height:2px;margin-top:28px;overflow:hidden;background:#2a2a2a;border-radius:2px}.track:after{display:block;width:36%;height:100%;background:#ededed;content:'';animation:move 1.15s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(178%)}}
    </style><body><main class="card"><div class="mark">C</div><h1>${title}</h1><p>${detail}</p><div class="track"></div></main></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.show();
  return window;
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: LAUNCHER_PROFILE.displayName,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // This BrowserWindow owns the ChatGPT WebContentsViews. On Windows the
      // parent renderer can suspend its children when the launcher is hidden or
      // minimized even if each child disables throttling independently.
      backgroundThrottling: false,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    // The title-bar X is a presentation action, never a runtime shutdown. Stopping the
    // Electron browser host disconnects every active Codex Web stream, even when the daemon
    // itself is healthy. Explicit Quit in the tray remains the only destructive exit path.
    if (tray) window.hide();
    else window.minimize();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainWindowReadyToShow = false;
    }
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (mainWindow === window) mainWindowReadyToShow = true;
    if (startupWindow && !startupWindow.isDestroyed()) startupWindow.destroy();
    startupWindow = null;
    if (mainWindowShowRequested) showMainWindow();
    else if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function validateLanguage(value) {
  if (typeof value !== "string" || !Object.hasOwn(languages, value)) {
    throw new Error(`Language must be one of: ${Object.keys(languages).join(", ")}`);
  }
  return value;
}

function validateBrowserInteractionMode(value) {
  if (value !== "automatic" && value !== "manual") {
    throw new Error("Browser interaction mode must be automatic or manual");
  }
  return value;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}

function syncFreshConversationPreference(stateStore, config) {
  const useSavedChats = config?.useSavedChats === true;
  const enabled = config?.experimentalFreshConversationPerTurn === true;
  const current = stateStore.read();
  if (runtimeHost?.currentOperation()) return current;
  if (current.experimentalFreshConversationPerTurn === enabled && current.useSavedChats === useSavedChats) return current;
  // Runtime restarts leave browser views alive. Retire completed chats when their
  // persistence policy changes, including changes made by the CLI.
  const retainedKeys = new Set([...browserHost.turnTabs.values()]
    .filter(tab => tab.status === "ready" && tab.conversationKey
      && (current.useSavedChats !== useSavedChats || tab.interactionMode === "automatic"))
    .map(tab => tab.conversationKey));
  for (const key of retainedKeys) releaseRetainedConversation(browserHost, key);
  const state = stateStore.update({ experimentalFreshConversationPerTurn: enabled, useSavedChats });
  send("launcher:state-changed", state);
  return state;
}

function queueablePreferenceError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /atomic idleness could not be proven|active HTTP turn|active browser turn|another launcher operation is active/i.test(message);
}

function queueFreshConversationPreference(stateStore, enabled) {
  const state = stateStore.update({ pendingFreshConversationPerTurn: enabled === true });
  send("launcher:state-changed", state);
  return state;
}

async function applyPendingFreshConversationPreference({ logger, stateStore }) {
  if (applyingPendingFreshConversation || !runtimeHost || !browserHost) return;
  const desired = stateStore.read().pendingFreshConversationPerTurn;
  if (typeof desired !== "boolean") return;
  if (runtimeHost.currentOperation() || browserHost.activeTraceId || browserHost.currentOperation()) return;
  applyingPendingFreshConversation = true;
  try {
    await runtimeHost.setFreshConversationPerTurn(desired);
    const synced = syncFreshConversationPreference(stateStore, runtimeHost.runtimeConfigSnapshot().config);
    const state = stateStore.update({
      ...synced,
      pendingFreshConversationPerTurn: null,
    });
    logger.info("launcher.pending_preference_applied", {
      preference: "fresh-conversation-per-turn",
      enabled: desired,
    });
    send("launcher:state-changed", state);
  } catch (error) {
    if (queueablePreferenceError(error)) {
      logger.debug("launcher.pending_preference_waiting", {
        preference: "fresh-conversation-per-turn",
      });
      return;
    }
    const state = stateStore.update({ pendingFreshConversationPerTurn: null });
    send("launcher:state-changed", state);
    publishOperation({
      name: "pending-preference",
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    applyingPendingFreshConversation = false;
  }
}

function startPendingPreferenceMonitor({ logger, stateStore }) {
  if (pendingPreferenceTimer) clearInterval(pendingPreferenceTimer);
  const check = () => { void applyPendingFreshConversationPreference({ logger, stateStore }); };
  pendingPreferenceTimer = setInterval(check, 1_000);
  pendingPreferenceTimer.unref?.();
  check();
}

function registerIpc({ logger, stateStore }) {
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);
  handle("launcher:limits", () => limitsController.snapshot());
  handle("launcher:limits-setup", async () => {
    if (runtimeHost.currentOperation()) throw new Error("Finish the current launcher operation before checking Limits.");
    return limitsController.setup(() => browserHost.inspectLimitsPlan());
  });
  handle("launcher:snapshot", async () => ({
    profile: LAUNCHER_PROFILE.kind,
    profilePaths: {
      coreHome: CORE_HOME,
      codexHome: LAUNCHER_PROFILE.codexHome,
      userData: launcherUserData,
    },
    state: syncFreshConversationPreference(stateStore, runtimeHost.runtimeConfigSnapshot().config),
    bundledSkills: {
      available: listBundledSkills(BUNDLED_SKILLS_PATH),
      selected: stateStore.read().bundledSkillSelection,
    },
    browser: browserHost?.snapshot() ?? null,
    connectorName: runtimeHost.browserConnectorName(),
    connectorNames: {
      automatic: runtimeHost.setupConnectorName(),
      manual: "Codex Zero Risk",
    },
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured() ?? false,
    logs: logger.recent(),
    urls: { github: GITHUB_URL, x: X_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
  }));

  handle("launcher:set-language", (_event, language) => {
    const state = stateStore.update({ language: validateLanguage(language) });
    updateTrayMenu(state.language);
    return state;
  });
  handle("launcher:open-social", async (_event, target) => {
    const url = target === "github" ? GITHUB_URL : target === "x" ? X_URL : null;
    if (!url) throw new Error("Unknown social target");
    await openWebUrl(url);
    const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
    return stateStore.update(patch);
  });
  handle("launcher:complete-onboarding", (_event, language, rawInteractionMode) => {
    const current = stateStore.read();
    if (!current.githubOpened || !current.xOpened) throw new Error("Open the GitHub and X pages before continuing");
    if (current.autoStart) setAutostart(app, true);
    const next = stateStore.update({
      language: validateLanguage(language),
      browserInteractionMode: validateBrowserInteractionMode(rawInteractionMode),
      onboardingComplete: true,
    });
    updateTrayMenu(next.language);
    logger.info("launcher.onboarding_completed", {
      language: next.language,
      browserInteractionMode: next.browserInteractionMode,
    });
    return next;
  });

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:browser-bounds", (event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds), event.sender.getZoomFactor());
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal(
    stateStore.read().browserInteractionMode === "automatic",
  ));
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:manual-prompt-copy", (_event, tabId) => browserHost.copyManualPrompt(tabId));
  handle("launcher:manual-prompt-sent", (_event, tabId) => browserHost.confirmManualSent(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login", async () => {
    const browser = await browserHost.openPasskeyLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login-continue", () => runtimeHost.continuePasskeyLogin());
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    if (stateStore.read().browserInteractionMode === "manual") {
      throw new Error("Browser smoke testing is disabled in Zero Risk mode");
    }
    // The packaged app can finish mounting its persisted ChatGPT partition after the
    // startup probe has already published a signed-out snapshot. Recheck at action time
    // so a valid saved session is never blocked by stale renderer state.
    await browserHost.waitForManualOperationIdle();
    const browser = await browserHost.refreshAuthentication();
    if (!browser.authenticated) {
      if (browser.status === "error") throw new Error(browser.message);
      throw new Error("Sign in to ChatGPT before running the browser smoke test");
    }
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  handle("launcher:mcp-verify", async (event) => {
    const operationName = "mcp-verification";
    const activeTraceId = browserHost.activeTraceId;
    logger.info("mcp.verification_requested", {
      activeTraceId,
      launcherFocused: mainWindow?.isFocused() === true,
      rendererFocused: event.sender.isFocused(),
    });
    if (activeTraceId) {
      const report = {
        ok: false,
        checks: [{
          id: "connector",
          status: "error",
          message: "Finish the active Codex task before verifying the ChatGPT connector",
          detail: `Active browser turn: ${activeTraceId}`,
        }],
      };
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message: report.checks[0].message });
      return report;
    }
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = IS_DEV_PROFILE ? await runtimeHost.devDoctor() : await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    if (stateStore.read().browserInteractionMode === "manual") {
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = "Local Zero Risk runtime is healthy; connector selection remains a manual turn step";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          {
            id: "connector",
            status: "warning",
            message: `Select ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} manually for every Zero Risk turn`,
          },
        ],
      };
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = IS_DEV_PROFILE
        ? "DEV harness and connector verified"
        : "Runtime and connector verified";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: report.checks.map((check) => check.id === "connector"
          ? {
              id: "connector",
              status: "ok",
              message: `ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} is available`,
            }
          : check),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return {
        ...report,
        ok: false,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          { id: "connector", status: "error", message },
        ],
      };
    }
  });

  handle("launcher:doctor", () => IS_DEV_PROFILE ? runtimeHost.devDoctor() : runtimeHost.doctor());
  handle("launcher:cancel-turns", () => {
    if (IS_DEV_PROFILE) throw new Error("DEV chat turns are owned by the repository CLI process");
    return runtimeHost.cancelActiveTurns();
  });
  handle("launcher:restore-native-codex", async () => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex integration to restore");
    const copy = nativeCopyFor(stateStore.read().language);
    const fallback = NATIVE_COPY.en;
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [copy.cancel, copy.restore || fallback.restore],
      defaultId: 0,
      cancelId: 0,
      title: copy.restoreTitle || fallback.restoreTitle,
      message: copy.restoreMessage || fallback.restoreMessage,
      detail: copy.restoreDetail || fallback.restoreDetail,
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    await runtimeHost.restoreNativeCodex();
    const state = stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:uninstall-integration", async () => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex integration to remove");
    const copy = nativeCopyFor(stateStore.read().language);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [copy.cancel, copy.remove],
      defaultId: 0,
      cancelId: 0,
      title: copy.removeTitle,
      message: copy.removeMessage,
      detail: copy.removeDetail,
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
    }
    const state = stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
      codexRestartRequired: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      experimentalSkillAttachments: false,
      experimentalContextAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useSavedChats: false,
      zeroRiskProEnabled: false,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:setup-core", async (_event, input = {}) => {
    const setupState = stateStore.read();
    const availableBundledSkills = listBundledSkills(BUNDLED_SKILLS_PATH);
    const selectedBundledSkills = validateBundledSkillSelection(
      input?.bundledSkills ?? setupState.bundledSkillSelection ?? availableBundledSkills,
      availableBundledSkills,
    );
    const smokeProved = smokePassedThisSession || smokePassedForCurrentVersion(setupState);
    if (setupState.browserInteractionMode === "automatic" && !smokeProved) {
      const browser = await browserHost.probeAuthentication();
      if (!browser.authenticated) {
        if (browser.status === "error") throw new Error(browser.message);
        throw new Error(
          IS_DEV_PROFILE
            ? "Sign in to the isolated DEV ChatGPT profile before configuring the harness"
            : "Sign in to ChatGPT before installing the Codex integration",
        );
      }
    }
    if (setupState.browserInteractionMode === "automatic"
      && !setupState.coreSetupComplete
      && !smokeProved) {
      throw new Error(
        IS_DEV_PROFILE
          ? "Run the browser smoke test before configuring the DEV harness"
          : "Run the browser smoke test before installing the Codex integration",
      );
    }
    const result = IS_DEV_PROFILE ? await runtimeHost.setupDevCore() : await runtimeHost.setupCore();
    const bundledSkillResult = syncBundledSkills({
      sourceRoot: BUNDLED_SKILLS_PATH,
      codexHome: LAUNCHER_PROFILE.codexHome,
      selectedSkills: selectedBundledSkills,
    });
    stateStore.update({
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      experimentalBiggerContext: runtimeHost.runtimeConfigSnapshot().config?.experimentalBiggerContext === true,
      experimentalSkillAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalSkillAttachments === true,
      experimentalContextAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalContextAttachments === true,
      experimentalFreshConversationPerTurn: runtimeHost.runtimeConfigSnapshot().config?.experimentalFreshConversationPerTurn === true,
      useSavedChats: runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
      bundledSkillSelection: selectedBundledSkills,
      ...(result.mode === "full" ? {
        mcpRuntimeInstalled: true,
        mcpSetupComplete: false,
        mcpGuideStep: 2,
      } : {
        mcpSetupComplete: false,
        mcpRuntimeInstalled: false,
        mcpGuideStep: 0,
      }),
    });
    await browserHost.returnToIdle().catch((error) => {
      logger.warn("browser.idle_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout, restartRequired: !IS_DEV_PROFILE, bundledSkills: bundledSkillResult };
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    // The Setup surface may be opened while a slow smoke test is still waiting for
    // ChatGPT's complete answer. Queue MCP setup behind that owned browser operation
    // instead of racing session inspection against it and returning "already busy".
    await browserHost.waitForManualOperationIdle();
    const currentMode = stateStore.read().browserInteractionMode;
    const interactionMode = input?.interactionMode === undefined
      ? currentMode
      : validateBrowserInteractionMode(input.interactionMode);
    const interactionModeChange = interactionMode !== currentMode;
    const setup = IS_DEV_PROFILE
      ? runtimeHost.setupDevMcp.bind(runtimeHost)
      : runtimeHost.setupMcp.bind(runtimeHost);
    const runSetup = afterRuntimeReady => setup({
      tunnelId: typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
      replace: input?.replace === true,
      interactionMode,
    }, afterRuntimeReady);
    if (!interactionModeChange && interactionMode === "automatic") await browserHost.reveal();
    const result = interactionModeChange
      ? await browserHost.withInteractionModeChange(interactionMode, runSetup)
      : await runSetup();
    const state = stateStore.update({
      browserInteractionMode: interactionMode,
      ...(interactionMode === "manual" ? { experimentalBiggerContext: false, experimentalSkillAttachments: false, experimentalContextAttachments: false } : {}),
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      experimentalFreshConversationPerTurn: runtimeHost.runtimeConfigSnapshot().config?.experimentalFreshConversationPerTurn === true,
      useSavedChats: runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE,
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (interactionModeChange) send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("The isolated DEV launcher is started explicitly from the repository CLI");
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: stateStore.update({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:bigger-context", async (_event, enabled) => {
    const result = await runtimeHost.setBiggerContext(enabled === true);
    const state = stateStore.update({
      experimentalBiggerContext: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:skill-attachments", async (_event, enabled) => {
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      throw new Error("Finish or cancel active ChatGPT turns before changing Skills as files");
    }
    const result = await runtimeHost.setSkillAttachments(enabled === true);
    const state = stateStore.update({ experimentalSkillAttachments: result.enabled });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:fresh-conversation-per-turn", async (_event, enabled) => {
    const desired = enabled === true;
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      return queueFreshConversationPreference(stateStore, desired);
    }
    try {
      await runtimeHost.setFreshConversationPerTurn(desired);
    } catch (error) {
      if (queueablePreferenceError(error)) return queueFreshConversationPreference(stateStore, desired);
      throw error;
    }
    const synced = syncFreshConversationPreference(stateStore, runtimeHost.runtimeConfigSnapshot().config);
    const state = stateStore.update({ ...synced, pendingFreshConversationPerTurn: null });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:context-attachments", async (_event, enabled) => {
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      throw new Error("Finish or cancel active ChatGPT turns before changing large context attachments");
    }
    const result = await runtimeHost.setContextAttachments(enabled === true);
    const state = stateStore.update({ experimentalContextAttachments: result.enabled });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:fresh-conversation-per-turn-cancel", () => {
    if (applyingPendingFreshConversation) {
      throw new Error("The queued preference is already being applied");
    }
    const state = stateStore.update({ pendingFreshConversationPerTurn: null });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:use-saved-chats", async (_event, enabled) => {
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      throw new Error("Finish or cancel active ChatGPT turns before changing saved chats");
    }
    await runtimeHost.setUseSavedChats(enabled);
    return syncFreshConversationPreference(stateStore, runtimeHost.runtimeConfigSnapshot().config);
  });
  handle("launcher:zero-risk-pro", async (_event, enabled) => {
    const browserOperation = browserHost.currentOperation();
    if (browserHost.activeTraceId || browserOperation) {
      throw new Error(
        browserHost.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing Zero Risk model profiles"
          : `Finish ${browserOperation} before changing Zero Risk model profiles`,
      );
    }
    const result = await runtimeHost.setZeroRiskPro(enabled === true);
    const state = stateStore.update({
      zeroRiskProEnabled: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE,
      codexRestartRequired: !IS_DEV_PROFILE,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:browser-interaction-mode", async (_event, rawMode) => {
    const mode = validateBrowserInteractionMode(rawMode);
    const current = stateStore.read();
    if (current.browserInteractionMode === mode) {
      return { state: current, credentialsRequired: false, targetMode: mode };
    }
    const browserOperation = browserHost.currentOperation();
    if (browserHost.activeTraceId || browserOperation) {
      throw new Error(
        browserHost.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing browser interaction mode"
          : `Finish ${browserOperation} before changing browser interaction mode`,
      );
    }
    if (!runtimeHost.mcpCredentialsConfigured(mode)) {
      return { state: current, credentialsRequired: true, targetMode: mode };
    }
    const result = await browserHost.withInteractionModeChange(
      mode,
      afterRuntimeReady => runtimeHost.setBrowserInteractionMode(mode, afterRuntimeReady),
    );
    const state = stateStore.update({
      browserInteractionMode: mode,
      experimentalFreshConversationPerTurn: runtimeHost.runtimeConfigSnapshot().config?.experimentalFreshConversationPerTurn === true,
      useSavedChats: runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
      ...(mode === "manual" ? { experimentalBiggerContext: false, experimentalSkillAttachments: false, experimentalContextAttachments: false } : {}),
      ...(result.configured ? {
        codexCatalogVerified: IS_DEV_PROFILE,
        codexRestartRequired: !IS_DEV_PROFILE,
      } : {}),
    });
    send("launcher:state-changed", state);
    send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE && result.configured) startCatalogVerificationMonitor({ logger, stateStore });
    return { state, credentialsRequired: false, targetMode: mode };
  });
  handle("launcher:set-preference", (_event, key, value) => {
    const ordinary = key === "keepRunningOnClose" || key === "showBrowserDuringTurns";
    if (!ordinary) throw new Error("Unknown preference");
    return stateStore.update({ [key]: value === true });
  });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:export-logs", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const copy = nativeCopyFor(stateStore.read().language);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: copy.exportDiagnostics,
      defaultPath: path.join(app.getPath("documents"), `codex-web-gpt-diagnostics-${date}.jsonl`),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const recordCount = exportSanitizedLogs({
      filePath: logger.filePath,
      destinationPath: result.filePath,
    });
    logger.info("launcher.logs_exported", { recordCount });
    return result.filePath;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    const launch = await updateController.beginInstall();
    const result = await requestQuit();
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting Codex Web GPT`);
    }
    // Codex routes every model request through the local bridge while the launcher is
    // active. Restore the user's previous route before stopping that bridge so an
    // intentional launcher exit cannot strand existing Codex tasks in reconnect loops.
    await runtimeHost?.restoreBridgeRoute("launcher-quit");
    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    if (pendingPreferenceTimer) clearInterval(pendingPreferenceTimer);
    pendingPreferenceTimer = null;
    stopCatalogVerificationMonitor();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

async function start() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  app.on("activate", () => showMainWindow());

  cdpPort = await findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  // Automatic ChatGPT turns must continue rendering while the launcher is minimized or covered.
  // Chromium otherwise pauses background timers and occluded renderers on Windows, which makes a
  // healthy web response look stalled to the bridge and can close the Codex stream prematurely.
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  await app.whenReady();

  const startupStartedAt = Date.now();
  const preflightHidden = process.argv.includes("--hidden");
  if (!preflightHidden) startupWindow = await createStartupWindow();
  const runtimeValidationStartedAt = Date.now();
  await waitForPackagedRuntimeSource({ app, resourcesPath: process.resourcesPath });
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };
  installedRuntimeRoot = runtimeRootProvider();
  const runtimeValidationMs = Date.now() - runtimeValidationStartedAt;

  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  const availableBundledSkills = listBundledSkills(BUNDLED_SKILLS_PATH);
  const initialState = stateStore.read();
  const migratedBundledSkillSelection = initialState.bundledSkillSelection === null
    ? (initialState.coreSetupComplete === true ? availableBundledSkills : null)
    : initialState.bundledSkillSelection.filter(skill => availableBundledSkills.includes(skill));
  let bundledSkills = { available: availableBundledSkills, selected: migratedBundledSkillSelection, installed: [], removed: [], preserved: [] };
  let bundledSkillsStartupError = null;
  if (migratedBundledSkillSelection !== null) {
    try {
      bundledSkills = syncBundledSkills({
        sourceRoot: BUNDLED_SKILLS_PATH,
        codexHome: LAUNCHER_PROFILE.codexHome,
        selectedSkills: migratedBundledSkillSelection,
      });
    } catch (error) {
      bundledSkillsStartupError = error instanceof Error ? error.message : String(error);
    }
  }
  if (migratedBundledSkillSelection !== null
    && JSON.stringify(initialState.bundledSkillSelection) !== JSON.stringify(migratedBundledSkillSelection)) {
    stateStore.update({ bundledSkillSelection: migratedBundledSkillSelection });
  }
  const retainedConversationStore = createRetainedConversationStore(
    path.join(app.getPath("userData"), "retained-conversations.json"),
  );
  limitsController = new LimitsController(path.join(app.getPath("userData"), "limits.json"), {
    getInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  if (IS_DEV_PROFILE && !stateStore.read().onboardingComplete) {
    stateStore.update({
      language: stateStore.read().language || "en",
      onboardingComplete: true,
      autoStart: false,
    });
  }
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = IS_DEV_PROFILE ? { supported: false, enabled: false } : getAutostart(app);
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  if (bundledSkillsStartupError) {
    logger.warn("launcher.bundled_skills_sync_failed", { message: bundledSkillsStartupError });
  }
  logger.info("launcher.startup_preflight_completed", {
    runtimeValidationMs,
    elapsedMs: Date.now() - startupStartedAt,
    packaged: app.isPackaged,
    bundledSkills,
  });
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  // The launcher UI is intentionally dark.  Keep Chromium on the same scheme from
  // process start so an OS-light preference cannot flash a white document before the
  // renderer and ChatGPT styles hydrate.
  nativeTheme.themeSource = "dark";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => syncFreshConversationPreference(stateStore, runtimeHost.runtimeConfigSnapshot().config),
    resolveProxy: url => session.fromPartition(LAUNCHER_PROFILE.browserPartition).resolveProxy(url),
    limits: limitsController,
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    onConfigRead: config => {
      // Setup may read an intermediate config before rollback. The setting IPC commits
      // its change only after the existing setup transaction has succeeded.
      if (browserHost && !runtimeHost?.currentOperation()) syncFreshConversationPreference(stateStore, config);
    },
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  const configuredInteractionMode = runtimeHost.runtimeConfigSnapshot().config?.browserInteractionMode;
  if ((configuredInteractionMode === "automatic" || configuredInteractionMode === "manual")
    && stateStore.read().browserInteractionMode !== configuredInteractionMode) {
    stateStore.update({ browserInteractionMode: configuredInteractionMode });
  }
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    cancelTurn: IS_DEV_PROFILE ? undefined : (traceId, reason) => runtimeSupervisor.cancelBrowserTurn(traceId, reason),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    // A fresh launcher has no runtime config until the first setup completes.  Prefer the
    // user-approved saved-chat fallback during that bootstrap; once a config exists, honor
    // its explicit saved/temporary choice normally.
    getUseSavedChats: () => runtimeHost.runtimeConfigSnapshot().config?.useSavedChats !== false,
    retainedConversationStore,
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    loginWithPasskey: () => runtimeHost.capturePasskeyLogin(),
    partition: LAUNCHER_PROFILE.browserPartition,
    profile: LAUNCHER_PROFILE.kind,
    publishState: (state) => send("launcher:browser-state", state),
    showWindow: showMainWindow,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  await browserHost.ready();
  startPendingPreferenceMonitor({ logger, stateStore });
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && !IS_DEV_PROFILE,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  registerIpc({ logger, stateStore });
  const trayAvailable = createTray(logger, stateStore.read().language);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  let startupAuthenticationRefresh = Promise.resolve();
  if (!launcherSmokeTest && stateStore.read().browserInteractionMode === "automatic") {
    startupAuthenticationRefresh = browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        ...navigationErrorForLog(error),
      });
    });
  }
  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
    })}\n`);
    browserHost.destroy();
    await browserControl.close();
    mainWindow.destroy();
    app.quit();
    return;
  }
  if (IS_DEV_PROFILE) {
    let config = null;
    try {
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("dev_profile.config_invalid", { message });
      publishOperation({ name: "dev-profile", status: "failed", message });
    }
    const state = stateStore.update({
      coreSetupComplete: Boolean(config),
      codexCatalogVerified: Boolean(config),
      mcpRuntimeInstalled: config?.mode === "full",
      ...(config?.mode !== "full" ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
      codexRestartRequired: false,
      autoStart: false,
      experimentalBiggerContext: config?.experimentalBiggerContext === true,
      experimentalSkillAttachments: config?.experimentalSkillAttachments === true,
      experimentalContextAttachments: config?.experimentalContextAttachments === true,
      experimentalFreshConversationPerTurn: config?.experimentalFreshConversationPerTurn === true,
      useSavedChats: config?.useSavedChats === true,
      zeroRiskProEnabled: config?.zeroRiskProEnabled === true,
    });
    send("launcher:state-changed", state);
    logger.info("dev_profile.ready", {
      configured: Boolean(config),
      mode: config?.mode || null,
      coreHome: CORE_HOME,
      userData: launcherUserData,
    });
    if (config?.mode === "full") {
      void startupAuthenticationRefresh.then(() => runtimeSupervisor.startIfConfigured()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("dev_profile.runtime_start_failed", { message });
        const failed = stateStore.update({ mcpSetupComplete: false });
        send("launcher:state-changed", failed);
      });
    }
  } else void (async () => {
    await startupAuthenticationRefresh;
    const upgrade = await runtimeHost.upgradeManagedRuntime();
    if (upgrade.updated) {
      const state = stateStore.update({
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        experimentalBiggerContext: runtimeHost.runtimeConfigSnapshot().config?.experimentalBiggerContext === true,
        experimentalSkillAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalSkillAttachments === true,
        experimentalContextAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalContextAttachments === true,
        experimentalFreshConversationPerTurn: runtimeHost.runtimeConfigSnapshot().config?.experimentalFreshConversationPerTurn === true,
        useSavedChats: runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
        zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
        ...(upgrade.mode === "full" ? {
          mcpRuntimeInstalled: true,
          mcpSetupComplete: false,
          mcpGuideStep: 2,
        } : {
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        }),
      });
      send("launcher:state-changed", state);
      logger.info("runtime.release_upgraded", {
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        mode: upgrade.mode,
        connectorMigrated: upgrade.connectorMigrated,
      });
    }
    const configuredRuntime = runtimeHost.runtimeConfigSnapshot();
    if (configuredRuntime.configured) {
      const enabled = configuredRuntime.config?.experimentalBiggerContext === true;
      const experimentalSkillAttachments = configuredRuntime.config?.experimentalSkillAttachments === true;
      const experimentalContextAttachments = configuredRuntime.config?.experimentalContextAttachments === true;
      const experimentalFreshConversationPerTurn = configuredRuntime.config?.experimentalFreshConversationPerTurn === true;
      const useSavedChats = configuredRuntime.config?.useSavedChats === true;
      const zeroRiskProEnabled = configuredRuntime.config?.zeroRiskProEnabled === true;
      const saved = stateStore.read();
      if (saved.experimentalSkillAttachments !== experimentalSkillAttachments
        || saved.experimentalContextAttachments !== experimentalContextAttachments
        || saved.experimentalFreshConversationPerTurn !== experimentalFreshConversationPerTurn
        || saved.useSavedChats !== useSavedChats
        || saved.experimentalBiggerContext !== enabled
        || saved.zeroRiskProEnabled !== zeroRiskProEnabled) {
        const state = stateStore.update({ experimentalBiggerContext: enabled, experimentalSkillAttachments, experimentalContextAttachments, experimentalFreshConversationPerTurn, useSavedChats, zeroRiskProEnabled });
        send("launcher:state-changed", state);
      }
    }
    const runtime = await runtimeSupervisor.startIfConfigured();
    if (runtime.status !== "ready") return runtime;
    const route = await runtimeHost.connectBridgeRoute();
    return { ...runtime, bridgeRouteChanged: route.changed === true };
  })().then(async (runtime) => {
    if (runtime.status === "ready") {
      const config = runtimeSupervisor.readConfig();
      const current = stateStore.read();
      const patch = {
        coreSetupComplete: true,
        mcpRuntimeInstalled: config.mode === "full",
        experimentalBiggerContext: config.experimentalBiggerContext === true,
        experimentalSkillAttachments: config.experimentalSkillAttachments === true,
        experimentalContextAttachments: config.experimentalContextAttachments === true,
        experimentalFreshConversationPerTurn: config.experimentalFreshConversationPerTurn === true,
        useSavedChats: config.useSavedChats === true,
        zeroRiskProEnabled: config.zeroRiskProEnabled === true,
        ...(runtime.bridgeRouteChanged ? {
          codexCatalogVerified: false,
          codexRestartRequired: true,
        } : {}),
        ...(config.mode === "browser-only" ? {
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        } : {}),
      };
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        const state = stateStore.update(patch);
        send("launcher:state-changed", state);
      }
      startCatalogVerificationMonitor({ logger, stateStore });
      return;
    }
    if (runtime.status === "not-configured") {
      const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
      const current = stateStore.read();
      if (current.coreSetupComplete || current.mcpRuntimeInstalled || current.mcpSetupComplete) {
        const state = stateStore.update({
          coreSetupComplete: false,
          codexCatalogVerified: false,
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        });
        send("launcher:state-changed", state);
      }
      if (routeRecovery.error) {
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: `Local runtime is not configured; restoring the previous Codex route also failed: ${routeRecovery.error}`,
        });
      }
      return;
    }
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    if (runtime.status === "external" || runtime.status === "needs-setup") {
      const detail = runtime.detail || (
        runtime.status === "external"
          ? "Another process owns the configured Codex Web GPT runtime"
          : "The installed runtime configuration must be repaired from Setup"
      );
      publishOperation({
        name: "runtime-start",
        status: "failed",
        message: routeRecovery.error
          ? `${detail}; restoring the previous Codex route also failed: ${routeRecovery.error}`
          : routeRecovery.restored
            ? `${detail}; the previous Codex route was restored, restart Codex once`
            : detail,
      });
    }
  }).catch(async (error) => {
    const primary = error instanceof Error ? error.message : String(error);
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const message = routeRecovery.error
      ? `${primary}; restoring the previous Codex route also failed: ${routeRecovery.error}`
      : routeRecovery.restored
        ? `${primary}; the previous Codex route was restored, restart Codex once`
        : primary;
    logger.error("runtime.startup_failed", { message });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    publishOperation({ name: "runtime-start", status: "failed", message });
  });

  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch(async (error) => {
  startupFailed = true;
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    // Browser bootstrap can fail before the renderer is loaded. Keep the error reachable
    // through the existing instance, and release browser resources before a user retry.
    const cleanupErrors = [];
    try { browserHost?.destroy(); } catch (caught) { cleanupErrors.push(String(caught)); }
    try { await browserControl?.close(); } catch (caught) { cleanupErrors.push(String(caught)); }
    if (process.argv.includes("--launcher-smoke-test")) return;
    await app.whenReady();
    quitting = true;
    showMainWindow();
    const copy = nativeCopyFor(createStateStore(path.join(app.getPath("userData"), "launcher-state.json")).read().language);
    const options = {
      type: "error",
      title: copy.startupTitle,
      message,
      detail: [copy.startupDetail,
        ...cleanupErrors.map(detail => `${copy.startupCleanupFailed}: ${detail}`)].join("\n"),
      buttons: [copy.retry, copy.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      // Internal child commands use the resolved profile. A fresh launcher must instead
      // resolve the original launch environment, especially for the isolated DEV profile.
      for (const [key, value] of Object.entries(launchEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      app.relaunch({ args: process.argv.slice(1).filter(argument => argument !== "--hidden") });
    }
  } finally {
    // A failed dialog or relaunch must not leave a headless single-instance owner behind.
    app.exit(1);
  }
});
