const test = require("node:test");
const assert = require("node:assert/strict");
const { createCodexDesktopLifecycle, CodexDesktopLifecycle, isDesktopExecutable } = require("../electron/codex-desktop.cjs");

test("Windows Store Codex is recognized when its desktop executable is ChatGPT.exe", () => {
  assert.equal(isDesktopExecutable("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe", "win32"), true);
  assert.equal(isDesktopExecutable("C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_26_x64__publisher\\app\\ChatGPT.exe", "win32"), false);
});

test("a surviving renderer does not suppress reopening after a shutdown failure", async () => {
  const f = fixture([row(10)]);
  f.lifecycle.close = async () => {
    f.setInventory([{ ...row(11, 10), commandLine: "ChatGPT.exe --type=renderer" }]);
    throw new Error("shutdown failed");
  };
  await assert.rejects(f.lifecycle.withRestart(async () => {}), /shutdown failed/);
  assert.equal(f.calls.filter(call => call[0] === "launch").length, 1);
});

const executable = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc\\app\\Codex.exe";
const row = (pid, ppid = 1, exe = executable) => ({ pid, ppid, executable: exe, started: `start-${pid}` });
function fixture(initial = [row(10), row(11, 10), row(20)]) {
  let inventory = initial;
  const calls = [];
  const lifecycle = new CodexDesktopLifecycle({
    platform: "win32", selfPid: 999, graceMs: 2, forceMs: 2, pollMs: 1,
    inventory: async () => inventory,
    discoverInstalled: async () => null,
    sleep: async () => {},
    gracefulClose: async process => calls.push(["close", process.pid]),
    forceClose: async process => { calls.push(["force", process.pid]); inventory = inventory.filter(p => p.pid !== process.pid && p.ppid !== process.pid); },
    launch: async info => calls.push(["launch", info]),
  });
  return { lifecycle, calls, setInventory: value => { inventory = value; } };
}

test("identity requires a desktop installation path and excludes CLI and launcher", () => {
  assert.equal(isDesktopExecutable(executable, "win32"), true);
  for (const exe of ["C:\\tools\\codex.exe", "C:\\bun.exe", "C:\\Codex Web GPT\\Codex.exe", "Codex.exe", "C:\\Codex\\..\\other\\Codex.exe"]) {
    assert.equal(isDesktopExecutable(exe, "win32"), false, exe);
  }
  assert.equal(isDesktopExecutable("/Applications/Codex.app/Contents/MacOS/Codex", "darwin"), true);
  assert.equal(isDesktopExecutable("/usr/bin/codex", "linux"), false);
  assert.equal(isDesktopExecutable("/opt/Codex/codex", "linux"), true);
});

test("closes every desktop root, forces bounded trees, and reopens only one", async () => {
  const { lifecycle, calls } = fixture();
  assert.equal(await lifecycle.withRestart(async () => { calls.push(["setup"]); return 42; }), 42);
  assert.deepEqual(calls.map(c => c[0]), ["close", "close", "force", "force", "setup", "launch"]);
  assert.deepEqual(calls.filter(c => c[0] === "force").map(c => c[1]), [10, 20]);
  assert.deepEqual(calls.at(-1)[1], { executable, args: [] });
});

test("does not force a graceful exit and rejects missing installations before setup", async () => {
  const f = fixture([row(10)]);
  f.lifecycle.gracefulClose = async () => f.setInventory([]);
  await f.lifecycle.withRestart(async () => {});
  assert.deepEqual(f.calls.map(c => c[0]), ["launch"]);
  const absent = fixture([row(30, 1, "C:\\bun.exe")]);
  await assert.rejects(absent.lifecycle.withRestart(async () => assert.fail("must not run")), /No verified installed/);
  assert.deepEqual(absent.calls, []);
});

test("factory reopens a verified installed desktop even when initially absent", async () => {
  const f = fixture([]);
  f.lifecycle.discoverInstalled = async () => ({ executable, args: ["untrusted"] });
  assert.equal(typeof createCodexDesktopLifecycle({}).withRestart, "function");
  await f.lifecycle.withRestart(async () => 1);
  assert.deepEqual(f.calls, [["launch", { executable, args: [] }]]);
});

test("setup failure attempts reopening and preserves the original error", async () => {
  const { lifecycle, calls } = fixture();
  const failure = new Error("setup failed");
  await assert.rejects(lifecycle.withRestart(async () => { throw failure; }), e => e === failure);
  assert.equal(calls.at(-1)[0], "launch");
});

