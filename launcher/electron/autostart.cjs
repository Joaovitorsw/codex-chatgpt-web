const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const LINUX_DESKTOP_NAME = "dev.codexwebgpt.launcher.desktop";
const WINDOWS_LOCAL_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_LOCAL_RUN_VALUE = "Codex Web GPT Local Production";

function linuxDesktopPath() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_NAME);
}

function desktopExecArgument(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replace(/["`$\\]/g, "\\$&")}"`;
}

function linuxExecutable(app) {
  const stableLauncher = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE?.trim();
  if (stableLauncher && path.isAbsolute(stableLauncher)) return stableLauncher;
  const appImage = process.env.CODEX_WEB_GPT_APPIMAGE?.trim() || process.env.APPIMAGE?.trim();
  if (appImage && path.isAbsolute(appImage)) return appImage;
  return app.getPath("exe");
}

function linuxDesktopEntry(app, executable = linuxExecutable(app)) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Codex Web GPT
Comment=Start the Codex Web GPT launcher in the background
Exec=${desktopExecArgument(executable)} --hidden
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function linuxAutostartMatches(app) {
  const target = linuxDesktopPath();
  try {
    return fs.readFileSync(target, "utf8") === linuxDesktopEntry(app);
  } catch {
    return false;
  }
}

function requireAutostartState(result, desired) {
  if (result.supported && result.enabled !== Boolean(desired)) {
    throw new Error(`The operating system did not ${desired ? "enable" : "disable"} launcher autostart`);
  }
  return result;
}

function localProductionStartupScript(app) {
  return path.join(path.resolve(app.getAppPath(), ".."), "scripts", "start-local-production-silent.ps1");
}

function supportsLocalProductionAutostart(app) {
  return !app.isPackaged
    && process.platform === "win32"
    && process.env.CODEX_WEB_GPT_LOCAL_PRODUCTION === "1"
    && fs.existsSync(localProductionStartupScript(app));
}

function windowsRegistryExecutable() {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot && path.isAbsolute(systemRoot)) return path.join(systemRoot, "System32", "reg.exe");
  return "C:\\Windows\\System32\\reg.exe";
}

function localProductionAutostartCommand(app) {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${JSON.stringify(localProductionStartupScript(app))}`;
}

function windowsLocalProductionAutostartEnabled() {
  const result = spawnSync(windowsRegistryExecutable(), ["query", WINDOWS_LOCAL_RUN_KEY, "/v", WINDOWS_LOCAL_RUN_VALUE], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function setWindowsLocalProductionAutostart(app, enabled) {
  const args = enabled
    ? ["add", WINDOWS_LOCAL_RUN_KEY, "/v", WINDOWS_LOCAL_RUN_VALUE, "/t", "REG_SZ", "/d", localProductionAutostartCommand(app), "/f"]
    : ["delete", WINDOWS_LOCAL_RUN_KEY, "/v", WINDOWS_LOCAL_RUN_VALUE, "/f"];
  const result = spawnSync(windowsRegistryExecutable(), args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(enabled === false && result.status === 1)) {
    throw new Error(`Windows did not ${enabled ? "register" : "remove"} local Codex Web GPT autostart: ${result.stderr || result.stdout}`);
  }
  return requireAutostartState({ supported: true, enabled: windowsLocalProductionAutostartEnabled() }, enabled);
}

function setAutostart(app, enabled) {
  if (supportsLocalProductionAutostart(app)) return setWindowsLocalProductionAutostart(app, enabled);
  if (!app.isPackaged) return { supported: false, enabled: Boolean(enabled) };
  if (process.platform === "linux") {
    const target = linuxDesktopPath();
    if (enabled) {
      writePrivateFileAtomic(target, linuxDesktopEntry(app));
    } else {
      fs.rmSync(target, { force: true });
    }
    return requireAutostartState({
      supported: true,
      enabled: enabled ? linuxAutostartMatches(app) : false,
    }, enabled);
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: Boolean(enabled),
      args: ["--hidden"],
    });
    return requireAutostartState({
      supported: true,
      enabled: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin === true,
    }, enabled);
  }
  return { supported: false, enabled: false };
}

function getAutostart(app) {
  if (supportsLocalProductionAutostart(app)) {
    return { supported: true, enabled: windowsLocalProductionAutostartEnabled() };
  }
  if (!app.isPackaged) return { supported: false, enabled: false };
  if (process.platform === "linux") {
    return { supported: true, enabled: linuxAutostartMatches(app) };
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return {
      supported: true,
      enabled: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin === true,
    };
  }
  return { supported: false, enabled: false };
}

module.exports = {
  LINUX_DESKTOP_NAME,
  WINDOWS_LOCAL_RUN_KEY,
  WINDOWS_LOCAL_RUN_VALUE,
  getAutostart,
  linuxAutostartMatches,
  linuxDesktopEntry,
  linuxDesktopPath,
  localProductionAutostartCommand,
  localProductionStartupScript,
  requireAutostartState,
  setAutostart,
  supportsLocalProductionAutostart,
};
