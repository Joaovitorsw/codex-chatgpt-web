import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test.each(["configured", "turn"])("image MCP resolves the %s launcher without a descriptor environment variable", async (source) => {
  const root = mkdtempSync(join(tmpdir(), "cgw-image-mcp-"));
  const output = join(root, "sprite.png");
  let requests = 0;
  const launcher = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/image/generate");
      expect(request.headers.get("authorization")).toBe("Bearer test-control-token");
      expect(await request.json()).toMatchObject({ prompt: "test sprite", outputPath: output });
      requests++;
      return Response.json({ ok: true, path: output, mimeType: "image/png", bytes: 100, width: 64, height: 64 });
    },
  });
  const descriptor = join(root, "launcher-browser.json");
  writeFileSync(descriptor, JSON.stringify({ control: { endpoint: launcher.url.origin, token: "test-control-token" } }));
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...defaultConfig("browser-only"), browserHost: "launcher", browserHostDescriptorPath: source === "turn" ? join(root, "stale.json") : descriptor }));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [], ...(source === "turn" ? { launcherBrowserHostDescriptorPath: descriptor } : {}) }, 30_000);
  const client = new Client({ name: "image-handoff-regression", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socket],
    cwd: process.cwd(), stderr: "pipe",
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: root, CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: "" } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "codex_generate_image_asset", arguments: { turn_token: token, prompt: "test sprite", output_path: output } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ generated: true, path: output, width: 64, height: 64, parent_turn_active: true });
    expect(requests).toBe(1);
  } finally {
    await client.close();
    await broker.close();
    launcher.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
