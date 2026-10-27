import { getCodexHome, getTrustedCodexHomes } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";
import { resolveCurrentCodexRolloutEnvironment } from "./codex-rollout-environment";

const accepted = new WeakMap<CodexParsedRequest, string>();

/** Local canonical history is the authority; wire lifecycle claims alone cannot grant a resume. */
export function authenticatesInterruptedTaskResume(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  revision: ChatGptTurnUserRevision,
): boolean {
  if (parsed._compactionRequest || !identity.threadId || !identity.turnId || identity.parentThreadId
    || identity.subagentKind || !revision.turnId || revision.turnId === identity.turnId || !revision.itemId) return false;
  const body = parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined;
  if (!Array.isArray(body?.input)) return false;
  const matches = body.input.filter(item => item.id === revision.itemId);
  const instruction = matches[0];
  if (matches.length !== 1 || instruction?.type !== "message" || instruction.role !== "user") return false;
  const suffix = body.input.slice(body.input.indexOf(instruction) + 1);
  const continuation: Record<string, unknown>[] = [];
  if (!suffix.every(item => {
    const metadata = item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined;
    if (item.type !== "message" || item.role === "assistant") {
      if (!["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning"].includes(String(item.type))) return false;
      continuation.push(item);
      return true;
    }
    if (item.role === "developer") return metadata?.turn_id === identity.turnId;
    const text = Array.isArray(item.content) ? item.content.map(part => part?.text).join("\n") : item.content;
    return item.role === "user" && metadata?.turn_id === revision.turnId && typeof text === "string"
      && /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(text.trim());
  })) return false;
  const signature = JSON.stringify([parsed._rawBody, identity, revision]);
  if (accepted.get(parsed) === signature) return true;
  try {
    const homes = getTrustedCodexHomes(getCodexHome());
    const proof = resolveCurrentCodexRolloutEnvironment({
      codexHome: homes[0]!, additionalCodexHomes: homes.slice(1),
      lineage: { threadId: identity.threadId, sandboxType: "canonical-rollout", workspaceRoots: [] },
      turnId: identity.turnId, interruptedResumeInstruction: { instruction, suffix: continuation },
    });
    if (!proof) return false;
    accepted.set(parsed, signature);
    return true;
  } catch {
    // Do not memoize failure: the native writer may not yet have flushed its context.
    return false;
  }
}
