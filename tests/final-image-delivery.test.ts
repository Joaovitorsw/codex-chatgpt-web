import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker, RemoteTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { materializeFinalImages, presentedImageRef } from "../src/adapters/chatgpt-web/final-images";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("a plain image marker survives browser Markdown extraction", () => {
  const ref = presentedImageRef({ data: png.toString("base64"), mimeType: "image/png", alt: "Image" });
  expect(chatGptHtmlToMarkdown(`<p>${ref}</p>`)).toBe(ref);
});

test("final image expansion has a reference budget", () => {
  const image = { data: png.toString("base64"), mimeType: "image/png", alt: "Image" };
  expect(() => materializeFinalImages(presentedImageRef(image).repeat(9), [image])).toThrow("budget");
});

test("browser completion preserves explicitly presented media separately from DOM image URLs", async () => {
  const image = { data: png.toString("base64"), mimeType: "image/png", alt: "Image" };
  const session = new ChatGptTurnSession({ mode: "read-only", browser: Promise.resolve("Same existing image"), physicalSettlement: Promise.resolve(), text: new ChatGptTextFeed(), trace: new ChatGptTraceFeed(), cancel() {}, loadFinalImages: async () => [image] });
  expect(await session.browserOutcome).toEqual({ type: "final", answer: "Same existing image", mediaUrls: [], presentedImages: [image] });
});

test("an explicit image presentation crosses MCP into the owning turn without generating an image", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-final-image-"));
  const path = join(root, "existing.png");
  const outsideRoot = mkdtempSync(join(tmpdir(), "cgw-final-image-outside-"));
  const outsidePath = join(outsideRoot, "outside.png");
  writeFileSync(outsidePath, png);
  const linkDirectory = join(root, "outside-link");
  symlinkSync(outsideRoot, linkDirectory, process.platform === "win32" ? "junction" : "dir");
  const linkPath = join(linkDirectory, "outside.png");
  writeFileSync(path, png);
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
  const token = await broker.register(environment, 30_000);
  const otherToken = await broker.register(environment, 30_000);
  const client = new Client({ name: "final-image-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  try {
    await client.connect(transport);
    const escaped = await client.callTool({ name: "codex_view_image", arguments: { turn_token: otherToken, path: linkPath } });
    expect(escaped.isError).toBe(true);
    const response = await client.callTool({ name: "codex_view_image", arguments: { turn_token: token, path } });
    expect(response.isError).not.toBe(true);
    const ref = `CODEXIMAGE:${createHash("sha256").update(png).digest("hex")}`;
    expect(response.structuredContent).toMatchObject({ image_ref: ref, mime_type: "image/png" });
    writeFileSync(path, "changed after presentation");
    const owner = new RemoteTurnBroker(socket);
    const images = await owner.finalImages(token);
    expect(images).toEqual([{ data: png.toString("base64"), mimeType: "image/png", alt: "Image" }]);
    expect(materializeFinalImages(ref, images)).toBe(`![Image](data:image/png;base64,${png.toString("base64")})`);
    expect(() => materializeFinalImages(ref, [])).toThrow("current turn");
    expect(await owner.finalImages(otherToken)).toEqual([]);
    broker.revoke(token);
    await expect(owner.finalImages(token)).rejects.toThrow();
  } finally {
    await client.close();
    await transport.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}, 30_000);
