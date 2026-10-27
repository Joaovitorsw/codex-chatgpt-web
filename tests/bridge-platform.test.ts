import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* completedEvents(chunks = 1): AsyncGenerator<AdapterEvent> {
  for (let index = 0; index < chunks; index++) {
    yield { type: "text_delta", text: `chunk-${index}:` + "x".repeat(2_048) };
  }
  yield { type: "done", endTurn: true };
}

function responseStream(platform: NodeJS.Platform, chunks = 1): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    completedEvents(chunks),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { streamPlatform: platform },
  );
}

test("Responses SSE completes through the Windows push stream", async () => {
  const body = await new Response(responseStream("win32")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("a completed tool-use response does not abort before Codex can execute it", async () => {
  async function* toolUse(): AsyncGenerator<AdapterEvent> {
    yield { type: "tool_call_start", id: "call_bridge_roundtrip", name: "exec_command" };
    yield { type: "tool_call_delta", arguments: '{"cmd":"Get-Location"}' };
    yield { type: "tool_call_end" };
    yield { type: "done", stopReason: "tool_use", endTurn: false };
  }

  let aborts = 0;
  const body = await new Response(bridgeToResponsesSSE(
    toolUse(),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    () => { aborts += 1; },
    2_000,
    { streamPlatform: "win32" },
  )).text();

  expect(aborts).toBe(0);
  expect(body).toContain('"call_id":"call_bridge_roundtrip"');
  expect(body).toContain('"end_turn":false');
  expect(body).toContain("event: response.completed");
});

test("DevSpace read and edit emit distinct native tool cards with their original arguments", async () => {
  async function* devSpaceCalls(): AsyncGenerator<AdapterEvent> {
    for (const [id, name, args] of [
      ["call_read", "mcp__Codex_Native2__read", { workspaceId: "ws_fixture", path: "src/main.ts" }],
      ["call_edit", "mcp__Codex_Native2__edit", { workspaceId: "ws_fixture", path: "src/main.ts", edits: [{ oldText: "before", newText: "after" }] }],
    ] as const) {
      yield { type: "tool_call_start", id, name };
      yield { type: "tool_call_delta", arguments: JSON.stringify(args) };
      yield { type: "tool_call_end" };
    }
    yield { type: "done", stopReason: "tool_use", endTurn: false };
  }
  const namespace = "mcp__Codex_Native2";
  const toolNsMap = new Map([
    [`${namespace}__read`, { namespace, name: "read" }],
    [`${namespace}__edit`, { namespace, name: "edit" }],
  ]);
  const body = await new Response(bridgeToResponsesSSE(devSpaceCalls(), "chatgpt-web/test", toolNsMap, undefined, undefined, undefined, 2_000, { streamPlatform: "win32" })).text();
  expect(body).toContain('"call_id":"call_read"');
  expect(body).toContain('"call_id":"call_edit"');
  expect(body).toContain('"name":"read","arguments"');
  expect(body).toContain('"name":"edit","arguments"');
  expect((body.match(/"namespace":"mcp__Codex_Native2"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect(body).toContain("response.function_call_arguments.delta");
  expect(body).toContain('\\"oldText\\"');
  expect(body).toContain('\\"newText\\"');
  expect((body.match(/event: response.output_item.added/g) ?? []).length).toBe(2);
  expect((body.match(/event: response.output_item.done/g) ?? []).length).toBe(2);
});

test("DevSpace tool activity is streamed before the function call finishes", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  async function* activity(): AsyncGenerator<AdapterEvent> {
    yield { type: "tool_call_start", id: "call_live_read", name: "mcp__Codex_Native2__read" };
    await gate;
    yield { type: "tool_call_delta", arguments: '{"workspaceId":"ws_fixture","path":"README.md"}' };
    yield { type: "tool_call_end" };
    yield { type: "done", stopReason: "tool_use", endTurn: false };
  }
  const stream = bridgeToResponsesSSE(activity(), "chatgpt-web/test", undefined, undefined, undefined, undefined, 2_000, { streamPlatform: "win32" });
  const reader = stream.getReader();
  try {
    let initial = "";
    while (!initial.includes("event: response.output_item.added")) {
      const chunk = await reader.read();
      expect(chunk.done).toBeFalse();
      initial += new TextDecoder().decode(chunk.value);
    }
    expect(initial).toContain("response.output_item.added");
    expect(initial).toContain("call_live_read");
    expect(initial).not.toContain("response.completed");
    release?.();
    let remainder = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += new TextDecoder().decode(chunk.value);
    }
    expect(remainder).toContain("response.function_call_arguments.delta");
    expect(remainder).toContain("response.output_item.done");
    expect(remainder).toContain("response.completed");
  } finally {
    release?.();
    await reader.cancel().catch(() => {});
  }
});

test("a completed image relay emits the Responses image-generation lifecycle", async () => {
  async function* imageRelay(): AsyncGenerator<AdapterEvent> {
    yield { type: "image_generation", result: "cG5nLWJ5dGVz", revisedPrompt: "maçã existente", phase: "final_answer" };
    yield { type: "done", endTurn: true };
  }

  const body = await new Response(bridgeToResponsesSSE(
    imageRelay(), "chatgpt-web/test", undefined, undefined, undefined, undefined, 2_000, { streamPlatform: "win32" },
  )).text();

  expect(body).toContain("event: response.image_generation_call.in_progress");
  expect(body).toContain("event: response.image_generation_call.generating");
  expect(body).toContain("event: response.image_generation_call.partial_image");
  expect(body).toContain('"partial_image_b64":"cG5nLWJ5dGVz"');
  expect(body).toContain("event: response.image_generation_call.completed");
  expect(body).toContain('"type":"image_generation_call"');
  expect(body).toContain('"result":"cG5nLWJ5dGVz"');
});

test("Darwin SSE remains decodable through Bun.serve under sustained chunking", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(responseStream("darwin", 64), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("chunk-63:");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  } finally {
    await server.stop(true);
  }
});
