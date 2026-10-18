import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test.each(["configured", "turn", "output", "metadata"])("image MCP resolves the %s launcher without a descriptor environment variable", async (source) => {
  const root = mkdtempSync(join(tmpdir(), "cgw-image-mcp-"));
  const output = join(root, "sprite.png");
  let requests = 0;
  let options: { width?: number; height?: number; max_colors?: number; binary_alpha?: boolean } | undefined;
  if (source === "output") options = { width: 32, height: 32, max_colors: 16, binary_alpha: true };
  if (source === "metadata") options = { binary_alpha: true };
  let responseOverrides: Record<string, unknown> = {};
  const launcher = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/image/generate");
      expect(request.headers.get("authorization")).toBe("Bearer test-control-token");
      const body = await request.json();
      expect(body).toMatchObject({ prompt: "test sprite", outputPath: output });
      expect(body).not.toHaveProperty("referenceImagePaths");
      if (options) expect(body).toMatchObject({ outputOptions: options });
      else expect(body).not.toHaveProperty("outputOptions");
      return Response.json({ ok: true, path: output, mimeType: "image/png", bytes: 100, width: options?.width ?? 64, height: options?.height ?? 64,
        ...(options ? { processed: true, outputOptions: options, sourcePath: join(root, "sprite.source.png"), sourceWidth: options.width ? 1254 : 64, sourceHeight: options.height ? 1254 : 64, colorCount: 16, binaryAlpha: true } : {}),
        ...responseOverrides,
      });
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
    if (source === "output") {
      const listed = await client.listTools();
      const imageTool = listed.tools.find(tool => tool.name === "codex_generate_image_asset");
      expect(imageTool?.inputSchema).toHaveProperty("properties.output_options");
      expect(imageTool?.inputSchema.required).not.toContain("output_options");
    }
    if (options) {
      for (const invalid of [null, {}, { width: 32 }, { height: 32 }, { width: 0, height: 32 }, { width: 4096, height: 32 }, { max_colors: 1 }, { max_colors: 257 }, { binary_alpha: "true" }, { unknown: true }]) {
        const rejected = await client.callTool({ name: "codex_generate_image_asset", arguments: { turn_token: token, prompt: "test sprite", output_path: output, output_options: invalid } });
        expect(rejected.isError).toBe(true);
        expect(requests).toBe(0);
      }
    }
    const argumentsForImage = { turn_token: token, prompt: "test sprite", output_path: output, ...(options ? { output_options: options } : {}) };
    let expectedRequests = 1;
    if (source === "metadata") {
      for (const invalid of [{ width: null }, { height: 0 }, { width: 65 }, { height: 63 }]) {
        responseOverrides = invalid;
        const rejected = await client.callTool({ name: "codex_generate_image_asset", arguments: argumentsForImage });
        expect(rejected.isError).toBe(true);
        expectedRequests++;
      }
      responseOverrides = {};
    }
    const result = await client.callTool({ name: "codex_generate_image_asset", arguments: argumentsForImage });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ generated: true, path: output, width: options?.width ?? 64, height: options?.height ?? 64, parent_turn_active: true });
    expect(result.structuredContent).not.toHaveProperty("reference_count");
    if (options) expect(result.structuredContent).toMatchObject({ processed: true, source_path: join(root, "sprite.source.png"), source_width: options.width ? 1254 : 64, source_height: options.height ? 1254 : 64, color_count: 16, binary_alpha: true, output_options: options });
    expect(requests).toBe(expectedRequests);
  } finally {
    await client.close();
    await broker.close();
    launcher.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

async function withReferenceImageMcp(run: (fixture: {
  client: Client;
  root: string;
  writableRoot: string;
  outsideRoot: string;
  references: string[];
  bodies: Record<string, unknown>[];
  response: Record<string, unknown>;
  args: Record<string, unknown>;
}) => Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "cgw-image-references-"));
  const root = join(base, "workspace");
  const writableRoot = join(base, "writable");
  const outsideRoot = join(base, "workspace-sibling");
  for (const directory of [root, writableRoot, outsideRoot]) mkdirSync(directory);
  const signatures = ["89504e470d0a1a0a", "ffd8ff", "ffd8ff", "524946460400000057454250", "89504e470d0a1a0a"];
  const references = ["concept.png", "pose.jpg", "detail.JPEG", "texture.webp", "palette.PNG"]
    .map((name, index) => {
      const path = join(index === 4 ? writableRoot : root, name);
      writeFileSync(path, Buffer.from(signatures[index]!, "hex"));
      return realpathSync(path);
    });
  const bodies: Record<string, unknown>[] = [];
  const response: Record<string, unknown> = {};
  const output = join(root, "result.png");
  const launcher = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    bodies.push(body);
    return Response.json({ ok: true, path: output, mimeType: "image/png", bytes: 100,
      referenceCount: Array.isArray(body.referenceImagePaths) ? body.referenceImagePaths.length : 0, ...response });
  } });
  const descriptor = join(root, "launcher-browser.json");
  writeFileSync(descriptor, JSON.stringify({ control: { endpoint: launcher.url.origin, token: "test-control-token" } }));
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...defaultConfig("browser-only"), browserHost: "launcher", browserHostDescriptorPath: descriptor }));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root, join(base, "missing-root")], writableRoots: [writableRoot], sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 30_000);
  const client = new Client({ name: "image-references-regression", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket],
    cwd: process.cwd(), stderr: "pipe", env: { ...process.env, CODEX_CHATGPT_WEB_HOME: root, CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: "" } as Record<string, string> });
  try {
    await client.connect(transport);
    await run({ client, root, writableRoot, outsideRoot, references, bodies, response,
      args: { turn_token: token, prompt: "use the attached pixels", output_path: output } });
  } finally {
    await client.close();
    await broker.close();
    launcher.stop(true);
    rmSync(base, { recursive: true, force: true });
  }
}

