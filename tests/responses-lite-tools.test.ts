import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";

const freeformFormat = {
  type: "grammar",
  syntax: "lark",
  definition: 'start: "tool"',
};

function responsesLiteTools() {
  return [{
    type: "namespace",
    name: "functions",
    description: "",
    tools: [
      { type: "custom", name: "exec", description: "Run native Codex code", format: freeformFormat },
      {
        type: "function",
        name: "wait",
        description: "Wait for native Codex code",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ],
  }, {
    type: "namespace",
    name: "mcp__python",
    description: "Python tools",
    tools: [{
      type: "custom",
      name: "run_script",
      description: "Run a Python script",
      format: freeformFormat,
    }],
  }];
}

test("Responses Lite exposes native exec from the default functions namespace only", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "additional_tools", role: "developer", tools: responsesLiteTools() }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "exec",
    namespace: "functions",
    freeform: true,
  }));
  const waitTool = parsed.context.tools?.find(tool => tool.name === "wait");
  expect(waitTool).toEqual(expect.objectContaining({ name: "wait" }));
  expect(waitTool).not.toHaveProperty("namespace");
  expect(parsed.context.tools?.some(tool => tool.name === "run_script")).toBe(false);
});

for (const stream of [false, true]) test(`Responses Lite native exec preserves its namespace (stream=${stream})`, async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_exec_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_exec_regression" },
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: responsesLiteTools().slice(0, 1),
      }, {
        type: "message",
        id: "msg_responses_lite_exec_regression",
        role: "user",
        content: [{ type: "input_text", text: "Use the native exec tool" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-exec-regression",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
      emit({ type: "tool_call_start", id: "call_exec", name: "functions__exec" });
      emit({ type: "tool_call_delta", arguments: JSON.stringify({ input: "text('ok')" }) });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }), { rememberState: false });

  expect(response.status).toBe(200);
  const events = stream ? (await response.text()).split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>) : [];
  const body = stream
    ? events.find(event => event.type === "response.completed")?.response as { output: Array<Record<string, unknown>> }
    : await response.json() as { output: Array<Record<string, unknown>> };
  const calls = body.output.filter(item => item.type === "custom_tool_call");
  expect(calls).toEqual([expect.objectContaining({
    call_id: "call_exec",
    name: "exec",
    namespace: "functions",
    input: "text('ok')",
  })]);
  if (stream) {
    for (const event of events.filter(event => event.type === "response.output_item.added" || event.type === "response.output_item.done")) {
      expect(event.item).toMatchObject({ type: "custom_tool_call", name: "exec", namespace: "functions" });
    }
  }
});

test("custom call replay preserves the namespace for the next Web turn", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "custom_tool_call", call_id: "call_exec", name: "exec", namespace: "functions", input: "text('ok')" },
      { type: "custom_tool_call_output", call_id: "call_exec", output: "ok" }],
  });
  expect(parsed.context.messages[0]).toMatchObject({ role: "assistant", content: [expect.objectContaining({
    type: "toolCall", name: "exec", namespace: "functions", arguments: { input: "text('ok')" },
  })] });
});
