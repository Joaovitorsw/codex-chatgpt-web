import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  CHATGPT_BIGGER_CONTEXT_PARTS,
  chatGptPromptJsonBytes,
  chatGptReadOnlyContextWarning,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  withoutRetiredTurnHandles,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { biggerContextPartCount } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

function request(reasoning: "low" | "medium" | "high" | "xhigh" | "max"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

test("local GIF delivery requires the viewer receipt instead of a file link or static conversion", () => {
  const compiled = compileChatGptWebPrompt(request("high"), { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, "turn_12345678901234567890123456789012");
  expect(compiled.text).toContain("animated GIF");
  expect(compiled.text).toContain("image_ref");
  expect(compiled.text).toContain("plain text on its own line");
  expect(compiled.text).toContain("Do not flatten");
});

test.each(["png", "gif"])("delivered inline %s images do not resend Base64 as assistant prose", format => {
  const parsed = request("high");
  const data = Buffer.from("existing image bytes").toString("base64");
  parsed.context.messages.splice(1, 0, { role: "assistant", content: [{ type: "text", text: `Before ![Existing](data:image/${format};base64,${data}) after` }], timestamp: 1 });
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });
  expect(compiled.text).not.toContain(data);
  expect(compiled.text).toContain("Existing");
  expect(compiled.text).toContain("previously delivered image");
});

test("custom plugin identity stays explicit in inline and multipart execution without rewriting task history", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const parsed = request("high");
  parsed.context.messages[1]!.content = "Compare Codex Native2 with the selected plugin.";
  for (const appName of ["Codex app", "Codex Native2 DEV", "Codex Робота"]) {
    for (const parts of [undefined, 2, 6] as const) {
      const compiled = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", {
        appName, experimentalMultipartParts: parts,
      });
      const contract = compiled.multipart?.commit ?? compiled.text;
      expect(contract).toContain(`The selected local Codex plugin for this turn is ${JSON.stringify(appName)}.`);
      expect(contract).toContain("Do not substitute another plugin for this local connection");
      expect(contract).not.toContain("attached local Codex tools");
      const history = compiled.multipart
        ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records).filter(record => record.kind === "message").map(record => record.message)
        : JSON.parse(compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)![1]!).messages;
      expect(history[1].content).toBe(parsed.context.messages[1]!.content);
    }
  }
});

test("inline and staged history escape Markdown delimiters without changing decoded code", () => {
  const parsed = request("high");
  const code = '```ts\nconst value = "`key`";\n``` '.repeat(20) + '\\u0060 \\` [text](https://example.com) 中文';
  parsed.context.systemPrompt = [code];
  parsed.context.messages[1]!.content = code;
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const inline = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  const encoded = inline.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)![1]!;
  expect(encoded).not.toContain("`");
  const decoded = JSON.parse(encoded);
  expect(decoded.system).toEqual([code]);
  expect(decoded.messages[1].content).toBe(code);
  const staged = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", {
    experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS,
  });
  const records = staged.multipart!.parts.flatMap(part => {
    expect(part).not.toContain("`");
    return JSON.parse(part).records;
  });
  expect(records.find(record => record.kind === "system").content).toBe(code);
  expect(records.find(record => record.kind === "message" && record.message_index === 1).message.content)
    .toEqual(decoded.messages[1].content);
  // A literal escape in source code stays literal; it is not decoded into a backtick twice.
  expect(decoded.messages[1].content).toContain("\\u0060");
});

test("history handle cleanup works on decoded text and preserves native call identities", () => {
  const call = `call_${"A".repeat(32)}`;
  const context = {
    tool_call_id: call,
    content: ["turn", "request", "binding"].map(kind => `first line\n${kind}_${"B".repeat(32)}\tlast line`),
    ordinary: [`my_turn_${"C".repeat(32)}`, `turn_${"D".repeat(33)}`, `turn_${"E".repeat(31)}`],
    literal: "Keep \\\\path, \\\"quotes\\\", and $& exactly.",
  };
  const cleaned = JSON.parse(withoutRetiredTurnHandles(JSON.stringify(context)));
  expect(cleaned.content).toEqual(["turn", "request", "binding"].map(kind => `first line\n[retired ${kind} handle]\tlast line`));
  expect(cleaned.tool_call_id).toBe(call);
  expect(cleaned.ordinary).toEqual(context.ordinary);
  expect(cleaned.literal).toBe(context.literal);
});

