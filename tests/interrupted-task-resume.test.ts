import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChatGptTurnUserRevision, isChatGptInterruptedTaskResume } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const thread = "01a17637-4f82-7751-947f-886ca7cec7f1";
const turn = "01a17665-ca53-7a92-8a19-b41258d57c97";
const old = "01a1764e-dbe5-7722-a94c-316da230e196";
const originalHome = process.env.CODEX_HOME;
let home: string;
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

function fixture(trigger = "resume_interrupted_task") {
  home = mkdtempSync(join(tmpdir(), "trusted-resume-"));
  process.env.CODEX_HOME = home;
  const directory = join(home, "sessions", "2026", "10", "26");
  mkdirSync(directory, { recursive: true });
  const instruction = { type: "message", role: "user", id: "msg_retry", content: [{ type: "input_text", text: "tente novamente\n" }], internal_chat_message_metadata_passthrough: { turn_id: old } };
  const abort = { type: "message", role: "user", id: "msg_abort", content: [{ type: "input_text", text: "<turn_aborted>interrupted</turn_aborted>" }], internal_chat_message_metadata_passthrough: { turn_id: old } };
  const records: Array<{ type: string; payload: Record<string, unknown> }> = [
    { type: "session_meta", payload: { id: thread, source: "vscode" } },
    { type: "response_item", payload: instruction },
    { type: "response_item", payload: abort },
    { type: "event_msg", payload: { type: "task_started", turn_id: turn, turn_attribution: { turn_id: turn, turn_trigger: trigger } } },
    { type: "turn_context", payload: { turn_id: turn, cwd: process.cwd(), sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } },
  ];
  const path = join(directory, `rollout-2026-10-26T00-18-18-${thread}.jsonl`);
  const save = () => writeFileSync(path, records.map(value => JSON.stringify(value)).join("\n") + "\n");
  save();
  const request = { modelId: "gpt-6-sol", stream: true, options: {}, context: { messages: [] }, _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) }, input: [structuredClone(instruction), abort, { type: "message", role: "developer", content: "hook/time context", internal_chat_message_metadata_passthrough: { turn_id: turn } }] } } as CodexParsedRequest;
  return { request, instruction, path, records, save };
}

test("canonical interrupted resume accepts retained aborted instruction without rewriting execution identity", () => {
  const { request, instruction } = fixture();
  expect(extractChatGptTurnUserRevision(request)).toEqual(instruction.content);
  expect(isChatGptInterruptedTaskResume(request)).toBe(true);
  expect(JSON.stringify(request._rawBody)).toContain(turn);
});

test("positive proof survives a removed rollout but cannot authenticate changed request content", () => {
  const { request, path } = fixture();
  expect(isChatGptInterruptedTaskResume(request)).toBe(true);
  rmSync(path);
  expect(isChatGptInterruptedTaskResume(request)).toBe(true);
  (request._rawBody as { input: Array<{ content: unknown }> }).input[0]!.content = "changed";
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
});

test("missing proof is not cached while canonical writer is pending", () => {
  const { request, path, save } = fixture();
  rmSync(path);
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
  save();
  expect(isChatGptInterruptedTaskResume(request)).toBe(true);
});

test.each(["function_call_output", "agent_message", "message"])("later %s cannot use canonical proof for an older instruction", type => {
  const { request } = fixture();
  (request._rawBody as { input: unknown[] }).input.push({ type, role: "assistant", content: "later" });
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts with native Codex turn_id");
});

test.each(["composer", "composer_predictions"])("%s does not authenticate resume", trigger => {
  expect(() => extractChatGptTurnUserRevision(fixture(trigger).request)).toThrow("conflicts with native Codex turn_id");
});

test("altered candidate and absent proof remain rejected", () => {
  const { request, path } = fixture();
  const input = (request._rawBody as { input: Array<{ content: unknown }> }).input;
  input[0]!.content = [{ type: "input_text", text: "altered" }];
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts with native Codex turn_id");
  rmSync(path);
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts with native Codex turn_id");
});

test("another canonical thread cannot prove resume", () => {
  const { request, records, save } = fixture();
  records[0]!.payload = { id: old, source: "vscode" } as typeof records[0]["payload"];
  save();
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts with native Codex turn_id");
});

test("a newer canonical turn invalidates an uncached stale resume request", () => {
  const { request, records, save } = fixture();
  records.push({ type: "turn_context", payload: { turn_id: old, cwd: process.cwd(), sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } });
  save();
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts with native Codex turn_id");
});

test("prior assistant and tool work does not supersede the interrupted instruction", () => {
  const { request, records, save } = fixture();
  records.splice(2, 0, ...[
    { type: "message", role: "assistant", content: "working" },
    { type: "function_call", call_id: "old_call", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "old_call", output: "result" },
  ].map(payload => ({ type: "response_item", payload }) as typeof records[number]));
  save();
  expect(isChatGptInterruptedTaskResume(request)).toBe(true);
});

