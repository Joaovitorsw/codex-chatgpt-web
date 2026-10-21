import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSmokeRollouts, correlateSmokeTraces, validateWebSubagentEvidence, parseRollout, parseSmokeOptions } from "../scripts/smoke-codex-web-subagents";

const cwd = process.cwd();
const model = "chatgpt-web/gpt-6-sol";
const expected = { cwd, model, version: "6.1.9", parentToken: "parent-secret", childToken: "child-secret" };
const event = (type: string, payload: Record<string, unknown>) => ({ type, payload });
const call = (name: string, call_id: string, args: Record<string, unknown>) => event("response_item", {
  type: "function_call", name, call_id, arguments: JSON.stringify(args),
});
const output = (call_id: string, value: unknown) => event("response_item", {
  type: "function_call_output", call_id, output: typeof value === "string" ? value : JSON.stringify(value),
});
function fixture() {
  const parent = [
    event("session_meta", { id: "parent", source: "exec" }),
    event("turn_context", { cwd, model, multi_agent_version: "v1" }),
    call("spawn_agent", "spawn", { message: "Read child-proof.json and package.json", fork_context: false }),
    output("spawn", { agent_id: "child" }),
    call("exec_command", "local", { cmd: "Get-Content parent-proof.json" }),
    output("local", "Process exited with code 0\nparent-secret"),
    call("wait_agent", "wait", { targets: ["child"], timeout_ms: 1000 }),
    output("wait", { status: { child: { completed: "CHILD_RESULT child-secret 6.1.9" } }, timed_out: false }),
    call("close_agent", "close", { target: "child" }),
    output("close", { previous_status: { completed: "CHILD_RESULT child-secret 6.1.9" } }),
    event("event_msg", { type: "task_complete", last_agent_message: "LIVE_WEB_SUBAGENT_OK parent-secret child-secret 6.1.9" }),
  ];
  const child = [
    event("session_meta", { id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } } }),
    event("turn_context", { cwd, model, multi_agent_version: "v1" }),
    call("exec_command", "read", { cmd: "Get-Content child-proof.json,package.json" }),
    output("read", "Process exited with code 0\nchild-secret\n6.1.9"),
    event("event_msg", { type: "task_complete", last_agent_message: "CHILD_RESULT child-secret 6.1.9" }),
  ];
  return [parent, child];
}

test("correlates real tool results, inherited model, lineage, directed wait and close", () => {
  expect(validateWebSubagentEvidence(fixture(), expected).failures).toEqual([]);
});

test("accepts Markdown-escaped acceptance markers without ignoring actual tool receipts", () => {
  const sessions = fixture();
  const completion = sessions[0]!.at(-1)!;
  completion.payload.last_agent_message = String(completion.payload.last_agent_message).replaceAll("_", "\\_");
  expect(validateWebSubagentEvidence(sessions, expected).failures).toEqual([]);
});

test("collects the child returned by spawn even when registration metadata repeats the parent", () => {
  const home = mkdtempSync(join(tmpdir(), "web-smoke-rollouts-"));
  try {
    mkdirSync(join(home, "sessions"));
    mkdirSync(join(home, "archived_sessions"));
    const [parent, child] = fixture();
    const parentPath = join(home, "sessions", "parent.jsonl");
    const childPath = join(home, "archived_sessions", "child.jsonl");
    writeFileSync(parentPath, parent!.map(entry => JSON.stringify(entry)).join("\n"));
    writeFileSync(childPath, child!.map(entry => JSON.stringify(entry)).join("\n"));
    writeFileSync(join(home, "sessions", "unrelated.jsonl"), "{}");
    expect(collectSmokeRollouts(home, "parent")).toEqual([parentPath, childPath]);
    expect(collectSmokeRollouts(home, "missing")).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("correlates the two browser registrations independently of inherited async request context", () => {
  expect(correlateSmokeTraces([{ traceId: "first" }, { traceId: "first" }, { traceId: "second" }], "parent", "child"))
    .toEqual([{ traceId: "first", threadId: "parent" }, { traceId: "second", threadId: "child" }]);
  expect(() => correlateSmokeTraces([{ traceId: "only" }], "parent", "child")).toThrow("exactly two");
  expect(() => correlateSmokeTraces([{ traceId: "a" }, { traceId: "b" }, { traceId: "c" }], "parent", "child")).toThrow("exactly two");
  expect(() => correlateSmokeTraces([{ traceId: "a" }, {}], "parent", "child")).toThrow("exactly two");
});

test.each([
  ["marker alone", (sessions: ReturnType<typeof fixture>) => sessions.splice(1)],
  ["wrong wait call id", (sessions: ReturnType<typeof fixture>) => { sessions[0]![7]!.payload.call_id = "unrelated"; }],
  ["wrong lineage", (sessions: ReturnType<typeof fixture>) => { sessions[1]![0]!.payload.source = { subagent: { thread_spawn: { parent_thread_id: "other", depth: 1 } } }; }],
  ["model override", (sessions: ReturnType<typeof fixture>) => { sessions[0]![2]!.payload.arguments = JSON.stringify({ fork_context: false, model }); }],
  ["forked context", (sessions: ReturnType<typeof fixture>) => { sessions[0]![2]!.payload.arguments = JSON.stringify({ fork_context: true }); }],
  ["native fallback", (sessions: ReturnType<typeof fixture>) => { sessions[1]![1]!.payload.model = "gpt-6-sol"; }],
  ["missing close result", (sessions: ReturnType<typeof fixture>) => { sessions[0]!.splice(9, 1); }],
  ["failed local command", (sessions: ReturnType<typeof fixture>) => { sessions[0]![5]!.payload.output = "Process exited with code 1\nparent-secret"; }],
  ["child never read", (sessions: ReturnType<typeof fixture>) => { sessions[1]!.splice(2, 2); }],
  ["missing completion", (sessions: ReturnType<typeof fixture>) => { sessions[1]!.pop(); }],
  ["wrong wait target", (sessions: ReturnType<typeof fixture>) => { sessions[0]![6]!.payload.arguments = JSON.stringify({ targets: ["other"] }); }],
  ["wait timed out", (sessions: ReturnType<typeof fixture>) => { sessions[0]![7]!.payload.output = JSON.stringify({ status: { child: { running: true } }, timed_out: true }); }],
])("rejects %s", (_label, mutate) => {
  const sessions = fixture();
  mutate(sessions);
  expect(validateWebSubagentEvidence(sessions, expected).failures.length).toBeGreaterThan(0);
});

test("does not treat a tool output as a result for a later call", () => {
  const sessions = fixture();
  const result = sessions[0]!.splice(7, 1)[0]!;
  sessions[0]!.splice(6, 0, result);
  expect(validateWebSubagentEvidence(sessions, expected).failures.length).toBeGreaterThan(0);
});

test("rollout parsing rejects truncated evidence with a source and line", () => {
  expect(() => parseRollout('{"type":"session_meta"}\n{broken', "child.jsonl")).toThrow("child.jsonl:2");
});

test("options consume values instead of misreading them as the Codex binary", () => {
  const options = parseSmokeOptions(["--bridge-home", "C:/Bridge", "--model", model, "--codex", "C:/Codex/codex.exe"]);
  expect(options.codex).toBe("C:/Codex/codex.exe");
  expect(options.bridgeHome).toBe("C:/Bridge");
  expect(() => parseSmokeOptions(["--bridge-url", "http://127.0.0.1:9042/v1"])).toThrow("requires --source-runtime");
  expect(() => parseSmokeOptions(["--unknown"])).toThrow("Unknown");
});
