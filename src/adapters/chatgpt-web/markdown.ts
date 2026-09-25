import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("chatGptCodeBlock", {
  filter: node => node.nodeName === "DIV"
    && (node as HTMLElement).getAttribute("data-markdown-copy") === "code-block",
  replacement: (_content, node) => {
    const wrapper = node as HTMLElement;
    const code = wrapper.querySelector("code");
    if (!code) return "";
    const lineWrapper = code.children.length === 1 ? code.firstElementChild : null;
    const lineElements = lineWrapper ? Array.from(lineWrapper.children) as HTMLElement[] : [];
    const separators = lineWrapper
      ? Array.from(lineWrapper.childNodes).filter(child => child.nodeType === 3)
      : [];
    // Current ChatGPT plain-text cards wrap every visual line in a sibling span. Turndown's
    // whitespace normalization collapses the newline-only text nodes before a custom rule runs,
    // so reconstruct those lines structurally instead of trusting the flattened textContent.
    const structurallyLineWrapped = lineElements.length > 1
      && separators.length >= lineElements.length - 1
      && separators.every(separator => !(separator.textContent ?? "").trim());
    const value = (structurallyLineWrapped
      ? lineElements.map(line => line.textContent ?? "").join("\n")
      : code.textContent ?? "").replace(/^\n|\n$/g, "");
    const header = wrapper.querySelector<HTMLElement>('[data-markdown-copy="exclude"]')
      ?.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    const language = header === "plain text" || header === "plaintext" || header === "text"
      ? "text"
      : header === "javascript" || header === "js" ? "javascript"
        : header === "typescript" || header === "ts" ? "typescript"
          : header === "powershell" || header === "shell" || header === "bash" ? header
            : "";
    const longestFence = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return `\n\n${fence}${language}\n${value}\n${fence}\n\n`;
  },
});
turndown.addRule("preserveCodexPlanBlockTags", {
  filter: "p",
  replacement: content => {
    // Codex recognizes these standalone control lines verbatim. Restore only paragraph text:
    // a post-conversion replacement would also rewrite literal escapes in fenced code.
    const paragraph = content.replace(/^([ \t]*)<(\/?)proposed\\_plan>([ \t]*)$/gm, "$1<$2proposed_plan>$3");
    return `\n\n${paragraph}\n\n`;
  },
});
turndown.addRule("linkInlineFilePaths", {
  filter: node => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent!;
    const target = path.replaceAll("\\", "/");
    // Code text becomes a plain link label, where backslashes and emphasis must be escaped.
    return `[${turndown.escape(path)}](<${target}>)`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== "CODE") return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["A", "PRE"].includes(ancestor.nodeName)) return undefined;
  }

  const path = node.textContent ?? "";
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;

  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const separator = Math.max(withoutLocation.lastIndexOf("/"), withoutLocation.lastIndexOf("\\"));
  if (separator < 0) return undefined;

  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

function preserveObsidianWikiLinks(markdown: string): string {
  // Turndown escapes literal brackets, but Codex interprets the resulting `\[` as LaTeX.
  // Restore the source syntax before converting it into a regular Markdown file link.
  return markdown.replace(/\\\[\\\[([^\r\n]*?)\\\]\\\]/g, "[[$1]]");
}

function obsidianWikiLink(value: string): string | undefined {
  const separator = value.indexOf("|");
  const target = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const label = (separator >= 0 ? value.slice(separator + 1) : value).trim();
  if (!target || !label || /[<>]/.test(target)) return undefined;

  const fragmentAt = target.indexOf("#");
  const note = fragmentAt >= 0 ? target.slice(0, fragmentAt) : target;
  const fragment = fragmentAt >= 0 ? target.slice(fragmentAt) : "";
  const extension = note.slice(note.lastIndexOf("/") + 1).includes(".");
  const path = note && !extension ? `${note}.md` : note;
  return `[${label}](<${path}${fragment}>)`;
}

function linkObsidianWikiLinks(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return markdown.split("\n").map(line => {
    const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const closingRun = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = undefined;
      return line;
    }
    if (fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      return line;
    }

    let result = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineCodeTicks = inlineCodeTicks === 0 ? ticks : ticks === inlineCodeTicks ? 0 : inlineCodeTicks;
        result += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineCodeTicks === 0 && line.startsWith("[[", index) && line[index - 1] !== "!") {
        const end = line.indexOf("]]", index + 2);
        if (end >= 0) {
          const linked = obsidianWikiLink(line.slice(index + 2, end));
          if (linked) {
            result += linked;
            index = end + 2;
            continue;
          }
        }
      }
      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return linkObsidianWikiLinks(preserveObsidianWikiLinks(turndown.turndown(html))).trim();
}

