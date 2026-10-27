import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultBrokerEndpoint, getConfigDir, loadConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

type ObjectRecord = Record<string, unknown>;
interface RolloutRecord { type?: string; payload?: ObjectRecord; timestamp?: string }
interface ExpectedEvidence { cwd: string; model: string; version: string; parentToken: string; childToken: string }
interface SmokeOptions {
  codex?: string; bridgeHome?: string; bridgeUrl?: string; codexHome?: string;
  outputDir?: string; launcherLog?: string; model: string; effort: string;
  sourceRuntime: boolean; help: boolean;
}

const HELP = `Live Web parent/child smoke (runs real authenticated ChatGPT turns).
Usage: bun run scripts/smoke-codex-web-subagents.ts [codex.exe] [options]
  --codex PATH          Windows Codex binary; default: PATH (Bun.which)
  --source-runtime      Use working-tree adapter + live launcher RemoteTurnBroker (default)
  --bridge-home DIR     Read bridge config.json here; never write it
  --codex-home DIR      Codex rollout/state authority; default: current CODEX_HOME or ~/.codex
  --launcher-log FILE   Required live launcher JSONL log (including rotated .1)
  --output-dir DIR      Fresh evidence directory; default outputs/web-subagents-<timestamp>
  --model SLUG          Default chatgpt-web/gpt-6-sol; child must inherit it
  --effort LEVEL        Default medium
  --help               No bridge, browser or Codex execution

Source mode builds the current browser helper under the evidence directory and uses
createLauncherDevAdapter with the production broker, then startServer on port 0
with its own private broker endpoint. No shared install, service or browser restart.
Root useSavedChats must be true. Child policy is owned by the source adapter.
CODEX_HOME and CODEX_SQLITE_HOME are set only for this process and its Codex child.
For source mode use the same canonical state directory as the CLI. An external
bridge must already resolve that exact home; a client override cannot change a
running server's authority. This script does not migrate/copy auth or state.
All overrides are CLI -c values; the user's config.toml is never written.
Artifacts include config overrides, stdout/stderr, copied rollouts, diagnostics,
launcher events, and report.json, including failures. No evidence is deleted.
`;

export function parseSmokeOptions(args: string[]): SmokeOptions {
  const options: SmokeOptions = { model: "chatgpt-web/gpt-6-sol", effort: "medium", sourceRuntime: true, help: false };
  const keys = new Map<string, keyof SmokeOptions>([
    ["--codex", "codex"], ["--bridge-home", "bridgeHome"], ["--bridge-url", "bridgeUrl"],
    ["--codex-home", "codexHome"], ["--output-dir", "outputDir"], ["--launcher-log", "launcherLog"],
    ["--model", "model"], ["--effort", "effort"],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--source-runtime") { options.sourceRuntime = true; continue; }
    const key = keys.get(arg);
    if (key) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      Object.assign(options, { [key]: value });
    } else if (!arg.startsWith("--") && !options.codex) options.codex = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.bridgeUrl) throw new Error("Full live evidence requires --source-runtime; an external bridge has no correlated browser diagnostics");
  return options;
}

function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : undefined;
}

export function parseRollout(text: string, path: string): RolloutRecord[] {
  return text.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as RolloutRecord]; }
    catch { throw new Error(`Invalid rollout JSON at ${path}:${index + 1}`); }
  });
}

function spawnMetadata(entries: RolloutRecord[]): ObjectRecord | undefined {
  const meta = entries.find(entry => entry.type === "session_meta")?.payload;
  const legacy = object(object(object(meta?.source)?.subagent)?.thread_spawn);
  if (legacy) return legacy;
  if (typeof meta?.parent_thread_id === "string" && object(object(meta.source)?.subagent)) {
    return { parent_thread_id: meta.parent_thread_id, depth: meta.agent_depth ?? 1 };
  }
  return undefined;
}

function items(entries: RolloutRecord[]): ObjectRecord[] {
  return entries.flatMap(entry => entry.type === "response_item" && entry.payload ? [entry.payload] : []);
}