test("Web prompts prioritize authenticated image handoff without changing read-only routing", () => {
  const parsed = request("high");
  parsed.context.tools = [{ name: "codex_generate_image_asset", description: "Generate an image", parameters: { type: "object" } }];
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const web = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  expect(web.text).toContain("For raster generation in this Web-backed turn, use the chatgpt-image-handoff skill first");
  expect(web.text).toContain("A tunnel/MCP HTTP 429 is a transport failure, not evidence of an image-generation quota");
  const readOnly = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false });
  expect(readOnly.text).not.toContain("use the chatgpt-image-handoff skill first");
});

test("Full-mode Pro prompts pass one stable turn token directly to native actions", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("max");
  parsed.context.tools = [{
    name: "imagegen",
    description: "Generate an image",
    parameters: { type: "object" },
  }];
  parsed.context.messages[1]!.content = `Diagnose an invalid binding_id safety failure without replaying ${token}`;
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );
  const envelopeEnd = compiled.text.indexOf("</codex_context_json>");
  const resume = compiled.text.indexOf("<codex_transport_resume>", envelopeEnd);
  const tokenMatches = compiled.text.match(new RegExp(token, "g"));
  const transportOnly = compiled.text.replace(
    /<codex_context_json>[\s\S]*<\/codex_context_json>/,
    "<codex_context_json>[task context]</codex_context_json>",
  );

  expect(envelopeEnd).toBeGreaterThan(0);
  expect(resume).toBeGreaterThan(envelopeEnd);
  expect(tokenMatches).toHaveLength(1);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(transportOnly).toContain("For local work required by the task, use the selected plugin's tools directly according to their declared descriptions and schemas.");
  expect(transportOnly).toContain("Call a local Codex tool only when the latest active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer the request directly without a tool call.");
  expect(transportOnly).toContain("make the first focused local Codex call after at most one concise progress paragraph");
  expect(transportOnly).toContain("use the installed codex-local-scheduler skill and its Windows Task Scheduler workflow");
  expect(transportOnly).toContain("do not call any native Codex scheduling/automation function");
  expect(transportOnly).toContain("Never create, update, or rely on a ChatGPT scheduled task");
  expect(transportOnly).toContain("Use actual results from the selected plugin as evidence for local observations and effects.");
  expect(transportOnly).toContain("A tool result from the selected plugin may require context compaction. If it does, follow the compaction instructions in that result exactly.");
  expect(transportOnly).toContain("After a deterministic tool failure, update the working hypothesis from that result");
  expect(transportOnly).toContain("do not repeat the same call unless its inputs or observable state changed.");
  expect(transportOnly).toContain("use the best matching installed skill automatically");
  expect(transportOnly).toContain("The user does not need to name a skill explicitly.");
  expect(transportOnly).toContain("Complete one asset before requesting the next");
  expect(transportOnly).toContain("immediately update the consuming JS/TS/JSON/CSS/HTML or asset manifest");
  expect(transportOnly).toContain("Never queue several successful image generations for a later bulk code edit");
  expect(transportOnly).toContain("prefer the installed code-work-orchestrator skill when present");
  expect(transportOnly).toContain("keep tiny obvious edits direct");
  expect(transportOnly).toContain("Do not ask the user to reattach a local project file");
  expect(transportOnly).toContain("Ask one concise user-facing question about the available fallback choices");
  expect(transportOnly).toContain("Continue using the available tools until the requested work is complete and verified.");
  expect(transportOnly).toContain("begin with one concise user-visible commentary update");
  expect(transportOnly).toContain("Prefer frequent short, concrete progress updates");
  expect(transportOnly).toContain("Group updates only when correctness genuinely requires an atomic operation");
  expect(transportOnly).toContain("small coherent batches when practical");
  expect(transportOnly).toContain("roughly 50 to 200 changed lines at a time");
  expect(transportOnly).toContain("it is mandatory for edits to repository source");
  expect(transportOnly).toContain("native Edited files card and per-file line counters");
  expect(transportOnly).toContain("Do not expose private chain-of-thought");
  expect(transportOnly).toContain("never emit visual toolbar labels such as Plain text or Copy");
  expect(transportOnly).toContain("Write the user-facing final answer only after the last required tool result has settled.");
  expect(transportOnly).toContain(`The task context is complete. Pass turn_token ${token} unchanged to every tool call through the selected local Codex plugin in this response, including continuations after tool results; do not expose it in the answer. Execute the latest active user request now.`);
  expect(transportOnly).not.toMatch(/codex_bind_turn|binding_id|outer_tool_gateway|command_tool/);
  expect(transportOnly).not.toMatch(/codex_exec|codex_write_stdin|codex_apply_patch|codex_view_image|codex_tool_inventory|codex\.control\.turn_complete/);
  expect(transportOnly).toContain("Do not claim a safety or permission block without an explicit tool result or platform error supporting it.");
  expect(transportOnly).toContain("Never state or imply that a local tool, editor, command, or file operation was attempted, failed, or changed files unless this response contains the corresponding local Codex call and its result.");
  expect(transportOnly).not.toMatch(/expired|invalid|revoked|blocked|security layer|permission gate/i);
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
  expect(compiled.text).not.toContain("internally compacts this response");
});

