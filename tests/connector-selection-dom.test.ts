import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("selects only the configured app across two visible popups", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const name of ["Codex Native3", "Codex Work PC"]) {
      const page = await browser.newPage();
      try {
        await page.setContent(`<form><button type="button" data-testid="composer-plus-btn">Apps</button>
          <div id="composer" contenteditable="true" role="textbox"></div></form>
          <div role="menu"><button type="button" data-list-navigation-item="true"><span>Codex Native2</span><small>Other computer</small></button></div>
          <div role="listbox"><button type="button" id="target" data-list-navigation-item="true"><span>${name}</span><small>Local computer</small></button>
          <button type="button" data-list-navigation-item="true"><span>${name} DEV</span></button></div>
          <div hidden><button type="button" data-list-navigation-item="true"><span>${name}</span></button></div>`);
        await page.locator('button[data-list-navigation-item="true"]').evaluateAll(rows => {
          rows.forEach(row => row.addEventListener("click", () => {
            document.querySelector("#composer")!.textContent = row.querySelector("span")!.textContent;
            document.body.setAttribute("data-picked", row.id || "wrong");
          }));
        });
        const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
        worker.config = { appName: name };
        worker.activeComposer = async () => page.locator("#composer");
        expect(await worker.selectModernConnector(page)).not.toBeNull();
        expect(await page.locator("body").getAttribute("data-picked")).toBe("target");
        expect(await page.locator("#composer").innerText()).toBe(name);
        // A partial name is not evidence that the requested app exists.
        await page.locator("#target").evaluate(node => node.remove());
        expect(await worker.selectModernConnector(page)).toBeNull();
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}, 20_000);
