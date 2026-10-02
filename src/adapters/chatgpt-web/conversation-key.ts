import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Native compaction remains part of the exact identity of a replayed Codex turn. */
function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    // A native branch is intentionally a separate ChatGPT conversation even
    // when it inherits the parent's repository context. Keeping the lineage
    // in the durable key makes that boundary explicit and prevents an older
    // retained tab from being adopted if a client ever reuses a thread id.
    branchParentThreadId: identity.parentThreadId ?? null,
    // A saved ChatGPT conversation belongs to the native Codex task, not to the model picker
    // state of one turn. The browser worker re-proves model family and effort immediately before
    // every Send, including retained continuations, so changing Medium/High/Pro must not allocate
    // another chat or resend canonical history. A compaction epoch remains a deliberate boundary:
    // it represents the proven context-limit fallback where a fresh conversation is allowed.
    compaction: compactionEpoch(raw?.input),
  })).digest("hex");
}

/**
 * Full history remains canonical; a retained epoch receives only the suffix after its last
 * assistant reply. A restored native retry can end in an assistant item, even when its retained
 * browser tab already contains the complete prior discussion. Replaying that whole native
 * history would explode the browser input; use only the latest user request in that edge case.
 */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0) return parsed;
  if (lastAssistant === parsed.context.messages.length - 1) {
    const lastUser = parsed.context.messages.findLastIndex(message => message.role === "user");
    if (lastUser < 0) return undefined;
    return {
      ...parsed,
      context: {
        ...parsed.context,
        messages: [parsed.context.messages[lastUser]!],
      },
    };
  }
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.slice(lastAssistant + 1),
    },
  };
}