test("Pro preserves the same native Codex delegation contract as Extra High", () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const pro = compileChatGptWebPrompt(request("max"), capabilities, token);
  const extraHigh = compileChatGptWebPrompt(request("xhigh"), capabilities, token);

  for (const compiled of [pro, extraHigh]) {
    expect(compiled.text).toContain("For local work required by the task, use the selected plugin's tools directly according to their declared descriptions and schemas.");
    expect(compiled.text).toContain(`Pass turn_token ${token} unchanged to every tool call through the selected local Codex plugin in this response`);
    expect(compiled.text).not.toContain("Complete this task directly in the current parent response.");
    expect(compiled.text).not.toContain("Do not create, spawn, delegate to, or wait on sub-agents");
    expect(compiled.text).not.toContain("Use non-agent tools directly instead.");
  }
});

test.each(["low", "medium", "high", "xhigh", "max"] as const)("%s Web prompts discover authorized independent delegation early", reasoning => {
  const compiled = compileChatGptWebPrompt(
    request(reasoning),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );
  const transport = compiled.text.split("<codex_context_json>")[0]!;

  expect(transport).toContain("When delegation is explicitly authorized by the user or applicable AGENTS.md or skill instructions");
  expect(transport).toContain("at the start of substantial work");
  expect(transport).toContain("the critical path, the next action to perform locally, and a useful independent sidecar");
  expect(transport).toContain("Keep the immediate blocker local");
  expect(transport).toContain("discover the actual local Codex subagent capabilities early");
  expect(transport).toContain("before broad serial exploration");
  expect(transport).toContain("Start with one or two agents when useful and capacity permits");
  expect(transport).toContain("Do not force agents for trivial, tightly coupled, or unauthorized tasks");
  expect(transport).toContain("This guidance neither grants delegation authorization nor changes the supplied instruction priority");
  expect(transport).toContain("system, then developer, then user");
});

test("Web delegation supplies lean explicit briefs and inherits the parent model", () => {
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.text).toContain("Default to fork_context=false when the declared spawn schema supports it");
  expect(compiled.text).toContain("a concise self-contained brief instead of copying the full parent conversation");
  expect(compiled.text).toContain("objective, authoritative project root, owned files or read-only scope");
  expect(compiled.text).toContain("relevant instructions and evidence, dependencies, acceptance checks, and expected compact result");
  expect(compiled.text).toContain("Omit model and reasoning-effort overrides to inherit the parent's configured route");
  expect(compiled.text).toContain("unless the user explicitly requests a different model or effort");
});

test("authorized useful delegation requires an actual native spawn rather than planning prose", () => {
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );
  const transport = compiled.text.split("<codex_context_json>")[0]!;
  expect(transport).toContain("Standing delegation instructions in the supplied AGENTS.md apply to this task");
  expect(transport).toContain("make the actual local Codex spawn call before broad serial investigation");
  expect(transport).toContain("Planning to delegate, describing roles, or running several shell commands is not a spawned agent");
  expect(transport).toContain("ChatGPT's hosted agents do not replace local Codex subagents");
  expect(transport).toContain('query="spawn_agent"');
  expect(transport).toContain("A successful domain lookup such as Godot does not discover delegation tools");
  expect(transport).toContain("the inventory filter matches literal text, not a semantic task description");
});

