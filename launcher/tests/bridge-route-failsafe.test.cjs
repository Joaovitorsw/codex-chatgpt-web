const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  STALE_AFTER_MS,
  isLeaseStale,
  readLease,
  writeJsonAtomically,
} = require("../electron/bridge-route-failsafe.cjs");

test("failsafe only considers an armed, valid lease stale after the conservative grace period", () => {
  const lease = { version: 1, armed: true, heartbeatAt: 1_000, runtime: { executable: "bun", args: [] }, bridge: { port: 17841 } };
  assert.equal(isLeaseStale(lease, 1_000 + STALE_AFTER_MS - 1), false);
  assert.equal(isLeaseStale(lease, 1_000 + STALE_AFTER_MS), true);
  assert.equal(readLease(path.join(os.tmpdir(), `missing-lease-${Date.now()}.json`)), null);
});

test("failsafe lease is atomically readable and rejects incomplete lease data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-failsafe-"));
  const leasePath = path.join(root, "lease.json");
  writeJsonAtomically(leasePath, { version: 1, armed: true, heartbeatAt: Date.now(), runtime: { executable: "bun", args: ["run"] }, bridge: { host: "127.0.0.1", port: 17841 } });
  assert.equal(readLease(leasePath).bridge.port, 17841);
  fs.writeFileSync(leasePath, '{"version":1,"armed":true}');
  assert.equal(readLease(leasePath), null);
  fs.rmSync(root, { recursive: true, force: true });
});
