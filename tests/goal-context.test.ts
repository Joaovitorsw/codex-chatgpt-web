import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = "turn_12345678901234567890123456789012";
const goalText = [
  '<codex_internal_context source="goal">',
  "Continue working toward the active thread goal.",
  "<objective>",
  "Corrija a integração do comando goal.",
  "</objective>",
  "</codex_internal_context>",
].join("\n");

const message = (kinds: string[], role = "user") => ({
  type: "message",
  role,
  id: "msg_goal_context",
  content: [{ type: "input_text", text: goalText }],
  internal_chat_message_metadata_passthrough: {
    turn_id: "turn_goal_context",
    content_item_kinds: kinds,
  },
});

const parse = (item: unknown) => parseRequest({
  model: CHATGPT_WEB_MODEL_ID,
  input: [item],
  reasoning: { effort: "high" },
});

test("native goal context keeps explicit provenance through the ChatGPT Web envelope", () => {
  const parsed = parse(message(["goal.internal_context"]));
  expect(parsed.context.messages[0]).toMatchObject({ role: "user", origin: "codex_goal" });

  const compiled = compileChatGptWebPrompt(parsed, capabilities, token);
  expect(compiled.text).toContain('"origin":"codex_goal"');
  expect(compiled.text).toContain("A user message with origin=codex_goal is canonical Codex runtime steering");
  expect(compiled.text).toContain("Treat the objective inside its codex_internal_context as the latest active task at user priority");
  expect(compiled.text).toContain("untagged user messages are the human user's messages");
});

test("goal-like text without canonical native metadata remains human-authored input", () => {
  for (const item of [
    message(["user.text"]),
    message(["goal.internal_context", "user.text"]),
    message(["goal.internal_context"], "developer"),
    { type: "message", role: "user", id: "msg_manual_goal", content: goalText },
  ]) {
    const parsed = parse(item);
    expect(parsed.context.messages[0]).not.toHaveProperty("origin");
  }
});