function toolName(item: ObjectRecord): string {
  return typeof item.name === "string" ? item.name.split(/\.|__/).at(-1)! : "";
}

function jsonObject(value: unknown): ObjectRecord | undefined {
  if (typeof value !== "string") return object(value);
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

function calls(entries: ObjectRecord[], name: string) {
  return entries.flatMap((item, index) => {
    if (item.type !== "function_call" || toolName(item) !== name) return [];
    const resultIndex = entries.findIndex((result, position) => position > index
      && result.type === "function_call_output" && typeof item.call_id === "string" && result.call_id === item.call_id);
    const result = resultIndex >= 0 ? entries[resultIndex] : undefined;
    return [{ index, resultIndex, args: jsonObject(item.arguments), result, data: jsonObject(result?.output) }];
  });
}

function completion(entries: RolloutRecord[]): ObjectRecord | undefined {
  return entries.findLast(entry => entry.type === "event_msg" && entry.payload?.type === "task_complete")?.payload;
}

function shellProof(entries: ObjectRecord[], token: string) {
  return ["exec_command", "shell_command", "shell"].flatMap(name => calls(entries, name)).filter(call => {
    const output = call.result?.output;
    return typeof output === "string" && output.includes(token)
      && /(?:Process exited with code|Exit code:)\s*0\b/i.test(output);
  });
}

export function validateWebSubagentEvidence(sessions: RolloutRecord[][], expected: ExpectedEvidence) {
  const failures: string[] = [];
  const roots = sessions.filter(entries => !spawnMetadata(entries));
  const children = sessions.filter(entries => spawnMetadata(entries)?.depth === 1);
  if (roots.length !== 1 || children.length !== 1 || sessions.length !== 2) failures.push("expected exactly one root and one depth-1 child rollout");
  const root = roots[0] ?? [];
  const child = children[0] ?? [];
  const rootId = root.find(entry => entry.type === "session_meta")?.payload?.id;
  const childId = child.find(entry => entry.type === "session_meta")?.payload?.id;
  if (!rootId || !childId || spawnMetadata(child)?.parent_thread_id !== rootId) failures.push("child lineage does not match root id");
  for (const [label, entries] of [["root", root], ["child", child]] as const) {
    const contexts = entries.filter(entry => entry.type === "turn_context");
    if (!contexts.length || contexts.some(entry => typeof entry.payload?.cwd !== "string"
      || resolve(entry.payload.cwd) !== resolve(expected.cwd) || entry.payload.model !== expected.model
      || entry.payload.multi_agent_version !== "v1")) failures.push(`${label} cwd/model/protocol mismatch`);
    const done = completion(entries);
    if (!done || done.error) failures.push(`${label} missing successful task_complete`);
  }
  const parentItems = items(root);
  const spawns = calls(parentItems, "spawn_agent");
  const spawn = spawns[0];
  if (spawns.length !== 1 || spawn?.args?.fork_context !== false
    || spawn.args.model !== undefined || spawn.args.reasoning_effort !== undefined
    || spawn.data?.agent_id !== childId) failures.push("spawn must return exact child id, fork_context=false and omit model/effort overrides");
  const waits = calls(parentItems, "wait_agent").filter(call => {
    const targets = call.args?.targets;
    const state = object(object(call.data?.status)?.[String(childId)]);
    return Array.isArray(targets) && targets.length === 1 && targets[0] === childId
      && call.data?.timed_out === false && typeof state?.completed === "string"
      && state.completed.includes(expected.childToken) && state.completed.includes(expected.version);
  });
  if (!waits.length) failures.push("no correlated targeted wait returned the completed child's actual result");
  const firstWait = calls(parentItems, "wait_agent")[0];
  const local = shellProof(parentItems, expected.parentToken).find(call => spawn && firstWait
    && call.index > spawn.resultIndex && call.resultIndex < firstWait.index);
  if (!local) failures.push("parent did not execute independent local proof between spawn and wait");
  const childProofs = shellProof(items(child), expected.childToken);
  if (!childProofs.some(call => String(call.result?.output).includes(expected.version))) failures.push("missing successful child repository read and private proof output");
  const closes = calls(parentItems, "close_agent").filter(call => call.args?.target === childId
    && call.result && call.data && !call.data.error
    && (object(call.data.previous_status) ?? object(call.data.status))?.completed !== undefined
    && waits.some(wait => call.index > wait.resultIndex));
  if (!closes.length) failures.push("missing correlated close_agent result after collecting child");
  const childFinal = String(completion(child)?.last_agent_message ?? "");
  if (!childFinal.includes(expected.childToken) || !childFinal.includes(expected.version)) failures.push("child final result differs from proof");
  const final = String(completion(root)?.last_agent_message ?? "").replaceAll("\\_", "_");
  if (!["LIVE_WEB_SUBAGENT_OK", expected.parentToken, expected.childToken, expected.version].every(value => final.includes(value))) failures.push("parent final result differs from collected proofs");
  return { failures, rootId, childId };
}

function files(directory: string, suffix: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
  });
}