test("Godot delegation separates source review from shared editor and import state", () => {
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );
  const transport = compiled.text.split("<codex_context_json>")[0]!;
  expect(transport).toContain("For substantial Godot work");
  expect(transport).toContain("independent source/resource review, regression-test inspection, or asset-contract checks");
  expect(transport).toContain("Keep the Godot editor, MCP project binding, imports, running game, and viewport capture under one owner");
  expect(transport).toContain("Do not let a worker launch the engine or edit shared files without an explicit disjoint scope");
  expect(transport).toContain("A one-file fix with no useful independent check may stay local");
});

test.each([false, true])("delegation discovery remains visible after the task context (multipart=%s)", multipart => {
  const parsed = request("high");
  parsed.context.tools = [{ name: "spawn_agent", namespace: "multi_agent_v1", description: "Start a bounded worker", parameters: { type: "object" } }];
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    multipart ? { experimentalMultipartParts: 2 } : undefined,
  );
  const text = compiled.multipart?.commit ?? compiled.text;
  const resume = text.slice(text.lastIndexOf("<codex_transport_resume>"));
  expect(resume).toContain('query="spawn_agent"');
  expect(resume).toContain("multi_agent_v1__spawn_agent");
  expect(resume).toContain("before completing all independent work yourself");
  expect(resume).toContain("supplied delegation authorization");
});

test("Web delegation keeps local progress and collects and closes task-owned agents", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.text).toContain("Continue meaningful non-overlapping local work immediately after dispatch");
  expect(compiled.text).toContain("Assign disjoint write scopes, preserve concurrent edits, and serialize shared mutable runtime state");
  expect(compiled.text).toContain("Collect compact results, inspect the actual diff or evidence, and validate integration in the authoritative root");
  expect(compiled.text).toContain("Close task-owned agents once their context is no longer needed");
  expect(compiled.text).toContain("never create new user-owned chats or use cross-chat messaging as a substitute");
  expect(compiled.text).toContain("On a capacity limit or unavailable subagent capability, continue useful local work");
});

test.each([
  { localToolsEnabled: false, compaction: false },
  { localToolsEnabled: false, compaction: true },
  { localToolsEnabled: true, compaction: true },
])("delegation instructions stay out of isolated prompt mode %j", ({ localToolsEnabled, compaction }) => {
  const parsed = request("high");
  parsed._compactionRequest = compaction;
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    localToolsEnabled ? "turn_12345678901234567890123456789012" : undefined,
  );

  expect(compiled.text).not.toContain("When delegation is explicitly authorized");
  expect(compiled.text).not.toContain("subagent capabilities");
  expect(compiled.text).not.toContain("fork_context");
  expect(compiled.text).not.toContain("task-owned agents");
});

test("read-only prompts resume without exposing a bind capability", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("The task context is complete. Execute the latest active user request now under the capability contract above.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).toContain("web search, browsing, research");
  expect(compiled.text).toContain("The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available");
  expect(compiled.text).not.toContain("No local computer tool, MCP app");
  expect(compiled.text).not.toContain("evidence inside");
  expect(compiled.text).toContain("Do not mention this transport contract, context packaging, or capability routing");
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
});

