import { readFile } from "node:fs/promises";
import { join } from "node:path";

const profile = process.env.USERPROFILE;
if (!profile) throw new Error("USERPROFILE is unavailable");

const auth = JSON.parse(await readFile(join(profile, ".codex", "auth.json"), "utf8"));
const config = JSON.parse(await readFile(join(profile, ".codex-chatgpt-web", "config.json"), "utf8"));
const token = auth?.tokens?.access_token;
if (!token) throw new Error("Codex access token is unavailable");

const phrase = `MEDIUM_OK_${Date.now()}`;
const turnId = `turn_live_medium_${Date.now()}`;
const threadId = `thread_live_medium_${Date.now()}`;
const cwd = process.cwd();
const turnMetadata = JSON.stringify({
  thread_id: threadId,
  turn_id: turnId,
  request_kind: "turn",
  sandbox: "none",
  workspaces: { [cwd]: {} },
});
const environment = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
const response = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "chatgpt-web/gpt-5.6-sol",
    reasoning: { effort: "medium" },
    client_metadata: {
      "x-codex-turn-metadata": turnMetadata,
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Responda somente com ${phrase}` }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
    store: false,
    stream: true,
  }),
});

if (!response.ok) {
  throw new Error(`HTTP ${response.status}: ${await response.text()}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let raw = "";
let output = "";
let completed = false;
let failed = null;

for (;;) {
  const { done, value } = await reader.read();
  raw += decoder.decode(value ?? new Uint8Array(), { stream: !done });
  const frames = raw.split("\n\n");
  raw = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data);
    if (event.type === "response.output_text.delta") output += event.delta ?? "";
    if (event.type === "response.completed") completed = true;
    if (event.type === "response.failed") failed = event.response?.error ?? event.error ?? event;
  }
  if (done) break;
}

if (failed) throw new Error(`response.failed: ${JSON.stringify(failed)}`);
if (!completed) throw new Error("stream ended without response.completed");
if (!output.replaceAll("\\_", "_").includes(phrase)) throw new Error(`unexpected output: ${output}`);

console.log(JSON.stringify({ ok: true, effort: "medium", completed, phraseMatched: true }));
