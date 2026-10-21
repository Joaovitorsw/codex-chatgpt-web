const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);

function isDesktopExecutable(executable, platform = process.platform) {
  if (typeof executable !== "string" || /[\r\n\0]/.test(executable)) return false;
  if (platform === "win32") {
    const normalized = path.win32.normalize(executable);
    if (!path.win32.isAbsolute(executable) || normalized !== executable || /codex[ -]web[ -]gpt/i.test(executable)) return false;
    return /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:Codex|ChatGPT)\.exe$/i.test(executable)
      || /\\(?:OpenAI\\Codex|Programs\\Codex)\\Codex\.exe$/i.test(executable);
  }
  if (!path.posix.isAbsolute(executable) || path.posix.normalize(executable) !== executable) return false;
  return platform === "darwin"
    ? /\/Codex\.app\/Contents\/MacOS\/Codex$/.test(executable)
    : /^\/opt\/(?:Codex|codex-desktop)\/codex$/.test(executable);
}

function sameProcess(a, b) {
  return a.pid === b.pid && a.executable === b.executable && a.started === b.started;
}

function powershellPath() {
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function createPlatformDependencies(options) {
  const platform = options.platform || process.platform;
  const run = options.execFile || execute;
  const commandMs = options.commandMs ?? 5000;
  const command = (file, args) => run(file, args, { timeout: commandMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false });
  const ps = script => command(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script]);
  const exists = options.isFile || (async file => { try { return (await fs.stat(file)).isFile(); } catch { return false; } });
  return {
    async inventory() {
      if (platform === "win32") {
        const { stdout } = await ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress");
        const parsed = JSON.parse(stdout.trim() || "[]");
        return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(p => ({
          pid: p.ProcessId, ppid: p.ParentProcessId, executable: p.ExecutablePath,
          started: p.CreationDate, commandLine: p.CommandLine,
        }));
      }
      const { stdout } = await command("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="]);
      return Promise.all(stdout.trim().split("\n").filter(Boolean).map(async line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
        if (!match) throw new Error("Cannot safely parse process inventory");
        const pid = Number(match[1]);
        let executable = match[4];
        if (platform === "linux") {
          try { executable = await fs.readlink(`/proc/${pid}/exe`); } catch { executable = ""; }
        }
        return { pid, ppid: Number(match[2]), started: match[3], executable };
      }));
    },
    async discoverInstalled() {
      if (platform === "win32") {
        const local = process.env.LOCALAPPDATA;
        const candidate = local && path.win32.join(local, "OpenAI", "Codex", "Codex.exe");
        if (candidate && await exists(candidate)) return { executable: candidate, args: [] };
        const { stdout } = await ps("@(Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress");
        const locations = JSON.parse(stdout.trim() || "[]");
        for (const location of Array.isArray(locations) ? locations : [locations]) {
          if (typeof location !== "string") continue;
          for (const name of ["Codex.exe", "ChatGPT.exe"]) {
            const file = path.win32.join(location, "app", name);
            if (isDesktopExecutable(file, platform) && await exists(file)) return { executable: file, args: [] };
          }
        }
        return null;
      }
      const candidates = platform === "darwin"
        ? ["/Applications/Codex.app/Contents/MacOS/Codex", path.join(process.env.HOME || "/", "Applications/Codex.app/Contents/MacOS/Codex")]
        : ["/opt/Codex/codex", "/opt/codex-desktop/codex"];
      for (const executable of candidates) {
        if (await exists(executable)) return { executable, args: [] };
      }
      return null;
    },
    async gracefulClose(target) {
      if (platform === "win32") {
        await ps(`$p = Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`);
      } else {
        try { process.kill(target.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    },
    async forceClose(target) {
      if (platform === "win32") {
        await command(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(target.pid), "/T", "/F"]);
      } else {
        try { process.kill(target.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    },
    launch(info) {
      return new Promise((resolve, reject) => {
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const child = (options.spawn || spawn)(info.executable, info.args, { detached: true, stdio: "ignore", windowsHide: false, shell: false, env: environment });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
    },
  };
}

/** Inventory rows: {pid, ppid, executable, started, commandLine?}.
 * All OS operations are injectable promises. prepare -> close -> reopen is a single-use
 * snapshot; withRestart serializes the transaction and restores on every failure.
 */
class CodexDesktopLifecycle {
  constructor(options = {}) {
    Object.assign(this, createPlatformDependencies(options), options);
    this.platform = options.platform || process.platform;
    this.selfPid = options.selfPid ?? process.pid;
    this.graceMs = options.graceMs ?? 5000;
    this.forceMs = options.forceMs ?? 5000;
    this.pollMs = options.pollMs ?? 100;
    this.commandMs = options.commandMs ?? 5000;
    for (const key of ["graceMs", "forceMs", "pollMs", "commandMs"]) {
      if (!Number.isFinite(this[key]) || this[key] <= 0) throw new Error(`Invalid ${key}`);
    }
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.busy = false;
    this.prepared = false;
  }

  async bounded(operation) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex desktop process operation timed out")), this.commandMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  desktops(rows) {
    return rows.filter(p => Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid !== this.selfPid
      && p.started && isDesktopExecutable(p.executable, this.platform));
  }

  async prepare() {
    const rows = await this.bounded(() => this.inventory());
    const desktops = this.desktops(rows);
    const ids = new Set(desktops.map(p => p.pid));
    this.roots = desktops.filter(p => !ids.has(p.ppid));
    this.targets = [...desktops];
    // Retain descendants, including helper executables, before roots can exit.
    const tracked = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of rows) {
        if (tracked.has(p.ppid) && !tracked.has(p.pid) && p.pid !== this.selfPid
          && Number.isSafeInteger(p.pid) && p.pid > 0 && p.executable && p.started) {
          tracked.add(p.pid); this.targets.push(p); changed = true;
        }
      }
    }
    const info = this.roots[0] ? { executable: this.roots[0].executable, args: [] }
      : await this.bounded(() => this.discoverInstalled());
    if (!info || !isDesktopExecutable(info.executable, this.platform)) throw new Error("No verified installed Codex desktop executable found");
    this.launchInfo = { executable: info.executable, args: [] };
    this.prepared = true;
    this.reopened = false;
    return { runningCount: this.roots.length, executable: info.executable };
  }

  async remaining() {
    const rows = await this.bounded(() => this.inventory());
    return this.targets.filter(target => rows.some(p => sameProcess(p, target)));
  }

  async waitForExit(duration) {
    // Both elapsed time and iteration count bound waits, including injected clocks.
    const deadline = Date.now() + duration;
    for (let attempt = 0; attempt <= Math.ceil(duration / this.pollMs); attempt++) {
      const remaining = await this.remaining();
      if (!remaining.length || Date.now() >= deadline || attempt === Math.ceil(duration / this.pollMs)) return remaining;
      await this.bounded(() => this.sleep(Math.min(this.pollMs, duration)));
    }
    return [];
  }

  async signal(targets, method) {
    const results = await Promise.allSettled(targets.map(async target => {
      if (!(await this.remaining()).some(p => sameProcess(p, target))) return;
      try { await this.bounded(() => this[method](target)); }
      catch (error) {
        if (method === "forceClose" && (await this.remaining()).some(p => sameProcess(p, target))) throw error;
        this.logger?.warn?.(`Codex desktop ${method}: ${error.message}`);
      }
    }));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async close() {
    if (!this.prepared) throw new Error("Call prepare before close");
    await this.signal(this.roots, "gracefulClose");
    const survivors = await this.waitForExit(this.graceMs);
    const survivorIds = new Set(survivors.map(p => p.pid));
    await this.signal(survivors.filter(p => !survivorIds.has(p.ppid)), "forceClose");
    if ((await this.waitForExit(this.forceMs)).length) throw new Error("Codex desktop processes still running after bounded shutdown");
    if (this.desktops(await this.bounded(() => this.inventory())).length) throw new Error("Codex desktop still running: a new instance appeared during shutdown");
  }

  async reopen() {
    if (!this.prepared || this.reopened) return;
    const running = this.desktops(await this.bounded(() => this.inventory()));
    if (!running.some(process => !/--type(?:=|\s)/i.test(process.commandLine || ""))) {
      await this.bounded(() => this.launch(this.launchInfo));
    }
    this.reopened = true;
  }

  async withRestart(operation) {
    if (this.busy) throw new Error("Codex desktop restart already in progress");
    this.busy = true;
    this.prepared = false;
    let result;
    let failure;
    try {
      await this.prepare();
      await this.close();
      result = await operation();
    } catch (error) { failure = error; }
    try { await this.reopen(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Codex setup and desktop recovery failed") : error; }
    finally { this.busy = false; }
    if (failure) throw failure;
    return result;
  }
}

function createCodexDesktopLifecycle(options) { return new CodexDesktopLifecycle(options); }

module.exports = { createCodexDesktopLifecycle, CodexDesktopLifecycle, isDesktopExecutable };
