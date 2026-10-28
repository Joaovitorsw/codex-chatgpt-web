import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

test.each(["low", "high", "max"] as const)("%s model handoff emits continuity instructions and preserves completion history", reasoning => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning },
    context: { messages: [
      { role: "user", content: "Create the report file.", timestamp: 1 },
      { role: "assistant", phase: "final_answer", content: [{ type: "text", text: "Report created and verified." }], timestamp: 2 },
      { role: "developer", content: "<model_switch>Web model selected.</model_switch>", timestamp: 3 },
      { role: "user", content: "Explain the report's conclusion.", timestamp: 4 },
    ] },
  };
  const compiled = compileChatGptWebPrompt(parsed, {
    localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  }, "turn_12345678901234567890123456789012");
  const [contract, context] = compiled.text.split("<codex_context_json>");
  expect(contract).toContain("A model switch changes the backend, not the task's progress");
  expect(contract).toContain("Do not replay completed actions or reopen answered requests merely because they appear in history");
  expect(contract).toContain("A final_answer marks the end of a response, not proof that every task or deliverable was completed");
  expect(contract).toContain("Stale checklists, memory, and earlier plans must be reconciled with later completion evidence");
  expect(context).toContain('"phase":"final_answer"');
  expect(context).toContain("Report created and verified.");
  expect(context).toContain("Explain the report's conclusion.");
  expect(compiled.text.split("</codex_context_json>")[1]).toContain("Continue from the recorded progress; do not restart completed work.");
});

test.each([false, true])("switch-only history carries continuity instructions in multipart=%s", multipart => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "high", ...(multipart ? { biggerContext: true } : {}) },
    context: { messages: [
      { role: "user", content: "Create the report file.", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Report created and verified." }], timestamp: 2 },
      { role: "developer", content: "<model_switch>Web model selected.</model_switch>", timestamp: 3 },
    ] },
  };
  const compiled = compileChatGptWebPrompt(parsed, {
    localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  }, "turn_12345678901234567890123456789012", multipart ? { experimentalMultipartParts: 2 } : undefined);
  expect(!!compiled.multipart).toBe(multipart);
  expect(compiled.text).toContain("If the supplied history ends with an answered request and only a model switch or runtime context follows, do not invent a new task or restart the old one.");
  expect(compiled.text).toContain("continue genuinely unfinished work when the current request or active Goal requires it");
  expect(compiled.text).toContain("repeat a completed action only when the user requests repetition or fresh evidence is needed for the current request");
  expect(compiled.text).toContain("Continue from the recorded progress; do not restart completed work.");
  const history = compiled.multipart?.parts.join("\n") ?? compiled.text;
  expect(history).toContain("Report created and verified.");
  expect(parsed.context.messages).toHaveLength(3);
});
