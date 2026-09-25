import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptAnswerMarkdownDelivery, ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

const smokeHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");
type Snapshot = {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: { kind: string; text: string }[];
};

// Execute the production page callback, with only missing Domino browser APIs supplied.
async function snapshot(html: string): Promise<Snapshot> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true, value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block", visibility: "visible", opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try { return runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options); }
        catch (error) { errors.push(error); throw error; }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = await worker.responseDomSnapshot(locator);
    expect(errors).toEqual([]);
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

test("keeps an unfinished hyperlink buffered and preserves delivered destinations after later rewrites", async () => {
  const page = (href: string) => `<section id="turn"><div class="markdown"><p data-start="0" data-end="99"><strong><a${href}>Open report</a></strong>.</p><p data-start="100" data-end="115">Next paragraph.</p></div></section>`;
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const pending = await snapshot(page(""));
  expect(buffer.observe(pending.markdownSegments, 0)).toBe("");
  const linked = await snapshot(page(' href="https://example.com/report#details"'));
  expect(buffer.observe(linked.markdownSegments, 1000)).toBe("**[Open report](https://example.com/report#details)**.");
  expect(buffer.finish().markdown).toBe("**[Open report](https://example.com/report#details)**.\n\nNext paragraph.");
  const changed = await snapshot(page(' href="https://example.com/different"'));
  buffer.observe(changed.markdownSegments, 2000);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toBe("**[Open report](https://example.com/report#details)**.\n\nNext paragraph.");
});

test("captured DIL smoke response reaches Markdown delivery and stable completion", async () => {
  // Also cover a changed CSS module hash and nested Markdown without duplicate delivery.
  for (const html of [
    smokeHtml,
    smokeHtml.replaceAll("fv0XaG_", "changed_"),
    smokeHtml.replace('<p class="w6asjq_TextBase _85PZeG_Text">', '<p class="markdown">'),
    '<section id="turn"><div class="markdown"><p>CODEX WEB GPT READY</p></div><button data-testid="copy-turn-action-button"></button></section>',
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("CODEX WEB GPT READY");
    expect(response.completionActionVisible).toBeTrue();
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe(response.markdownSegments, 0);
    expect(buffer.finish().markdown).toBe("CODEX WEB GPT READY");
    const tracker = new ChatGptCompletionTracker();
    const state = { ...response, running: false, currentText: response.visibleText, currentHtml: response.fullHtml };
    expect(tracker.update({ ...state, running: true }, 0)).toBeFalse();
    expect(tracker.update(state, 1)).toBeFalse();
    expect(tracker.update(state, 1 + CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
    expect(response.traceBlocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "answer", text: "CODEX WEB GPT READY" },
    ]);
  }
});

test("converts a native weather widget into a stable Markdown card", async () => {
  const response = await snapshot(`
    <section id="turn">
      <div class="markdown"><p>Veja a previsão atual:</p></div>
      <section role="region" aria-label="Clima em Belo Horizonte">
        <div>20 °C</div><div>Predominantemente nublado</div>
        <a href="https://example.com/weather">Ver previsão</a>
      </section>
      <button data-testid="copy-turn-action-button"></button>
    </section>
  `);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  expect(buffer.observe(response.markdownSegments, 0)).toBe("Veja a previsão atual:");
  expect(buffer.finish().markdown).toContain("> **Clima em Belo Horizonte**");
  expect(buffer.finish().markdown).toContain("> 20 °C");
  expect(buffer.finish().markdown).toContain("[Ver previsão](https://example.com/weather)");
});

test("summarizes a closed DIL result card from the answer highlights", async () => {
  const response = await snapshot(`
    <section id="turn">
      <div data-markdown-text-style="assistant-message">
        <p>Agora em Belo Horizonte está <strong>20 °C</strong>, com tempo
          <strong>predominantemente nublado</strong>.</p>
      </div>
      <div data-testid="chatgpt-dil-widget" data-widget-name="Basic"><dil-renderer></dil-renderer></div>
      <button data-testid="copy-turn-action-button"></button>
    </section>
  `);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toContain("> **Resultado**");
  expect(buffer.finish().markdown).toContain("> 20 °C · predominantemente nublado");
});

test("DIL response extraction preserves ownership, commentary and completion boundaries", async () => {
  for (const html of [
    smokeHtml.replace('data-message-author-role="assistant"', 'data-message-author-role="user"'),
    smokeHtml.replace("fv0XaG_DilResponseRoot", "unrelated-widget"),
    smokeHtml.replace('dir="auto"', 'dir="auto" style="display:none"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-streaming-response-status="thinking"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-testid="cot-v5"'),
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("");
    expect(response.completionActionVisible).toBeFalse();
  }
  const noCopy = await snapshot(smokeHtml.replace('data-testid="copy-turn-action-button"', 'data-testid="other-action"'));
  expect(noCopy.visibleText).toBe("CODEX WEB GPT READY");
  expect(noCopy.completionActionVisible).toBeFalse();
});

test("a renderer remount may consolidate the final DOM when it preserves the streamed Markdown prefix", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const first = { key: "first", tag: "p", html: "<p>First</p>", text: "First", streamable: true };
  const tail = { key: "tail", tag: "p", html: "<p>Tail</p>", text: "Tail", streamable: false };
  expect(buffer.observe([first, tail], 0)).toBe("First");

  const consolidated = {
    key: "remounted-final",
    tag: "article",
    html: "<article><p>First</p><p>Tail</p></article>",
    text: "FirstTail",
    streamable: false,
  };
  expect(buffer.observe([consolidated], 1)).toBe("");
  expect(buffer.currentSnapshotIsConsistent()).toBe(true);
  expect(buffer.finish()).toEqual({ markdown: "First\n\nTail", delta: "\n\nTail" });
});

test("tool turns defer mutable roots and publish a rewritten human conclusion intact", () => {
  const delivery = new ChatGptAnswerMarkdownDelivery(true, markdown => markdown, 0);
  const progress = [
    { key: "plan", tag: "p", html: "<p>Vou editar os arquivos.</p>", text: "Vou editar os arquivos.", streamable: true },
    { key: "tool-tail", tag: "p", html: "<p>Editando.</p>", text: "Editando.", streamable: false },
  ];
  expect(delivery.observe(progress, 0)).toBe("");

  // ChatGPT replaces planning roots after the tool result. Previously the already-streamed plan
  // was not a prefix of this DOM and the useful conclusion failed with browser_stream_inconsistent.
  const conclusion = [
    {
      key: "final",
      tag: "article",
      html: "<article><p>Concluído.</p><p>Arquivos ajustados: Header.css e Hero.css.</p></article>",
      text: "Concluído.Arquivos ajustados: Header.css e Hero.css.",
      streamable: false,
    },
  ];
  expect(delivery.finish(conclusion, 1)).toEqual({
    markdown: "Concluído.\n\nArquivos ajustados: Header.css e Hero.css.",
    delta: "Concluído.\n\nArquivos ajustados: Header.css e Hero.css.",
  });
});