test("instruction comparison tolerates incidental wire metadata", () => {
  const { request } = fixture();
  Object.assign((request._rawBody as { input: object[] }).input[0]!, { status: "completed", extra_wire_field: true });
  expect(isChatGptInterruptedTaskResume(request)).toBe(true);
});

test("missing interruption cannot authenticate resume", () => {
  const { request, records, save } = fixture();
  records.splice(2, 1);
  save();
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
});

test("completion of the interrupted old turn after abort invalidates its resume", () => {
  const { request, records, save } = fixture();
  records.push({ type: "event_msg", payload: { type: "task_complete", turn_id: old } });
  save();
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
});

test("a new canonical instruction after resume cannot borrow the earlier instruction", () => {
  const { request, records, save } = fixture();
  records.push({ type: "response_item", payload: { type: "message", role: "user", id: "new_instruction", content: "new task", internal_chat_message_metadata_passthrough: { turn_id: turn } } });
  save();
  expect(isChatGptInterruptedTaskResume(request)).toBe(false);
});

test.each([false, true])("new parsed native tool round retains the authenticated instruction with custom tools=%s", custom => {
  const { request, records, save, instruction } = fixture();
  const round = structuredClone(request);
  const continuation = [
    custom ? { type: "custom_tool_call", call_id: "current_call", name: "functions.exec", input: "console.log('work')" }
      : { type: "function_call", call_id: "current_call", name: "exec_command", arguments: "{}" },
    { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: "current_call", output: "current result" },
  ];
  (round._rawBody as { input: unknown[] }).input.push(...continuation);
  records.push(...continuation.map(payload => ({ type: "response_item", payload }) as typeof records[number]));
  save();
  expect(isChatGptInterruptedTaskResume(round)).toBe(true);
  expect(extractChatGptTurnUserRevision(round)).toEqual(instruction.content);
  if (custom) {
    (round._rawBody as { input: Array<Record<string, unknown>> }).input.at(-2)!.input = "altered code";
    expect(isChatGptInterruptedTaskResume(round)).toBe(false);
  }
});

test.each([false, true])("adapter releases retained chat before full prepare and stops on release failure=%s", async releaseFails => {
  const { request, records, save } = fixture();
  const cwd = process.cwd();
  request.modelId = CHATGPT_WEB_MODEL_ID;
  request.options.reasoning = "high";
  const environment = `<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  request.context.messages = [
    { role: "user", content: environment, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Earlier canonical answer" }], timestamp: 2 },
    { role: "user", content: "tente novamente\n", timestamp: 3 },
  ];
  const body = request._rawBody as { input: unknown[]; client_metadata: Record<string, string> };
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: thread, turn_id: turn, sandbox: "none", workspaces: { [cwd]: {} } });
  const environmentItem = { type: "message", role: "user", id: "msg_original_environment", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: old } };
  body.input.unshift(environmentItem);
  records.splice(1, 0, { type: "response_item", payload: environmentItem });
  save();
  const socket = defaultBrokerEndpoint(home, "win32");
  const descriptor = join(home, "fake-launcher.json");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://resume-${home}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: descriptor, appName: "Codex app", brokerSocketPath: socket, threadEnvironmentStatePath: join(home, "environments.json"), localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const order: string[] = [];
  worker.run = async browserTurn => {
    order.push("run");
    expect(browserTurn.prepareResume).toBeUndefined();
    expect(browserTurn.conversationKey).toBe(chatGptConversationKey(request, chatGptWebExecutionNamespace(provider))!);
    const prepared = await browserTurn.prepare();
    order.push("prepare");
    expect(prepared.text).toContain("Earlier canonical answer");
    expect(prepared.text).toContain("tente novamente");
    prepared.release();
    browserTurn.onTextDelta("Resumed answer");
    return "Resumed answer";
  };
  const adapter = createChatGptWebAdapter(provider, {
    releaseRetainedConversation: async (path, key) => {
      order.push("release");
      expect(path).toBe(descriptor);
      expect(key).toBe(chatGptConversationKey(request, chatGptWebExecutionNamespace(provider))!);
      if (releaseFails) throw new Error("release failed");
      return 1;
    },
  });
  try {
    if (releaseFails) {
      await expect(adapter.runTurn!(request, { headers: new Headers() }, () => {})).rejects.toThrow("release failed");
      expect(order).toEqual(["release"]);
    } else {
      await adapter.runTurn!(request, { headers: new Headers() }, () => {});
      await adapter.runTurn!(structuredClone(request), { headers: new Headers() }, () => {});
      expect(order).toEqual(["release", "run", "prepare"]);
    }
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(socket).close();
  }
});