test("shutdown timeout skips setup but attempts recovery", async () => {
  const { lifecycle, calls } = fixture();
  lifecycle.forceClose = async () => {};
  await assert.rejects(lifecycle.withRestart(async () => assert.fail("setup must not run")), /still running/);
  assert.equal(calls.some(c => c[0] === "launch"), false, "surviving desktop needs no duplicate recovery launch");
});

test("PID reuse is never signalled and own launcher is excluded", async () => {
  const f = fixture([row(10), row(999)]);
  await f.lifecycle.prepare();
  f.setInventory([{ ...row(10), started: "reused" }, row(999)]);
  await assert.rejects(f.lifecycle.close(), /still running/);
  assert.deepEqual(f.calls, []);
});

test("reopen is idempotent and concurrent restart transactions are rejected", async () => {
  const f = fixture([]);
  f.lifecycle.discoverInstalled = async () => ({ executable });
  let release;
  const first = f.lifecycle.withRestart(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.lifecycle.withRestart(async () => {}), /already/);
  release();
  await first;
  const g = fixture();
  await g.lifecycle.prepare();
  await g.lifecycle.close();
  await g.lifecycle.reopen();
  await g.lifecycle.reopen();
  assert.equal(g.calls.filter(c => c[0] === "launch").length, 1);
});

test("both operation and recovery errors remain available", async () => {
  const { lifecycle } = fixture();
  const operation = new Error("operation");
  const recovery = new Error("recovery");
  lifecycle.launch = async () => { throw recovery; };
  await assert.rejects(lifecycle.withRestart(async () => { throw operation; }), e => e instanceof AggregateError && e.errors[0] === operation && e.errors[1] === recovery);
});

test("a hung inventory is bounded before setup starts", async () => {
  const f = fixture();
  f.lifecycle.commandMs = 10;
  f.lifecycle.inventory = () => new Promise(() => {});
  await assert.rejects(f.lifecycle.withRestart(async () => assert.fail("must not run")), /timed out/);
  assert.equal(f.lifecycle.busy, false);
});

test("Windows adapters use bounded execFile argument arrays and detached spawn", async () => {
  const { EventEmitter } = require("node:events");
  const commands = [];
  const launches = [];
  let running = true;
  const lifecycle = createCodexDesktopLifecycle({
    platform: "win32", selfPid: 999, graceMs: 1, forceMs: 1, pollMs: 1,
    sleep: async () => {},
    execFile: async (file, args, options) => {
      commands.push({ file, args, options });
      if (file.endsWith("taskkill.exe")) { running = false; return { stdout: "" }; }
      return { stdout: args.at(-1).includes("Get-CimInstance")
        ? JSON.stringify(running ? [{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: executable, CreationDate: "now" }] : []) : "" };
    },
    spawn: (file, args, options) => {
      launches.push({ file, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await lifecycle.withRestart(async () => {});
  assert(commands.some(c => c.args.at(-1).includes("CloseMainWindow")));
  assert.deepEqual(commands.find(c => c.file.endsWith("taskkill.exe")).args, ["/PID", "10", "/T", "/F"]);
  assert(commands.every(c => c.options.shell === false && c.options.timeout === 5000));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.detached, true);
  assert.equal(launches[0].options.shell, false);
});

test("a newly appearing desktop prevents setup from running", async () => {
  const f = fixture([row(10)]);
  f.lifecycle.gracefulClose = async () => f.setInventory([row(30)]);
  await assert.rejects(f.lifecycle.withRestart(async () => assert.fail("must not run")), /still running/);
});

test("Store installation fallback verifies the discovered executable before launch", async () => {
  let launched;
  const lifecycle = createCodexDesktopLifecycle({
    platform: "win32", inventory: async () => [],
    isFile: async file => file === executable,
    execFile: async (_file, args) => {
      assert.match(args.at(-1), /Get-AppxPackage -Name OpenAI\.Codex/);
      return { stdout: JSON.stringify([executable.slice(0, -"\\app\\Codex.exe".length)]) };
    },
    launch: async info => { launched = info; },
  });
  await lifecycle.withRestart(async () => {});
  assert.deepEqual(launched, { executable, args: [] });
});

test("a rejected force command still attempts recovery and blocks setup", async () => {
  const f = fixture([row(10), row(20)]);
  const denied = new Error("access denied");
  f.lifecycle.forceClose = async p => {
    if (p.pid === 10) { f.setInventory([row(20)]); return; }
    throw denied;
  };
  await assert.rejects(f.lifecycle.withRestart(async () => assert.fail("must not run")), e => e === denied);
  assert.equal(f.lifecycle.busy, false);
});
