import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { buildResponseJSON } from "../src/bridge";
import { RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { materializeFinalImages, presentedImageRef } from "../src/adapters/chatgpt-web/final-images";

const gif = Buffer.from("R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQICAAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQIDAAAACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7", "base64");

test("animated GIF registers final media and survives MCP, broker and Responses without changing bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-final-gif-"));
  const path = join(root, "animated.gif");
  const oversized = join(root, "oversized.gif");
  writeFileSync(path, gif);
  writeFileSync(oversized, gif);
  truncateSync(oversized, 14 * 1024 * 1024 + 1);
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] }, 30_000);
  const client = new Client({ name: "final-gif-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  try {
    await client.connect(transport);
    const rejected = await client.callTool({ name: "codex_view_image", arguments: { turn_token: token, path: oversized } });
    expect(rejected.isError).toBe(true);
    expect(await broker.finalImages(token)).toEqual([]);
    const response = await client.callTool({ name: "codex_view_image", arguments: { turn_token: token, path } });
    expect(response.isError).not.toBe(true);
    const image = { data: gif.toString("base64"), mimeType: "image/gif", alt: "Image" };
    const imageRef = presentedImageRef(image);
    expect(response.structuredContent).toMatchObject({ image_ref: imageRef, mime_type: "image/gif" });
    const blocks = CallToolResultSchema.parse(response).content;
    expect(blocks.every(item => item.type === "text")).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain(gif.toString("base64"));
    const receiptBlock = blocks[0];
    if (receiptBlock?.type !== "text") throw new Error("Expected a text delivery receipt");
    expect(JSON.parse(receiptBlock.text)).toMatchObject({ image_ref: imageRef, mime_type: "image/gif" });
    expect(JSON.stringify(response.content)).toContain(imageRef);
    writeFileSync(path, "changed after tool read");
    const images = await new RemoteTurnBroker(socket).finalImages(token);
    expect(images).toEqual([image]);
    const final = materializeFinalImages(imageRef, images);
    expect(final).toBe(`![Image](data:image/gif;base64,${gif.toString("base64")})`);
    const json = buildResponseJSON([{ type: "text_delta", text: final, phase: "final_answer" }, { type: "done", endTurn: true }], "chatgpt-web/gif-test");
    expect(JSON.stringify(json)).toContain(final);
    expect(JSON.stringify(json)).not.toContain("CODEXIMAGE:");
    const largeGif = Buffer.alloc(13 * 1024 * 1024);
    gif.copy(largeGif);
    writeFileSync(path, largeGif);
    const largeResponse = await client.callTool({ name: "codex_view_image", arguments: { turn_token: token, path } });
    expect(largeResponse.isError).not.toBe(true);
    const largeImage = (await new RemoteTurnBroker(socket).finalImages(token)).at(-1)!;
    expect(Buffer.from(largeImage.data, "base64")).toEqual(largeGif);
    expect(materializeFinalImages(presentedImageRef(largeImage), [largeImage]))
      .toBe(`![Image](data:image/gif;base64,${largeGif.toString("base64")})`);
  } finally {
    await client.close();
    await transport.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
