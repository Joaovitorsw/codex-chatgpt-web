import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const output = process.argv[2];
const bridgeHome = process.argv[3];
const outputOptions = process.argv[4] ? JSON.parse(process.argv[4]) as unknown : undefined;
const referenceImagePaths = process.argv[5] ? JSON.parse(process.argv[5]) as unknown : undefined;
if (!output || !isAbsolute(output) || !output.endsWith(".png") || existsSync(output)) {
  throw new Error("Pass a new absolute .png output path inside the current workspace");
}
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "cgw-live-image-mcp-"));
const socket = defaultBrokerEndpoint(temporary);
const broker = TurnBroker.forSocket(socket);
const token = await broker.register({
  cwd: root, roots: [root], writableRoots: [root],
  sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: true }, tools: [],
}, 600_000, "live-image-mcp-smoke");
const client = new Client({ name: "live-image-mcp-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket],
  cwd: root, stderr: "pipe",
  env: {
    ...process.env,
    ...(bridgeHome ? { CODEX_CHATGPT_WEB_HOME: bridgeHome } : {}),
    CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: "",
  } as Record<string, string>,
});
try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "codex_generate_image_asset",
    arguments: {
      turn_token: token, output_path: output,
      ...(outputOptions === undefined ? {} : { output_options: outputOptions }),
      ...(referenceImagePaths === undefined ? {} : { reference_image_paths: referenceImagePaths }),
      prompt: (referenceImagePaths ? "Use the attached original character image as the actual visual reference. Preserve his face, hair, skin tone, green hoodie, dark shorts, sneakers and body proportions. Draw this SAME character celebrating with one hand raised. " : "") + "Actually generate one PNG: a single young Black Brazilian man game sprite, short coiled hair, green hoodie, dark shorts, sneakers, full body in three-quarter side view. Retro pixel art with crisp square pixel clusters, limited palette, readable silhouette. Real transparent background with binary alpha only 0 or 255, opaque character. One frame, centered with clear padding, unclipped head and feet. No antialiasing, text, labels, floor, shadows, checkerboard, scenery, or additional characters.",
    },
  }, undefined, { timeout: 420_000 });
  const evidence = result.structuredContent;
  if (result.isError || !evidence || typeof evidence !== "object" || !("generated" in evidence)
    || evidence.generated !== true || !existsSync(output) || statSync(output).size < 1) {
    throw new Error(JSON.stringify(result));
  }
  console.log(JSON.stringify({ ...evidence, verified_file_bytes: statSync(output).size, transport: "local MCP stdio -> authenticated launcher -> ChatGPT Web" }));
} finally {
  await client.close();
  await broker.close();
  rmSync(temporary, { recursive: true, force: true });
}
