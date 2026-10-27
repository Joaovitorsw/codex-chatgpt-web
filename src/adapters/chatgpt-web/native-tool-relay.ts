import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../../version";
import { getConfigDir } from "../../config";

const RELAY_TOOLS = new Set(["codex_tool_inventory", "codex_tool_call", "codex_tool_search"]);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Reuse the native MCP gateway, including its approval, schema and turn-lease boundaries. */
export async function runNativeToolRelay(args: string[], runtimeCommand: string[]): Promise<void> {
  if (args.length !== 1 || !args[0] || args[0].length > MAX_REQUEST_BYTES * 2) {
    throw new Error("tool-relay requires one JSON or base64url-encoded JSON request");
  }
  const encoded = args[0];
  const rawJson = encoded.trimStart().startsWith("{");
  if (!rawJson && !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid relay request encoding");
  const bytes = Buffer.from(encoded, rawJson ? "utf8" : "base64url");
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error("Relay request is too large");
  let request: { tool?: unknown; arguments?: unknown };
  try { request = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Relay request is not valid JSON"); }
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.tool !== "string" || !RELAY_TOOLS.has(request.tool)
    || !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
    throw new Error("Relay requires a native inventory, discovery or tool-call request with structured arguments");
  }
  const [command, ...runtimeArgs] = runtimeCommand;
  if (!command) throw new Error("Relay runtime command is unavailable");
  const transport = new StdioClientTransport({
    command,
    args: [...runtimeArgs, "--home", getConfigDir(), "mcp"],
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-devspace-relay", version: VERSION });
  try {
    await client.connect(transport);
    // The child owns diagnostics; drain its pipe so a busy gateway cannot block on stderr.
    transport.stderr?.on("data", () => {});
    const result = await client.callTool({ name: request.tool, arguments: request.arguments as Record<string, unknown> },
      undefined, { timeout: 300_000 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.isError) process.exitCode = 1;
  } finally {
    await client.close();
    await transport.close();
  }
}
