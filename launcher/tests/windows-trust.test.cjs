const test = require("node:test");
const assert = require("node:assert/strict");
const { configureWindowsTrust, windowsTrustEnvironment } = require("../electron/windows-trust.cjs");

test("Windows child environments inherit system trust unless the user selected otherwise", () => {
  assert.deepEqual(windowsTrustEnvironment({ PATH: "safe" }, "win32"), {
    PATH: "safe", NODE_USE_SYSTEM_CA: "1",
  });
  assert.deepEqual(windowsTrustEnvironment({ NODE_USE_SYSTEM_CA: "0" }, "win32"), {
    NODE_USE_SYSTEM_CA: "0",
  });
  assert.deepEqual(windowsTrustEnvironment({ PATH: "safe" }, "linux"), { PATH: "safe" });
});

test("Windows main process adds OS certificates without overriding an explicit opt-out", () => {
  const environment = {};
  const configured = [];
  const certificates = {
    getCACertificates: source => source === "default" ? ["bundled"] : ["system"],
    setDefaultCACertificates: values => configured.push(values),
  };
  configureWindowsTrust("win32", environment, certificates);
  assert.equal(environment.NODE_USE_SYSTEM_CA, "1");
  assert.deepEqual(configured, [["bundled", "system"]]);

  const disabled = { NODE_USE_SYSTEM_CA: "0" };
  configureWindowsTrust("win32", disabled, certificates);
  assert.deepEqual(configured, [["bundled", "system"]]);
});