export interface ChatGptMarkdownSegment {
  key: string;
  tag?: string;
  html: string;
  text: string;
  linkTargets?: string[];
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  tag?: string;
  text: string;
  linkTargets?: string[];
  sourceStart?: number;
  sourceEnd?: number;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string, readonly diagnostic?: {
    reason: "text_changed" | "link_target_changed" | "block_order_changed" | "source_range_overlap";
    observedStart?: number;
    observedEnd?: number;
    committedStart?: number;
    committedEnd?: number;
    observedTextChars: number;
    committedTextChars: number;
  }) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. It can also virtualize an already-rendered prefix, so later DOM
 * snapshots are partial observations rather than the response ledger. The browser supplies source
 * ranges for semantic blocks and marks a block streamable only after a following block exists.
 * Once committed, the emitted ledger is immutable. Missing prefixes and later semantic rewrites of
 * already-emitted blocks are ignored because Responses deltas cannot retract bytes already sent.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private consistencyError: ChatGptMarkdownConsistencyError | undefined;
  private prefixRecoveryMarkdown: string | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      // A renderer/HMR remount can replace several semantic DOM blocks with one consolidated
      // block while preserving the exact Markdown already delivered to Codex. Responses deltas
      // are append-only, so accept only the provably safe case where the rebuilt snapshot starts
      // byte-for-byte with the committed ledger; the remaining suffix can be emitted at finish.
      const rebuilt = this.renderSnapshot(segments);
      if (rebuilt.startsWith(this.markdown)) {
        this.prefixRecoveryMarkdown = rebuilt;
        this.consistencyError = undefined;
        this.candidates.clear();
        this.latest = [];
        return "";
      }
      this.consistencyError = reconciled;
      return "";
    }
    this.prefixRecoveryMarkdown = undefined;
    this.consistencyError = undefined;
    this.latest = reconciled.map(segment => ({ ...segment }));

    const visibleCandidates = new Set<string>();
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment);
      visibleCandidates.add(candidateId);
      const previous = this.candidates.get(candidateId);
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd;
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId);
    }

    let delta = "";
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!;
      const candidateId = this.candidateId(segment);
      const candidate = this.candidates.get(candidateId);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push(this.committedSegment(candidate));
      this.candidates.delete(candidateId);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError;
    if (this.prefixRecoveryMarkdown !== undefined) {
      const delta = this.prefixRecoveryMarkdown.slice(this.markdown.length);
      this.markdown = this.prefixRecoveryMarkdown;
      this.prefixRecoveryMarkdown = undefined;
      this.candidates.clear();
      this.latest = [];
      return { markdown: this.markdown, delta };
    }
    let delta = "";
    for (const segment of this.latest) {
      delta += this.commit(segment);
      this.committed.push(this.committedSegment(segment));
    }
    this.candidates.clear();
    this.latest = [];
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined;
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    if (this.committed.length === 0 || segments.length === 0) return segments;

    const pending: ChatGptMarkdownSegment[] = [];
    const lastRangedCommitted = this.committed
      .filter(segment => segment.sourceEnd !== undefined)
      .at(-1);
    const lastCommittedEnd = lastRangedCommitted?.sourceEnd;
    let highestCommittedIndex = -1;
    let sawPending = false;
    let previousSourceStart: number | undefined;

    for (const segment of segments) {
      if (segment.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && segment.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError(
            "ChatGPT final DOM exposed non-monotonic source ranges",
          );
        }
        previousSourceStart = segment.sourceStart;
      }
      const committedIndex = this.committedIndex(segment);
      if (committedIndex !== undefined) {
        const committed = this.committed[committedIndex]!;
        if (sawPending || committedIndex < highestCommittedIndex) {
          return this.changedCommittedBlockError(
            "block_order_changed",
            segment,
            committed,
          );
        }
        highestCommittedIndex = committedIndex;
        continue;
      }

      if (segment.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (segment.sourceStart <= lastCommittedEnd) {
          return this.changedCommittedBlockError("source_range_overlap", segment, lastRangedCommitted!);
        }
        sawPending = true;
        pending.push(segment);
        continue;
      }

      const followsVisibleCommittedTail = highestCommittedIndex === this.committed.length - 1;
      if (!followsVisibleCommittedTail && !this.matchesLatestPending(segment)) {
        return new ChatGptMarkdownConsistencyError(
          "ChatGPT final DOM could not be aligned with text already streamed to Codex",
        );
      }
      sawPending = true;
      pending.push(segment);
    }

    return pending;
  }

  private committedIndex(segment: ChatGptMarkdownSegment): number | undefined {
    const exact = this.committed.findIndex(committed => (
      segment.sourceStart !== undefined && committed.sourceStart !== undefined
        ? segment.sourceStart === committed.sourceStart && segment.tag === committed.tag
        : segment.key === committed.key
    ));
    if (exact >= 0) return exact;

    if (segment.sourceStart !== undefined) return undefined;
    if (!segment.tag) return undefined;
    const semanticMatches = this.committed
      .map((committed, index) => ({ committed, index }))
      .filter(({ committed }) => committed.tag === segment.tag && committed.text === segment.text);
    return semanticMatches.length === 1 ? semanticMatches[0]!.index : undefined;
  }

  private matchesLatestPending(segment: ChatGptMarkdownSegment): boolean {
    const exact = this.latest.filter(candidate => (
      segment.sourceStart !== undefined && candidate.sourceStart !== undefined
        ? segment.sourceStart === candidate.sourceStart && segment.tag === candidate.tag
        : segment.key === candidate.key
    ));
    if (exact.length === 1) return true;
    if (segment.sourceStart !== undefined) return false;
    if (!segment.tag) return false;
    return this.latest.filter(candidate => (
      candidate.tag === segment.tag && candidate.text === segment.text
    )).length === 1;
  }

  private renderSnapshot(segments: ChatGptMarkdownSegment[]): string {
    let markdown = "";
    let lastGroup: string | undefined;
    for (const segment of segments) {
      const block = this.transform(chatGptHtmlToMarkdown(segment.html));
      if (!block) continue;
      const separator = markdown
        ? segment.group !== undefined && segment.group === lastGroup ? "\n" : "\n\n"
        : "";
      markdown += `${separator}${block}`;
      lastGroup = segment.group;
    }
    return markdown;
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `source:${segment.sourceStart}:${segment.tag ?? ""}`
      : `key:${segment.key}`;
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag ? { tag: segment.tag } : {}),
      text: segment.text,
      ...(segment.linkTargets ? { linkTargets: [...segment.linkTargets] } : {}),
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    };
  }

  private changedCommittedBlockError(
    reason: NonNullable<ChatGptMarkdownConsistencyError["diagnostic"]>["reason"],
    observed: ChatGptMarkdownSegment,
    committed: CommittedChatGptMarkdownSegment,
  ): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT changed a completed text block that was already streamed to Codex",
      {
        reason,
        observedStart: observed.sourceStart,
        observedEnd: observed.sourceEnd,
        committedStart: committed.sourceStart,
        committedEnd: committed.sourceEnd,
        observedTextChars: observed.text.length,
        committedTextChars: committed.text.length,
      },
    );
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}

/**
 * Chooses when answer Markdown becomes append-only.
 *
 * Tool-capable ChatGPT turns reuse mutable planning roots for their final response, so their
 * authoritative answer must be captured only after the broker completion fence settles. Live
 * progress is delivered independently as commentary by the browser worker. Read-only turns may
 * continue streaming stable Markdown blocks immediately.
 */
export class ChatGptAnswerMarkdownDelivery {
  private readonly buffer: ChatGptMarkdownBuffer;

  constructor(
    private readonly deferUntilCompletion: boolean,
    transform?: (markdown: string) => string,
    stabilityMs?: number,
  ) {
    this.buffer = new ChatGptMarkdownBuffer(transform, stabilityMs);
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    return this.deferUntilCompletion ? "" : this.buffer.observe(segments, now);
  }

  finish(finalSegments: ChatGptMarkdownSegment[], now = Date.now()): { markdown: string; delta: string } {
    if (this.deferUntilCompletion) this.buffer.observe(finalSegments, now);
    return this.buffer.finish();
  }
}
