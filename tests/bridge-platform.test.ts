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