export function collectSmokeRollouts(codexHome: string, rootId: string, knownChildIds: string[] = []): string[] {
  const available = ["sessions", "archived_sessions"].flatMap(directory => files(join(codexHome, directory), ".jsonl"));
  const rootPath = available.find(path => path.includes(rootId));
  if (!rootPath) return [];
  const root = parseRollout(readFileSync(rootPath, "utf8"), rootPath);
  const childIds = calls(items(root), "spawn_agent").flatMap(call => typeof call.data?.agent_id === "string" ? [call.data.agent_id] : []);
  return available.filter(path => [rootId, ...childIds, ...knownChildIds].some(id => path.includes(id)));
}

export function correlateSmokeTraces(registrations: Array<{ traceId?: string }>, rootId: unknown, childId: unknown) {
  const traces = [...new Set(registrations.map(entry => entry.traceId))];
  if (traces.length !== 2 || traces.some(trace => !trace) || typeof rootId !== "string" || typeof childId !== "string") {
    throw new Error("Expected exactly two registered browser traces for the root and its single child");
  }
  return traces.map((traceId, index) => ({ traceId, threadId: index === 0 ? rootId : childId }));
}

export function validateCurrentCollaborationEvents(events: ObjectRecord[], rootId: string, childId: string, childToken: string, version: string): string[] {
  const failures: string[] = [];
  const completed = events.flatMap((event, index) => {
    const item = object(event.item);
    return event.type === "item.completed" && item?.type === "collab_tool_call"
      && item.sender_thread_id === rootId ? [{ index, item }] : [];
  });
  const matching = (name: string) => completed.filter(({ item }) => item.tool === name
    && Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.length === 1
    && item.receiver_thread_ids[0] === childId && item.status === "completed");
  const spawns = matching("spawn_agent");
  const waits = matching("wait").filter(({ item }) => {
    const state = object(object(item.agents_states)?.[childId]);
    return state?.status === "completed" && typeof state.message === "string"
      && state.message.includes(childToken) && state.message.includes(version);
  });
  const closes = matching("close_agent");
  if (spawns.length !== 1) failures.push("missing unique correlated native spawn_agent completion");
  if (!waits.some(wait => spawns.some(spawn => wait.index > spawn.index))) failures.push("missing correlated completed native wait");
  if (!closes.some(close => waits.some(wait => close.index > wait.index))) failures.push("missing correlated native close_agent after wait");
  return failures;
}