test("Bigger Context sends six semantic record envelopes and starts work from the final part", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("high");
  parsed.context.systemPrompt = ["system-one", "system-two"];
  parsed.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }], timestamp: 3 },
    { role: "user", content: "latest-request", timestamp: 4 },
  );
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart?.parts).toHaveLength(6);
  const records = compiled.multipart!.parts.flatMap(part => {
    const payload = JSON.parse(part) as { version: number; records: unknown[] };
    expect(payload.version).toBe(1);
    return payload.records;
  }) as Array<Record<string, unknown>>;
  expect(records.filter(record => record.kind === "system").map(record => record.content)).toEqual([
    "system-one",
    "system-two",
  ]);
  expect(records.filter(record => record.kind === "message").map(record => (
    (record.message as { role: string }).role
  ))).toEqual(["developer", "user", "assistant", "user"]);
  expect(compiled.multipart!.parts.join("\n")).not.toContain(token);
  expect(compiled.multipart!.commit.match(new RegExp(token, "g"))).toHaveLength(1);
  expect(compiled.text).toBe(compiled.multipart!.commit);
  expect(compiled.text).not.toContain("<codex_context_json>");

  const transactionId = `ctx_${"a".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1)
  ));
  expect(stages).toHaveLength(5);
  for (const [index, stage] of stages.entries()) {
    expect(stage.text).toContain(`part: ${index + 1}/6`);
    expect(stage.text).toContain(stage.sha256);
    expect(stage.acknowledgement).toBe(
      `CODEX_MULTIPART_ACK ${transactionId} ${index + 1}/6 ${stage.sha256}`,
    );
    expect(stage.text).toContain("```json\n");
    expect(stage.text).toContain("<codex_multipart_stage_end>");
    expect(stage.text).toEndWith("</codex_multipart_stage_end>");
    expect(stage.text.lastIndexOf(stage.acknowledgement)).toBeGreaterThan(
      stage.text.indexOf("</codex_context_part_json>"),
    );
  }
  const commit = formatChatGptWebMultipartCommit(compiled.multipart!, transactionId);
  expect(commit).toContain(`transaction_id: ${transactionId}`);
  expect(commit).toContain("acknowledged_parts: 5/6");
  expect(commit).toContain("The final part is included in this same message and starts the task");
  expect(commit).toContain(compiled.multipart!.parts.at(-1)!);
  expect(commit).toContain("latest-request");
  expect(commit.match(new RegExp(token, "g"))).toHaveLength(1);
});

