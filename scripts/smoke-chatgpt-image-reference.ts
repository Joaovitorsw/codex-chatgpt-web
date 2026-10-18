import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { chromium } from "playwright-core";
import { notifyLauncherTurn, readLauncherBrowserHostDescriptor, selectLauncherPage } from "../src/launcher-browser-host";

const [descriptorPath, referencePath, outputPath] = process.argv.slice(2);
if (!descriptorPath || !referencePath || !outputPath || !isAbsolute(outputPath) || !outputPath.endsWith(".png") || existsSync(outputPath)) {
  throw new Error("Pass launcher descriptor, reference image and new absolute PNG output path");
}
const require = createRequire(import.meta.url);
const { runBrowserHelperOperation } = require("../launcher/electron/browser-helper-verifier.cjs");
const owner = { traceId: `image_ref_smoke_${randomUUID().replaceAll("-", "")}`, helperPid: process.pid };
const lease = await notifyLauncherTurn(descriptorPath, { ...owner, phase: "start" });
const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
const browser = await chromium.connectOverCDP(descriptor.endpoint);
const { context, page } = await selectLauncherPage(browser, descriptor, 30_000, lease.surfaceId);
const heartbeat = setInterval(() => {
  void notifyLauncherTurn(descriptorPath, { ...owner, phase: "heartbeat" }).catch(() => {});
}, 5_000);
try {
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  const composer = page.locator('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]').filter({ visible: true }).last();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  if (new URL(page.url()).searchParams.get("temporary-chat") === "true") throw new Error("Image test requires a saved conversation");
  await composer.fill("Generate a NEW image using the attached original character as a visual reference. Draw the SAME young Black Brazilian man celebrating, raising one hand, preserving his face, short coiled hair, skin tone, green hoodie with pale drawstrings, dark shorts, green and white sneakers and body proportions. Full body single game sprite, crisp pixel art, real transparent background. No text, labels, scenery or extra characters. Actually generate the image now.");
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  const result = await runBrowserHelperOperation({
    helper: descriptor.helper, descriptorPath, appName: "Codex Native2", operation: "image_references",
    payload: { targetId: targetInfo.targetId, referenceImagePaths: [referencePath] },
  });
  if (result.value?.referenceCount !== 1) throw new Error("Reference upload was not confirmed");
  console.log(JSON.stringify({ stage: "reference_uploaded", reference_count: 1, reference_sha256: createHash("sha256").update(readFileSync(referencePath)).digest("hex") }));
  const form = page.locator('form[data-chatgpt-composer], form:has([data-testid="prompt-textarea"]), form:has(#prompt-textarea)').filter({ visible: true }).last();
  await form.locator('[data-testid="send-button"], [data-testid="composer-submit-button"], button[type="submit"], button[aria-label="Send prompt"], button[aria-label="Send message"]').filter({ visible: true }).first().click({ timeout: 30_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="generated-image-preview"] img, [data-message-author-role="assistant"] img, [data-turn="assistant"] img')]
    .some(node => node instanceof HTMLImageElement && node.naturalWidth >= 256 && node.naturalHeight >= 256), null, { timeout: 300_000 });
  const data = await page.evaluate(async () => {
    const image = [...document.querySelectorAll<HTMLImageElement>('[data-testid="generated-image-preview"] img, [data-message-author-role="assistant"] img, [data-turn="assistant"] img')]
      .filter(node => node.naturalWidth >= 256 && node.naturalHeight >= 256).at(-1)!;
    const response = await fetch(image.currentSrc || image.src);
    if (!response.ok) throw new Error(`Image download HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { base64: btoa(binary), width: image.naturalWidth, height: image.naturalHeight };
  });
  const bytes = Buffer.from(data.base64, "base64");
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Returned image is not a PNG");
  writeFileSync(outputPath, bytes, { flag: "wx" });
  console.log(JSON.stringify({ generated: true, path: outputPath, width: data.width, height: data.height, bytes: bytes.length,
    reference_count: 1, transport: "compiled browser helper -> confirmed actual reference upload -> ChatGPT Web generation (control API not exercised)" }));
} finally {
  clearInterval(heartbeat);
  await notifyLauncherTurn(descriptorPath, { ...owner, phase: "end", status: "completed", retain: false });
  await browser.close();
}