export function validateNativeSmokeEvidence(events: ObjectRecord[], sessions: RolloutRecord[][], expected: ExpectedEvidence) {
  const failures: string[] = [];
  const root = sessions.find(entries => !spawnMetadata(entries)) ?? [];
  const child = sessions.find(entries => spawnMetadata(entries)?.depth === 1) ?? [];
  const rootId = root.find(entry => entry.type === "session_meta")?.payload?.id;
  const childId = child.find(entry => entry.type === "session_meta")?.payload?.id;
  if (sessions.length !== 2 || typeof rootId !== "string" || typeof childId !== "string"
    || spawnMetadata(child)?.parent_thread_id !== rootId) failures.push("native parent/child rollout lineage mismatch");
  if (typeof rootId !== "string" || typeof childId !== "string") return { failures, rootId, childId };
  for (const [label, entries] of [["root", root], ["child", child]] as const) {
    const contexts = entries.filter(entry => entry.type === "turn_context");
    if (!contexts.length || contexts.some(entry => resolve(String(entry.payload?.cwd)) !== resolve(expected.cwd)
      || entry.payload?.model !== expected.model || entry.payload?.multi_agent_version !== "v1")) {
      failures.push(`${label} cwd/model/protocol mismatch`);
    }
    if (!completion(entries) || completion(entries)?.error) failures.push(`${label} missing successful task_complete`);
  }
  failures.push(...validateCurrentCollaborationEvents(events, rootId, childId, expected.childToken, expected.version));
  const completedItems = events.flatMap((event, index) => event.type === "item.completed" && object(event.item)
    ? [{ index, item: object(event.item)! }] : []);
  const spawnIndex = completedItems.find(entry => entry.item.type === "collab_tool_call" && entry.item.tool === "spawn_agent")?.index ?? -1;
  const waitIndex = completedItems.find(entry => entry.item.type === "collab_tool_call" && entry.item.tool === "wait")?.index ?? -1;
  if (!completedItems.some(entry => entry.index > spawnIndex && entry.index < waitIndex
    && entry.item.type === "command_execution" && entry.item.exit_code === 0
    && String(entry.item.aggregated_output).includes(expected.parentToken))) failures.push("missing independent parent shell proof before wait");
  const childOutputs = child.filter(entry => entry.type === "response_item" && entry.payload?.type === "custom_tool_call_output")
    .flatMap(entry => Array.isArray(entry.payload?.output) ? entry.payload.output : [])
    .map(part => String(object(part)?.text ?? "")).join("\n");
  if (!childOutputs.includes(expected.childToken) || !childOutputs.includes(expected.version)
    || !/(?:"exit_code"|exit_code)\s*[:=]\s*0|Process exited with code\s*0/i.test(childOutputs)) failures.push("missing successful child shell proof");
  const childFinal = String(completion(child)?.last_agent_message ?? "").replaceAll("\\_", "_");
  if (!childFinal.includes(expected.childToken) || !childFinal.includes(expected.version)) failures.push("child final result differs from proof");
  const rootFinal = String(completion(root)?.last_agent_message ?? "").replaceAll("\\_", "_");
  if (!["LIVE_WEB_SUBAGENT_OK", expected.parentToken, expected.childToken, expected.version].every(value => rootFinal.includes(value))) {
    failures.push("parent final result differs from collected proofs");
  }
  return { failures, rootId, childId };
}

function writeJson(path: string, value: unknown) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

