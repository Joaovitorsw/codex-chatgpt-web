export function chatGptUserMessageMatches(
  group: Element,
  options: { submittedText: string; connectorName?: string },
): boolean {
  const bubbles = group.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
  const contents = bubbles.length === 1
    ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]")
    : [];
  if (contents.length !== 1) return false;
  const content = contents[0]!;
  const normalize = (text: string) => text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const text = normalize(content.innerText);
  const submitted = normalize(options.submittedText);
  if (text === submitted) return true;
  if (!options.connectorName || !submitted) return false;
  const mentions = content.querySelectorAll<HTMLElement>(
    '[data-prompt-link-href^="app://"], [app-mention-path^="app://"][app-mention-display-name]',
  );
  if (mentions.length !== 1) return false;
  const mention = mentions[0]!;
  if (mention.textContent?.trim() !== options.connectorName) return false;
  const leading = content.ownerDocument.createRange();
  leading.selectNodeContents(content);
  leading.setEndBefore(mention);
  if (leading.toString() !== "") return false;
  const label = normalize(mention.innerText.trim());
  const prefixes = new Set([`${label}  `, `${label}\n  `, `${label} \n\n`, `${label}\n\n`]);
  return text.endsWith(submitted) && prefixes.has(text.slice(0, text.length - submitted.length));
}

/** Runs in the page. Read the submitted text, excluding only observed renderer chrome. */
export function readChatGptUserMessage(
  target: Element,
  connectorName?: string,
): { text: string; leadingConnector: boolean } | undefined {
  let leadingConnector = false;
  let unsupported = false;
  let seenText = false;
  const rich = target.querySelector('[data-markdown-text-tone="user-message"].rich-text-user-turn');
  if (target.querySelectorAll('[data-markdown-text-tone="user-message"].rich-text-user-turn').length > 1) return;
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (value.trim()) seenText = true;
      return value;
    }
    if (!(node instanceof HTMLElement)) { unsupported = true; return ""; }
    if (node.matches('[data-prompt-link-href^="app://"]')
      || node.matches('a:has(> [data-prompt-link-href^="app://"])')) {
      if (seenText || leadingConnector || !connectorName || node.textContent !== connectorName) unsupported = true;
      leadingConnector = true;
      return "";
    }
    if (node.tagName === "BR") return "\n";
    // ChatGPT auto-links bare URLs. Only accept links whose complete label is
    // the URL itself; formatted labels and link chrome cannot replace source text.
    if (node instanceof HTMLAnchorElement) {
      try {
        const label = node.textContent ?? "";
        const url = new URL(label);
        if (!["https:", "http:"].includes(url.protocol) || url.href !== node.href) {
          unsupported = true;
          return "";
        }
      } catch { unsupported = true; return ""; }
      return [...node.childNodes].map(text).join("");
    }
    if (node.matches('pre[data-markdown-copy="code-block"]')) {
      const code = node.querySelector('code[data-markdown-copy-content="true"][data-language]');
      if (!code || node.children.length !== 1) { unsupported = true; return ""; }
      seenText = true;
      return `\`\`\`${code.getAttribute("data-language")}\n${code.textContent ?? ""}\n\`\`\``;
    }
    if (node === rich) {
      const blocks = [...node.childNodes];
      if (blocks.some(block => !(block instanceof HTMLElement)
        || !(block.tagName === "P" || block.matches('[data-markdown-copy="blank-lines"]')))) {
        unsupported = true;
        return "";
      }
      const value = blocks.map(block => text(block) + ((block as HTMLElement).tagName === "P" ? "\n" : "")).join("");
      return (blocks.at(-1) as HTMLElement | undefined)?.tagName === "P" ? value.slice(0, -1) : value;
    }
    // These are text wrappers in the captured plain and rich-text user renderers.
    // Other markup must not be silently flattened into a matching prompt.
    if (!["DIV", "SPAN", "P"].includes(node.tagName)) { unsupported = true; return ""; }
    return [...node.childNodes].map(text).join("");
  };
  const value = text(target);
  if (unsupported) return;
  // attachPrompt inserts a separating space after the plugin. ChatGPT can retain
  // its own chip separator too. Only this leading transport spacing is excluded.
  return { text: leadingConnector ? value.trimStart() : value, leadingConnector };
}
