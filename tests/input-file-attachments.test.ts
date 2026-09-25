import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt, validateChatGptInputFiles } from "../src/adapters/chatgpt-web/prompt";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = "turn_12345678901234567890123456789012";

function compile(fileData: string, filename = "relatorio.txt") {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    reasoning: { effort: "high" },
    input: [{ role: "user", content: [
      { type: "input_text", text: "Leia o arquivo anexado." },
      { type: "input_file", filename, file_data: fileData },
    ] }],
  });
  return compileChatGptWebPrompt(parsed, capabilities, token);
}

test("Codex input_file bytes reach the browser payload with their original filename", () => {
  const text = "conteúdo do arquivo\nsegunda linha";
  const compiled = compile(`data:text/plain;base64,${Buffer.from(text).toString("base64")}`);
  expect(compiled.text).toContain('"type":"file_attachment"');
  expect(compiled.text).toContain('"filename":"relatorio.txt"');
  expect(compiled.text).not.toContain(Buffer.from(text).toString("base64"));
  expect(compiled.inputFiles).toHaveLength(1);
  expect(() => validateChatGptInputFiles(compiled.inputFiles)).not.toThrow();
  const payload = chatGptPromptFilePayloads(compiled).find(file => file.name === "relatorio.txt");
  expect(payload?.mimeType).toBe("text/plain");
  expect(payload?.buffer.toString("utf8")).toBe(text);
});

test("input_file transport sanitizes paths and rejects modified bytes", () => {
  const compiled = compile(Buffer.from("safe").toString("base64"), "C:\\temp\\notes?.md");
  expect(compiled.inputFiles?.[0]?.name).toBe("notes-.md");
  const tampered = structuredClone(compiled.inputFiles!);
  tampered[0]!.base64 = Buffer.from("changed").toString("base64");
  expect(() => validateChatGptInputFiles(tampered)).toThrow("integrity hash");
  expect(compiled.inputFiles?.[0]?.sha256).toBe(createHash("sha256").update("safe").digest("hex"));
});

test("file_id-only references remain explicit instead of pretending an upload occurred", () => {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    input: [{ role: "user", content: [{ type: "input_file", filename: "missing.pdf", file_id: "file_123" }] }],
  });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token);
  expect(compiled.inputFiles).toBeUndefined();
  expect(compiled.text).toContain("[file unavailable: file_123]");
});
