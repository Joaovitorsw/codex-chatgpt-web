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
  const mentions = content.querySelectorAll<HTMLElement>('[data-prompt-link-href^="app://"]');
  if (mentions.length !== 1) return false;
  const mention = mentions[0]!;
  if (mention.textContent !== options.connectorName) return false;
  const leading = content.ownerDocument.createRange();
  leading.selectNodeContents(content);
  leading.setEndBefore(mention);
  if (leading.toString() !== "") return false;
  const label = normalize(mention.innerText);
  const prefixes = new Set([`${label}  `, `${label}\n  `]);
  return text.endsWith(submitted) && prefixes.has(text.slice(0, text.length - submitted.length));
}
