import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { defaultBrokerEndpoint } from "../src/config";
import { materializeFinalImages } from "../src/adapters/chatgpt-web/final-images";
import { RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chromium } from "playwright-core";

const path = process.argv[2];
const verifyAnimation = process.argv[3] === "--verify-animation";
const browserExecutable = process.argv[4];
if (!path || !isAbsolute(path)) throw new Error("Pass an existing absolute workspace image path");
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "cgw-final-image-smoke-"));
const socket = defaultBrokerEndpoint(temporary);
const broker = TurnBroker.forSocket(socket);
const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] });
const client = new Client({ name: "final-image-relay-smoke", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket], cwd: root, stderr: "pipe" });
try {
  await client.connect(transport);
  const viewed = await client.callTool({ name: "codex_view_image", arguments: { turn_token: token, path, detail: "original" } });
  if (viewed.isError) throw new Error(JSON.stringify(viewed));
  const ref = (viewed.structuredContent as { image_ref: string }).image_ref;
  if (typeof ref !== "string") throw new Error("Image viewer did not register final media");
  const images = await new RemoteTurnBroker(socket).finalImages(token);
  const answer = materializeFinalImages(ref, images);
  const response = buildResponseJSON([{ type: "text_delta", text: answer, phase: "final_answer" }, { type: "done", endTurn: true }], "chatgpt-web/image-relay-smoke");
  const serialized = JSON.stringify(response);
  if (!serialized.includes('"phase":"final_answer"') || !serialized.includes(answer) || serialized.includes('"input_image"')) throw new Error("Final media did not survive Responses serialization");
  const match = /\(data:([^;]+);base64,([A-Za-z0-9+/=]+)\)/.exec(answer);
  if (!match) throw new Error("Final answer did not contain embedded image bytes");
  const received = Buffer.from(match[2]!, "base64");
  const source = readFileSync(path);
  if (!received.equals(source)) throw new Error("Received image differs from the existing source");
  let renderedFrames: string[] | undefined;
  let animationResult: "observed" | "inconclusive" | undefined;
  if (verifyAnimation) {
    if (match[1] !== "image/gif" || !browserExecutable) throw new Error("Animation verification requires a GIF and a browser executable path");
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:"><img alt="GIF preview" src="data:image/gif;base64,${match[2]}">`);
      const preview = page.getByRole("img", { name: "GIF preview" });
      await preview.evaluate(image => (image as HTMLImageElement).decode());
      const first = await preview.screenshot();
      await new Promise(resolve => setTimeout(resolve, 650));
      const second = await preview.screenshot();
      renderedFrames = [first, second].map(frame => createHash("sha256").update(frame).digest("hex"));
      if (renderedFrames[0] === renderedFrames[1]) {
        await new Promise(resolve => setTimeout(resolve, 650));
        renderedFrames.push(createHash("sha256").update(await preview.screenshot()).digest("hex"));
      }
      animationResult = new Set(renderedFrames).size > 1 ? "observed" : "inconclusive";
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ matched: true, bytes: received.length, sha256: createHash("sha256").update(received).digest("hex"), mime_type: match[1], phase: "final_answer", response_bytes: Buffer.byteLength(serialized), generated: false, web_model_exercised: false, browser_animation_exercised: verifyAnimation, ...(renderedFrames ? { rendered_frame_sha256: renderedFrames, animation_result: animationResult } : {}), transport: "MCP stdio -> scoped turn broker -> inline final Markdown -> Responses JSON" }));
} finally {
  await client.close();
  await transport.close();
  await broker.close();
  rmSync(temporary, { recursive: true, force: true });
}
