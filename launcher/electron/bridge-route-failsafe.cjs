const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HEARTBEAT_INTERVAL_MS = 3_000;
const STALE_AFTER_MS = 18_000;
const POLL_INTERVAL_MS = 2_000;
const REQUIRED_UNREACHABLE_CHECKS = 2;

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function readLease(leasePath) {
  try {
    const value = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    if (!value || value.version !== 1 || value.armed !== true || !Number.isFinite(value.heartbeatAt)) return null;
    if (!value.runtime || typeof value.runtime.executable !== "string" || !Array.isArray(value.runtime.args)) return null;
    if (!value.bridge || !Number.isInteger(value.bridge.port)) return null;
    return value;
  } catch {
    return null;
  }
}

function isLeaseStale(lease, now = Date.now()) {
  return now - lease.heartbeatAt >= STALE_AFTER_MS;
}

function probeBridge({ host = "127.0.0.1", port }, timeoutMs = 1_500) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = reachable => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function restoreNativeRoute(lease) {
  const result = spawnSync(lease.runtime.executable, [...lease.runtime.args, "route", "disconnect"], {
    cwd: lease.runtime.cwd || process.cwd(),
    env: { ...process.env, ...(lease.runtime.env || {}) },
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    ok: !result.error && result.status === 0,
    detail: result.error?.message || result.stderr || result.stdout || `exit ${result.status}`,
  };
}

function startBridgeRouteFailsafe({ leasePath, logger = null }) {
  let heartbeatTimer = null;
  let child = null;
  let armed = false;

  const arm = ({ runtime, bridge = { host: "127.0.0.1", port: 17841 } }) => {
    if (armed) return;
    const lease = {
      version: 1,
      armed: true,
      heartbeatAt: Date.now(),
      runtime,
      bridge,
    };
    writeJsonAtomically(leasePath, lease);
    heartbeatTimer = setInterval(() => {
      const current = readLease(leasePath);
      if (!current) return;
      try {
        writeJsonAtomically(leasePath, { ...current, heartbeatAt: Date.now() });
      } catch (error) {
        logger?.warn?.("bridge_failsafe.heartbeat_failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    child = spawn(process.execPath, [__filename, "--watch", leasePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.unref();
    armed = true;
    logger?.info?.("bridge_failsafe.armed", { leasePath, bridge });
  };

  const disarm = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    armed = false;
    try { fs.rmSync(leasePath, { force: true }); } catch {}
    logger?.info?.("bridge_failsafe.disarmed", { leasePath });
  };

  return { arm, disarm, isArmed: () => armed };
}

async function watch(leasePath) {
  let unreachableChecks = 0;
  for (;;) {
    const lease = readLease(leasePath);
    if (!lease) return;
    if (!isLeaseStale(lease)) {
      unreachableChecks = 0;
    } else if (await probeBridge(lease.bridge)) {
      unreachableChecks = 0;
    } else {
      unreachableChecks += 1;
      if (unreachableChecks >= REQUIRED_UNREACHABLE_CHECKS) {
        const restored = restoreNativeRoute(lease);
        if (restored.ok) {
          try { fs.rmSync(leasePath, { force: true }); } catch {}
        }
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (require.main === module && process.argv[2] === "--watch" && process.argv[3]) {
  void watch(process.argv[3]).catch(() => process.exitCode = 1);
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
  REQUIRED_UNREACHABLE_CHECKS,
  STALE_AFTER_MS,
  isLeaseStale,
  readLease,
  restoreNativeRoute,
  startBridgeRouteFailsafe,
  writeJsonAtomically,
};