/** Evidence only: overlap must be proven by native call/result timestamps, not prompt intent. */
export function nativeToolOverlap(parent: RolloutRecord[], child: RolloutRecord[]) {
  const intervals = (entries: RolloutRecord[]) => {
    const started = new Map<string, number>();
    const seen = new Map<string, number>();
    const completed: Array<{ id: string; start: number; end: number }> = [];
    const openSessions = new Map<string, { id: string; start: number }>();
    for (const entry of entries) {
      if (entry.type !== "response_item") continue;
      const item = object(entry.payload);
      const id = item?.call_id;
      if (typeof id !== "string") continue;
      if (item?.type === "custom_tool_call" || item?.type === "function_call") {
        const input = String(item.input ?? item.arguments ?? "");
        const shellTool = item.name === "exec_command" || item.name === "write_stdin"
          || /const nestedToolName = "(?:exec_command|write_stdin)"/.test(input)
          || /\btools\.(?:exec_command|write_stdin)\s*\(/.test(input);
        if (!shellTool) continue;
        started.set(id, Date.parse(String(entry.timestamp)));
        seen.set(id, (seen.get(id) ?? 0) + 1);
      } else if (item?.type === "custom_tool_call_output" || item?.type === "function_call_output") {
        const start = started.get(id);
        if (start === undefined) continue;
        const end = Date.parse(String(entry.timestamp));
        const result = JSON.stringify(item.output ?? "");
        const sessionId = result.match(/session_id\\?"\s*:\s*(\d+)/)?.[1];
        if (sessionId && start !== undefined) openSessions.set(sessionId, { id, start });
        const call = entries.find(candidate => candidate.type === "response_item"
          && object(candidate.payload)?.call_id === id
          && ["custom_tool_call", "function_call"].includes(String(object(candidate.payload)?.type)));
        const input = String(object(call?.payload)?.input ?? object(call?.payload)?.arguments ?? "");
        const resumedSession = [...openSessions].find(([session]) => input.includes(session));
        if (resumedSession && /exit_code\\?"\s*:\s*\d+/.test(result)) {
          const [session, original] = resumedSession;
          if (Number.isFinite(original.start) && Number.isFinite(end)) completed.push({ id: original.id, start: original.start, end });
          openSessions.delete(session);
        }
        if (!sessionId && start !== undefined && Number.isFinite(start) && Number.isFinite(end)) completed.push({ id, start, end });
      }
    }
    return { completed, duplicatedIds: [...seen].filter(([, count]) => count > 1).map(([id]) => id) };
  };
  const p = intervals(parent);
  const c = intervals(child);
  return {
    overlapping: p.completed.some(a => c.completed.some(b => a.start < b.end && b.start < a.end)),
    parentCalls: p.completed.length,
    childCalls: c.completed.length,
    duplicateCallIds: [...p.duplicatedIds, ...c.duplicatedIds],
  };
}

async function main() {
  const options = parseSmokeOptions(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const cwd = resolve(import.meta.dir, "..");
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (git.status !== 0 || resolve(git.stdout.trim()) !== cwd || resolve(process.cwd()) !== cwd) throw new Error(`Run from authoritative repository root: ${cwd}`);
  const outputDir = resolve(options.outputDir ?? join(cwd, "outputs", `web-subagents-${Date.now()}`));
  if (existsSync(outputDir)) throw new Error(`Evidence directory must be fresh: ${outputDir}`);
  mkdirSync(outputDir, { recursive: true });
  const report: ObjectRecord = { status: "preparing", cwd, outputDir, startedAt: new Date().toISOString() };
  let sourceServer: ReturnType<typeof Bun.serve> | undefined;
  const mappings: Array<{ threadId?: string; parentThreadId?: string; traceId?: string }> = [];
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const sqliteHome = options.codexHome ? codexHome : resolve(process.env.CODEX_SQLITE_HOME ?? codexHome);
  const previousHome = process.env.CODEX_HOME;
  const previousSqlite = process.env.CODEX_SQLITE_HOME;
  const previousBridgeHome = process.env.CODEX_CHATGPT_WEB_HOME;
  try {
    if (options.bridgeHome) process.env.CODEX_CHATGPT_WEB_HOME = resolve(options.bridgeHome);
    const config = loadConfig();
    const bridgeHome = getConfigDir();
    if (config.browserHost !== "launcher" || config.browserInteractionMode !== "automatic"
      || config.mode !== "full" || config.subagentProtocol !== "compatibility-v1" || !config.useSavedChats) {
      throw new Error("Requires launcher automatic/full Compatibility V1 config with useSavedChats=true");
    }
    if (!options.launcherLog || !existsSync(options.launcherLog)) throw new Error("--launcher-log must identify the current launcher JSONL log for retention/release proof");
    const codex = options.codex ? resolve(options.codex) : Bun.which("codex");
    if (!codex || !existsSync(codex)) throw new Error("Codex binary missing; supply --codex with the Windows Codex executable");
    mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_SQLITE_HOME = sqliteHome;
    const version = spawnSync(codex, ["--version"], { encoding: "utf8", timeout: 15_000 });
    const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000 });
    if (bundled.status !== 0) throw new Error(`Could not read current bundled catalog: ${bundled.error?.message ?? bundled.stderr}`);
    const catalog = augmentNativeModelCatalog(JSON.parse(bundled.stdout), config);
    const models = catalog.models as ObjectRecord[];
    const selected = models.find(model => model.slug === options.model && model.visibility === "list");
    if (!selected || !(selected.supported_reasoning_levels as ObjectRecord[]).some(level => level.effort === options.effort)) throw new Error("Requested model/effort is not visible in current augmented catalog");
    writeJson(join(outputDir, "models.json"), catalog);
    let endpoint = options.bridgeUrl ?? `http://${config.host}:${config.port}/v1`;
    const runtimeRoot = join(outputDir, "runtime");
    if (options.sourceRuntime) {
      const { createLauncherDevAdapter } = await import("../src/dev-chat/driver");
      const { startServer } = await import("../src/server");
      const { RemoteTurnBroker } = await import("../src/adapters/chatgpt-web/turn-broker");
      const remote = new RemoteTurnBroker(config.brokerSocketPath);
      await remote.assertCompatible();
      const observedBroker = new Proxy(remote, { get(target, key) {
        if (key === "register") return (...args: Parameters<typeof remote.register>) => {
          mappings.push({ traceId: args[2] });
          writeJson(join(outputDir, "trace-mappings.json"), mappings);
          return target.register(...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      mkdirSync(runtimeRoot, { recursive: true });
      const helper = join(runtimeRoot, "browser-helper.cjs");
      const build = Bun.spawnSync([process.execPath, "run", join(cwd, "scripts/build-browser-helper.ts"), helper], { cwd, stdout: "pipe", stderr: "pipe" });
      writeFileSync(join(outputDir, "helper-build.log"), `${build.stdout}\n${build.stderr}`);
      if (build.exitCode !== 0) throw new Error("Source browser helper build failed; see helper-build.log");
      const adapter = createLauncherDevAdapter(config, runtimeRoot, { broker: observedBroker, browserHelperScriptPath: helper });
      const smokeConfig = { ...config, port: 0, brokerSocketPath: defaultBrokerEndpoint(outputDir) };
      sourceServer = startServer(smokeConfig, { adapterFactory: adapter.adapterFactory });
      endpoint = `http://127.0.0.1:${sourceServer.port}/v1`;
    }
    Object.assign(report, { codex, codexVersion: version.stdout.trim(), bridgeHome, endpoint, sourceRuntime: options.sourceRuntime, codexHome, sqliteHome, model: options.model, effort: options.effort, childChatMode: config.subagentUseSavedChats ? "saved" : "temporary", head: spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim() });
    const configArgs = [
      `model=${JSON.stringify(options.model)}`, 'model_provider="openai"',
      `model_reasoning_effort=${JSON.stringify(options.effort)}`,
      `model_catalog_json=${JSON.stringify(join(outputDir, "models.json"))}`,
      `sqlite_home=${JSON.stringify(sqliteHome)}`,
      // Persist a provider that exists after this diagnostic process exits.
      `openai_base_url=${JSON.stringify(endpoint)}`,
      "features.multi_agent=true", "features.multi_agent_v2=false", "agents.max_depth=1",
    ];
    writeFileSync(join(outputDir, "codex-overrides.txt"), configArgs.join("\n"));
    const parentToken = crypto.randomUUID();
    const childToken = crypto.randomUUID();
    const parentFile = join(outputDir, "parent-proof.json");
    const childFile = join(outputDir, "child-proof.json");
    const childStartedFile = join(outputDir, "child-started.marker");
    const childEffectsFile = join(outputDir, "child-effects.log");
    writeJson(parentFile, { token: parentToken });
    writeJson(childFile, { token: childToken });
    const expectedVersion = String(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version);
    const prompt = [
      "Perform this bounded real Web delegation test. Use tools, no fallback model, no application edits.",
      "Spawn exactly one child immediately, omit model and reasoning_effort so it inherits yours; fork_context=false.",
      `Its compact task: run ONE PowerShell shell command: append exactly one line with Add-Content -LiteralPath ${JSON.stringify(childEffectsFile)} -Value 'executed' before creating marker file ${JSON.stringify(childStartedFile)} immediately, then Start-Sleep -Seconds 40 within that SAME shell command, then read ${JSON.stringify(childFile)} and repository package.json; return CHILD_RESULT, the token and exact version. No delegation.`,
      `After spawning and BEFORE wait_agent, run your own independent PowerShell shell command that polls up to 120 seconds for marker ${JSON.stringify(childStartedFile)} (100ms intervals) and, once it exists, reads ${JSON.stringify(parentFile)} immediately. Do not wait for the child to finish before running this command.`,
      "Wait for that exact child id using targeted wait_agent, collect its actual completed result, then close that child and inspect close result.",
      "Finish with LIVE_WEB_SUBAGENT_OK, your local token, the child's token and version. Fail explicitly if anything is unavailable.",
    ].join(" ");
    writeFileSync(join(outputDir, "prompt.txt"), prompt);
    const startedAt = Date.now();
    report.status = "running";
    writeJson(join(outputDir, "report.json"), report);
    const child = Bun.spawn([codex, "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", ...configArgs.flatMap(value => ["-c", value]), prompt], {
      cwd, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8 * 60_000);
    const saveStream = async (stream: ReadableStream<Uint8Array>, path: string) => {
      writeFileSync(path, "");
      for await (const chunk of stream) appendFileSync(path, chunk);
    };
    let exitCode: number;
    try {
      [exitCode] = await Promise.all([child.exited, saveStream(child.stdout, join(outputDir, "codex.stdout.jsonl")), saveStream(child.stderr, join(outputDir, "codex.stderr.log"))]);
    } finally { clearTimeout(timer); }
    const stdout = parseRollout(readFileSync(join(outputDir, "codex.stdout.jsonl"), "utf8"), "codex.stdout.jsonl") as Array<ObjectRecord>;
    const rootId = stdout.find(entry => entry.type === "thread.started")?.thread_id;
    const observedChildIds = stdout.flatMap(entry => {
      const item = object(entry.item);
      if (item?.type !== "collab_tool_call" || item.tool !== "spawn_agent") return [];
      return Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter((id): id is string => typeof id === "string") : [];
    });
    const all = collectSmokeRollouts(codexHome, String(rootId), observedChildIds);
    const evidenceDir = join(outputDir, "rollouts");
    mkdirSync(evidenceDir);
    const sessions = all.map((path, index) => {
      const raw = readFileSync(path, "utf8");
      writeFileSync(join(evidenceDir, `${index}.jsonl`), raw);
      return parseRollout(raw, path);
    });
    const rootRollout = sessions.find(entries => !spawnMetadata(entries));
    const childRollout = sessions.find(entries => spawnMetadata(entries)?.depth === 1);
    if (rootRollout && childRollout) {
      report.toolConcurrency = nativeToolOverlap(rootRollout, childRollout);
    }
    const hasNativeCollaboration = stdout.some(entry => object(entry.item)?.type === "collab_tool_call");
    const expected = { cwd, model: options.model, version: expectedVersion, parentToken, childToken };
    const evidence = hasNativeCollaboration ? validateNativeSmokeEvidence(stdout, sessions, expected)
      : validateWebSubagentEvidence(sessions, expected);
    if ((report.toolConcurrency as { overlapping?: boolean } | undefined)?.overlapping !== true) {
      evidence.failures.push("parent shell did not overlap child's in-flight shell command");
    }
    const duplicateCallIds = (report.toolConcurrency as { duplicateCallIds?: string[] } | undefined)?.duplicateCallIds ?? [];
    if (duplicateCallIds.length > 0) evidence.failures.push(`duplicate native tool call IDs: ${duplicateCallIds.join(", ")}`);
    const childEffectCount = existsSync(childEffectsFile)
      ? readFileSync(childEffectsFile, "utf8").split(/\r?\n/).filter(line => line === "executed").length
      : 0;
    report.childEffectCount = childEffectCount;
    if (childEffectCount !== 1) evidence.failures.push(`child side effect count must be exactly one, got ${childEffectCount}`);
    const correlatedMappings = correlateSmokeTraces(mappings, evidence.rootId, evidence.childId);
    writeJson(join(outputDir, "trace-mappings.json"), correlatedMappings);
    if (exitCode !== 0 || timedOut) evidence.failures.push(`Codex exit=${exitCode}, timedOut=${timedOut}`);
    const launcherEvents = [options.launcherLog + ".1", options.launcherLog].flatMap(path => existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as ObjectRecord) : []);
    const relevantEvents = launcherEvents.filter(event => Date.parse(String(event.at)) >= startedAt
      && mappings.some(mapping => mapping.traceId === object(event.detail)?.traceId));
    writeJson(join(outputDir, "launcher-events.json"), relevantEvents);
    const diagnostics: ObjectRecord[] = files(join(runtimeRoot, "diagnostics"), ".json").map(path => ({ path, ...JSON.parse(readFileSync(path, "utf8")) as ObjectRecord }));
    const childTraces = new Set(correlatedMappings.filter(mapping => mapping.threadId === evidence.childId).map(mapping => mapping.traceId));
    const rootTraces = new Set(correlatedMappings.filter(mapping => mapping.threadId === evidence.rootId).map(mapping => mapping.traceId));
    const childChatCheckpoint = config.subagentUseSavedChats ? "saved-chat-navigation-complete" : "temporary-chat-navigation-complete";
    if (!diagnostics.some(diagnostic => {
      if (!childTraces.has(diagnostic.traceId as string)) return false;
      const state = object(diagnostic.state);
      const location = object(state?.location);
      if (location?.temporaryChat !== !config.subagentUseSavedChats) return false;
      if (diagnostic.checkpoint === childChatCheckpoint) return true;
      // A prewarmed page already at the requested URL needs no second navigation.
      return diagnostic.checkpoint === "session-verified" && state?.documentComplete === true
        && location.origin === "https://chatgpt.com" && location.pathSegments === 0
        && object(state.composer)?.visibleCount === 1;
    })) evidence.failures.push("missing child configured chat-policy surface diagnostic");
    const childEvents = relevantEvents.filter(event => childTraces.has(object(event.detail)?.traceId as string));
    if (childEvents.some(event => new Set(["browser.tab_retained", "browser.tab_restored", "browser.tab_reused"]).has(String(event.event)))) evidence.failures.push("child was retained/restored/reused");
    if (!childEvents.some(event => event.event === "browser.tab_released")
      || !childEvents.some(event => event.event === "browser.turn_ended" && object(event.detail)?.status === "completed")) evidence.failures.push("missing completed child tab release diagnostic");
    if (!relevantEvents.some(event => rootTraces.has(object(event.detail)?.traceId as string) && event.event === "browser.tab_retained")) evidence.failures.push("missing saved root tab retention diagnostic");
    Object.assign(report, { ...evidence, exitCode, timedOut, rolloutPaths: all, mappings: correlatedMappings, status: evidence.failures.length ? "failed" : "passed" });
    if (evidence.failures.length) throw new Error(evidence.failures.join("; "));
    process.stdout.write(`LIVE_WEB_SUBAGENT_CHAIN_OK ${join(outputDir, "report.json")}\n`);
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    process.stderr.write(`${report.error}\nEvidence: ${outputDir}\n`);
  } finally {
    report.finishedAt = new Date().toISOString();
    writeJson(join(outputDir, "report.json"), report);
    if (sourceServer) {
      await sourceServer.stop(true);
      const { closeTurnBrokers } = await import("../src/adapters/chatgpt-web/turn-broker");
      const { closeChatGptBrowserWorkers } = await import("../src/adapters/chatgpt-web/browser-worker");
      await Promise.allSettled([closeTurnBrokers(), closeChatGptBrowserWorkers()]);
    }
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousSqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previousSqlite;
    if (previousBridgeHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previousBridgeHome;
  }
}

if (import.meta.main) await main();