test("image MCP advertises optional bounded reference paths and rejects invalid schema inputs", () => withReferenceImageMcp(async ({ client, args, references, bodies }) => {
  const tool = (await client.listTools()).tools.find(tool => tool.name === "codex_generate_image_asset");
  expect(tool?.inputSchema.properties?.reference_image_paths).toMatchObject({ type: "array", minItems: 1, maxItems: 5, items: { type: "string" } });
  expect(tool?.inputSchema.required).not.toContain("reference_image_paths");
  for (const invalid of [null, [], references.concat(references[0]!), "concept.png", [42], [""], ["x".repeat(4097)]]) {
    const result = await client.callTool({ name: "codex_generate_image_asset", arguments: { ...args, reference_image_paths: invalid } });
    expect(result.isError).toBe(true);
    expect(bodies).toHaveLength(0);
  }
}), 30_000);

test.each([1, 5])("image MCP forwards %s reference files separately from the prompt", count => withReferenceImageMcp(async ({ client, args, references, bodies, response, root }) => {
  const paths = references.slice(0, count);
  if (count === 5) {
    truncateSync(paths[4]!, 20 * 1024 * 1024);
    args.output_options = { binary_alpha: true };
    Object.assign(response, { processed: true, sourcePath: join(root, "result.source.png"), width: 64, height: 64,
      sourceWidth: 64, sourceHeight: 64, colorCount: 16, binaryAlpha: true });
  }
  const result = await client.callTool({ name: "codex_generate_image_asset", arguments: { ...args, reference_image_paths: paths } });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ generated: true, reference_count: count });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ prompt: args.prompt, referenceImagePaths: paths });
  expect(bodies[0]).not.toHaveProperty("reference_image_paths");
  if (count === 5) expect(bodies[0]).toHaveProperty("outputOptions", args.output_options);
}), 30_000);

test("image MCP resolves links between authorized roots before forwarding", () => withReferenceImageMcp(async ({ client, args, references, root, writableRoot, bodies }) => {
  const alias = join(root, "authorized-link");
  symlinkSync(writableRoot, alias, process.platform === "win32" ? "junction" : "dir");
  const result = await client.callTool({ name: "codex_generate_image_asset", arguments: { ...args, reference_image_paths: [join(alias, "palette.PNG")] } });
  expect(result.isError).not.toBe(true);
  expect(bodies[0]).toHaveProperty("referenceImagePaths", [references[4]]);
}), 30_000);

test("image MCP rejects unavailable, unsupported, oversized and escaping reference files before launch", () => withReferenceImageMcp(async ({ client, args, root, outsideRoot, references, bodies }) => {
  const outside = join(outsideRoot, "outside.png");
  writeFileSync(outside, Buffer.from("89504e470d0a1a0a", "hex"));
  const escape = join(root, "escape");
  symlinkSync(outsideRoot, escape, process.platform === "win32" ? "junction" : "dir");
  const directory = join(root, "directory.png");
  mkdirSync(directory);
  const unsupported = join(root, "unsupported.gif");
  writeFileSync(unsupported, "GIF89a");
  const fake = join(root, "fake.png");
  writeFileSync(fake, "not image pixels");
  const empty = join(root, "empty.jpg");
  writeFileSync(empty, "");
  const fakeJpeg = join(root, "fake.jpeg");
  writeFileSync(fakeJpeg, "not jpeg");
  const fakeWebp = join(root, "fake.webp");
  writeFileSync(fakeWebp, "RIFF0000nope");
  const large = join(root, "large.png");
  writeFileSync(large, Buffer.from("89504e470d0a1a0a", "hex"));
  truncateSync(large, 20 * 1024 * 1024 + 1);
  for (const invalid of ["concept.png", join(root, "missing.png"), outside, join(escape, "outside.png"), directory, unsupported, fake, empty, fakeJpeg, fakeWebp, large]) {
    const result = await client.callTool({ name: "codex_generate_image_asset", arguments: { ...args, reference_image_paths: [references[0], invalid] } });
    expect(result.isError).toBe(true);
    expect(bodies).toHaveLength(0);
  }
}), 30_000);

test("image MCP requires matching launcher reference count evidence", () => withReferenceImageMcp(async ({ client, args, references, response, bodies }) => {
  for (const count of [undefined, null, "1", 0, 2, 1.5]) {
    response.referenceCount = count;
    const result = await client.callTool({ name: "codex_generate_image_asset", arguments: { ...args, reference_image_paths: [references[0]] } });
    expect(result.isError).toBe(true);
  }
  expect(bodies).toHaveLength(6);
}), 30_000);