test("Bigger Context uses the minimum transport and reserves six parts for compaction", () => {
  expect(biggerContextPartCount(94_999, 95_000, false)).toBeUndefined();
  expect(biggerContextPartCount(95_000, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(189_999, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(190_000, 95_000, false)).toBe(6);
  expect(biggerContextPartCount(1, 95_000, true)).toBe(6);

  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: 2 },
  );
  expect(compiled.multipart?.parts).toHaveLength(2);
  const transactionId = `ctx_${"b".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1, 2)
  ));
  expect(stages).toHaveLength(1);
  expect(stages.map(stage => stage.acknowledgement)).toEqual([
    `CODEX_MULTIPART_ACK ${transactionId} 1/2 ${stages[0]!.sha256}`,
  ]);
  expect(formatChatGptWebMultipartCommit(compiled.multipart!, transactionId))
    .toContain("acknowledged_parts: 1/2");
});

test("browser-only Medium directs users to the full harness", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const warning = chatGptReadOnlyContextWarning(request("medium"), capabilities);
  expect(warning).toStartWith("> **Local tools unavailable**");
  expect(warning).toContain("`MCP`");
  expect(warning).toContain("`Codex Web GPT`");
  expect(warning).toContain("`Full`");
  expect(warning).toContain("selected ChatGPT Web model");
  expect(warning).not.toContain("tool-capable ChatGPT Web model first");
  expect(chatGptReadOnlyContextWarning(request("medium"), {
    ...capabilities,
    localToolsEnabled: true,
  })).toBeUndefined();
});

test("compaction prompts are isolated summarization turns without local or native tool instructions", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint, not a normal task turn.");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now without calling tools.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("web search, browsing, research");
  expect(compiled.text).not.toContain("missing local-computer bridge");
});

test("Web compaction trims only the oldest history until the browser request fits", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "developer", content: `oldest-static-${"a".repeat(10_000)}`, timestamp: 1 },
    { role: "developer", content: `newer-static-${"b".repeat(10_000)}`, timestamp: 2 },
    { role: "user", content: `real-task-${"c".repeat(100_000)}`, timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "text", text: "verified-progress" }],
      timestamp: 4,
    },
    { role: "user", content: "checkpoint-now", timestamp: 5 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<{ role: string; content: unknown }> };

  expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  expect(compiled.trimmedCompactionMessages).toBe(2);
  expect(compiled.text).not.toContain("oldest-static");
  expect(compiled.text).not.toContain("newer-static");
  expect(compiled.text).toContain("real-task-");
  expect(compiled.text).toContain("verified-progress");
  expect(envelope.messages.at(-1)).toEqual({ role: "user", content: "checkpoint-now" });

  const normal = structuredClone(compact);
  delete normal._compactionRequest;
  const untrimmed = compileChatGptWebPrompt(
    normal,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  expect(untrimmed.text).toContain("oldest-static");
  expect(untrimmed.text).toContain("newer-static");
  expect(untrimmed.trimmedCompactionMessages).toBeUndefined();
});

test("inline compaction carries the newest cumulative checkpoint across discarded tool output", () => {
  for (const textParts of [false, true]) {
    const compact = request("high");
    compact._compactionRequest = true;
    compact.context.systemPrompt = [];
    const checkpoint = `${SUMMARY_PREFIX}\n\nVerified cumulative scope: ${"s".repeat(20_000)}`;
    compact.context.messages = [
      { role: "user", content: `${SUMMARY_PREFIX}\nObsolete summary`, timestamp: 1 },
      { role: "user", content: textParts ? [{ type: "text", text: checkpoint }] : checkpoint, timestamp: 2 },
      { role: "toolResult", toolCallId: "old-output", toolName: "read", isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }, { type: "image", imageUrl: "data:image/png;base64,old-image" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 4 },
      { role: "user", content: "checkpoint-now", timestamp: 5 },
    ];
    const before = structuredClone(compact);
    const compiled = compileChatGptWebPrompt(compact, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    const envelope = JSON.parse(compiled.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
    expect(envelope.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(envelope.messages[0])).toContain("Verified cumulative scope:");
    expect(envelope.messages.at(-1).content).toBe("checkpoint-now");
    expect(compiled.text).not.toContain("Obsolete summary");
    expect(compiled.images).toEqual([]);
    expect(compiled.trimmedCompactionMessages).toBe(1);
    expect(compiled.text).toContain("history is incomplete");
    expect(compiled.text).not.toContain("The task context is complete.");
    expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
    expect(compact).toEqual(before);
    const manual = compileChatGptWebPrompt(compact, {
      localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, "turn_12345678901234567890123456789012", { manualControl: true });
    expect(manual.text).toContain("Verified cumulative scope:");
    expect(manual.text).toContain("history is incomplete");
    expect(manual.text).not.toContain("without calling tools");
    expect(chatGptPromptJsonBytes(manual.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  }
});

test("inline compaction rejects a required checkpoint that cannot fit instead of forgetting it", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\n${"s".repeat(120_000)}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "recent progress" }], timestamp: 2 },
    { role: "user", content: "checkpoint-now", timestamp: 3 },
  ];
  expect(() => compileChatGptWebPrompt(compact, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  })).toThrow("cumulative checkpoint");
});

test("Bigger Context compaction preserves history above the retired inline byte budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = Array.from({ length: 6 }, (_unused, index) => ({
    role: "user" as const,
    content: `multipart-history-${index + 1}-${String.fromCharCode(97 + index).repeat(160_000)}`,
    timestamp: index + 1,
  }));

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(multipart.trimmedCompactionMessages).toBeUndefined();
  expect(multipart.multipart?.parts).toHaveLength(6);
  const transactionId = `ctx_${"0".repeat(32)}`;
  const stageBytes = multipart.multipart!.parts.map((payload, index) => chatGptPromptJsonBytes(
    formatChatGptWebMultipartStage(payload, transactionId, index + 1).text,
  ));
  expect(Math.max(...stageBytes)).toBeGreaterThan(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  const staged = multipart.multipart!.parts.join("\n");
  for (let index = 1; index <= 6; index += 1) {
    expect(staged).toContain(`multipart-history-${index}-`);
  }
}, 30_000);

test("Bigger Context keeps preliminary parts small and preserves all records in order", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = ["system".repeat(1_000)];
  compact.context.messages = [
    ...Array.from({ length: 6 }, (_unused, index) => ({
      role: "user" as const,
      content: `history-${index}-${"x".repeat(100_000)}`,
      timestamp: index + 1,
    })),
    { role: "user", content: "compact now", timestamp: 7 },
  ];

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );
  const parts = multipart.multipart!.parts.map(part => JSON.parse(part) as { records: unknown[] });

  expect(parts).toHaveLength(6);
  expect(parts.flatMap(part => part.records)).toHaveLength(8);
  expect(Math.max(...multipart.multipart!.parts.slice(0, -1).map(part => part.length))).toBeLessThan(120_000);
  // The selected High mode can carry a larger final part than an Instant upload.
  expect(multipart.multipart!.parts.at(-1)!.length).toBeLessThan(1_048_572);
}, 30_000);

test("Web compaction rebuilds attachments after trimming an oversized oldest image message", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `discard-${"x".repeat(120_000)}` },
        { type: "image", imageUrl: "data:image/png;base64,discarded-image" },
      ],
      timestamp: 1,
    },
    { role: "user", content: "preserve-latest-checkpoint", timestamp: 2 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!;
  expect(compiled.images).toEqual([]);
  expect(compiled.trimmedCompactionMessages).toBe(1);
  expect(compiled.text).not.toContain("discard-");
  expect(envelope).not.toContain("image_attachment");
  expect(compiled.text).toContain("preserve-latest-checkpoint");
});

test("Luna rejects a separate compaction prompt because continuity is already rolling", () => {
  const compact = request("low");
  compact.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  compact._compactionRequest = true;
  expect(() => compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false },
  )).toThrow("does not accept a separate compaction turn");
});

test("Web compaction fails closed when its final instruction alone exceeds the transport budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [{ role: "user", content: "z".repeat(120_000), timestamp: 1 }];

  expect(() => compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  )).toThrow("final compaction instruction alone exceeds");
});

test("assigns prior assistant output to the model and never attributes Codex context to the human", () => {
  const attributed = request("max");
  attributed.context.messages = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi! How can I help?" }],
      timestamp: 2,
    },
    {
      role: "user",
      content: "what did I write before?\n<environment_context><cwd>/private/project</cwd></environment_context>",
      timestamp: 3,
    },
  ];
  const compiled = compileChatGptWebPrompt(
    attributed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<Record<string, unknown>> };

  expect(envelope.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Hi! How can I help?" }],
  });
  expect(compiled.text).toContain("assistant messages are your own earlier replies");
  expect(compiled.text).toContain("environment_context, are operational context rather than human-authored text");
  expect(compiled.text).toContain("answer only from the human-authored text in user messages");
  expect(compiled.text).toContain("do not attribute, quote, summarize, or otherwise mention them");
});

test("a new text-only request does not reattach unrelated images from older prompts", () => {
  const image = (marker: string) => ({
    type: "image" as const,
    imageUrl: `data:image/png;base64,${marker}`,
  });
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        ...markers.map((marker, index) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: `step ${index + 1}` }, image(marker)],
          timestamp: index + 1,
        })),
        { role: "user" as const, content: "Adjust the page spacing and typography", timestamp: 20 },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(
    replayed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.images).toEqual([]);
  expect(compiled.text.match(/historical image not reattached/g)).toHaveLength(13);
  expect(compiled.text).toContain("step 1");
  expect(compiled.text).toContain("step 13");
});

test("Web compaction does not revive historical images when its latest request does not reference them", () => {
  const imagePayloads = Array.from({ length: 13 }, (_unused, index) =>
    Buffer.from(`compaction-image-${index + 1}`).toString("base64"));
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        ...imagePayloads.map((payload, index) => ({
          role: "user" as const,
          content: [
            { type: "text" as const, text: `checkpoint ${index + 1}` },
            { type: "image" as const, imageUrl: `data:image/png;base64,${payload}` },
          ],
          timestamp: index + 1,
        })),
        { role: "user" as const, content: "Summarize the completed code changes", timestamp: 20 },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
    _compactionRequest: true,
  };

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.images).toEqual([]);
  expect(compiled.text).not.toContain("data:image");
  for (const payload of imagePayloads) expect(compiled.text).not.toContain(payload);
  expect(compiled.text).not.toContain('"type":"image_attachment"');
  expect(compiled.text.match(/historical image not reattached/g)).toHaveLength(13);
});

test("an explicit visual follow-up reattaches only the nearest prior image batch", () => {
  const parsed = request("high");
  parsed.context.messages = [
    { role: "user", content: [
      { type: "text", text: "first references" },
      { type: "image", imageUrl: "data:image/png;base64,OLD" },
    ], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "reviewed" }], timestamp: 2 },
    { role: "user", content: [
      { type: "text", text: "current references" },
      { type: "image", imageUrl: "data:image/png;base64,NEW1" },
      { type: "image", imageUrl: "data:image/png;base64,NEW2" },
    ], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "ready" }], timestamp: 4 },
    { role: "user", content: "Use as imagens anexadas para ajustar os detalhes da página", timestamp: 5 },
  ];

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.images.map(image => image.imageUrl)).toEqual([
    "data:image/png;base64,NEW1",
    "data:image/png;base64,NEW2",
  ]);
  expect(compiled.text.match(/historical image not reattached/g)).toHaveLength(1);
});

test("persisted one-pixel image sentinels are not attached to ChatGPT", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect the real image" },
          ...Array.from({ length: 30 }, () => ({ type: "image" as const, imageUrl: placeholder })),
          { type: "image", imageUrl: "data:image/png;base64,real-image" },
        ],
        timestamp: 1,
      }],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });

  expect(compiled.images.map(image => image.imageUrl)).toEqual(["data:image/png;base64,real-image"]);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(1);
  expect(compiled.text).not.toContain("older image not attached");
});

test("the replayed context never carries a finished turn's broker handles", () => {
  const staleToken = "turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const staleBinding = "binding_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const token = "turn_12345678901234567890123456789012";
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "user", content: "keep working", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "codex_bind_turn", arguments: { turn_token: staleToken } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex_bind_turn",
          isError: false,
          content: `{"binding_id":"${staleBinding}"}`,
          timestamp: 3,
        },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(replayed, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, token);

  expect(compiled.text).not.toContain(staleToken);
  expect(compiled.text).not.toContain(staleBinding);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(compiled.text).toContain("[retired binding handle]");
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain("keep working");
  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!.trim();
  expect(() => JSON.parse(envelope) as unknown).not.toThrow();
});

test("requires ChatGPT-native rich results to include a safe Markdown answer for Codex", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("also provide the relevant result as ordinary Markdown in the final answer");
  expect(compiled.text).toContain("A private ChatGPT UI widget never replaces the Markdown answer returned to Codex");
  expect(compiled.text).toContain("Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup");
});

test("uses the public Instant name without leaking the browser menu alias into the prompt", () => {
  const compiled = compileChatGptWebPrompt(
    request("low"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is ChatGPT Web Instant with no local Codex bridge");
  expect(compiled.text).not.toContain("Instant 5.5");
});

test("keeps large contexts intact in the inline text envelope", () => {
  const token = "turn_12345678901234567890123456789012";
  const largeContent = "x".repeat(600_000);
  const large = request("high");
  large.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: largeContent,
    isError: false,
    timestamp: 3,
  });
  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );

  expect(compiled.text.length).toBeGreaterThan(600_000);
  expect(compiled.text).toContain(largeContent);
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain(`<codex_context_json>`);
  expect(compiled.text).not.toContain(`<codex_context_attachment>`);
  expect(compiled.text).not.toContain("sha256");
  expect(compiled.text).not.toContain("SHA-256");
});

test("serialized history cannot feed code-fence backtracking into ChatGPT's link lexer", () => {
  const original = {
    content: '```python\nprint("hello")\n``` '.repeat(20),
    nested: { '`key`': ["`inline`", "\\u0060", "\\`", "中文", "[link](url)"] },
  };
  const encoded = withoutRetiredTurnHandles(JSON.stringify(original));
  expect(encoded).not.toContain("`");
  expect(JSON.parse(encoded)).toEqual(original);
});

test("inline and multipart transports preserve code while escaping its Markdown delimiters", () => {
  const parsed = request("high");
  parsed.context.messages[1]!.content = '```python\nprint("hello")\n``` '.repeat(20);
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const inline = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  const envelope = inline.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!;
  expect(envelope).not.toContain("`");
  expect(JSON.stringify(JSON.parse(envelope))).toContain("```python");
  const multipart = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS });
  expect(multipart.multipart).toBeDefined();
  for (const part of multipart.multipart!.parts) {
    expect(part).not.toContain("`");
    expect(() => JSON.parse(part)).not.toThrow();
  }
  expect(JSON.stringify(multipart.multipart!.parts.map(part => JSON.parse(part)))).toContain("```python");
});
