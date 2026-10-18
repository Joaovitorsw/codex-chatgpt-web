import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { attachImageReferences, uploadImageReferences } from "../src/adapters/chatgpt-web/image-reference-upload";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const directories: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YQAAAAASUVORK5CYII=", "base64");

async function image(name = "reference.png", data = png) {
  const directory = await mkdtemp(join(tmpdir(), "image-reference-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, data);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test("rejects invalid reference counts before touching a page", async () => {
  for (const referenceImagePaths of [[], Array(6).fill("unused.png")]) {
    await expect(attachImageReferences({} as Page, { referenceImagePaths })).rejects.toThrow("1..5");
  }
});

test("validates file existence, regular-file size, extension and actual format", async () => {
  const valid = await image();
  for (const path of [valid + ".missing", await image("fake.png", Buffer.from("not an image")), await image("fake.jpg"), await image("image.svg")]) {
    await expect(attachImageReferences({} as Page, { referenceImagePaths: [path] })).rejects.toThrow();
  }
  await expect(attachImageReferences({} as Page, { referenceImagePaths: [directories[0]!] })).rejects.toThrow("regular file");
  await expect(attachImageReferences({} as Page, { referenceImagePaths: [await image("large.png", Buffer.alloc(20 * 1024 * 1024 + 1))] })).rejects.toThrow("20 MiB");
});

test("a pre-aborted request never accesses the page", async () => {
  await expect(attachImageReferences({} as Page, {
    referenceImagePaths: [await image()], signal: AbortSignal.abort(new Error("cancel fixture")),
  })).rejects.toThrow("cancel fixture");
});

const executable = process.env.CHATGPT_DOM_TEST_BROWSER;
async function failureMessage(pending: Promise<unknown>): Promise<string> {
  let error: unknown;
  try { await pending; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}
const fixtureHtml = `<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">keep this prompt</div>
<input type="file" multiple><button type="button" onclick="window.sends++">Send</button></form>
<script>window.sends=0;window.bytes=[];window.cards=true;
document.querySelector('input').onchange=async event=>{
  for(const file of event.target.files){
    window.bytes.push({name:file.name,type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
    if(window.cards){const card=document.createElement('div');card.role='group';card.setAttribute('aria-label',file.name);card.textContent=file.name;(document.querySelector('[data-chatgpt-composer]')||document.querySelector('form')||document.body).append(card);}
    fetch('/backend-api/files/process_upload_stream',{method:'POST',body:JSON.stringify({file_name:file.name,file_id:file.name})}).then(r=>r.text()).catch(()=>{});
  }
};</script>`;

async function fixture(options: {
  handler: (request: Request) => Response | Promise<Response>;
  run: (page: Page) => Promise<void>;
}) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname === "/") return new Response(fixtureHtml, { headers: { "content-type": "text/html" } });
    if (new URL(request.url).pathname === "/favicon.ico") return new Response("");
    return options.handler(request);
  } });
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await options.run(page);
  } finally {
    await browser.close();
    server.stop(true);
  }
}

test.skipIf(!executable)("uploads actual bytes with unique safe names and waits for delayed processing", async () => {
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let observed!: () => void;
  const started = new Promise<void>(resolve => { observed = resolve; });
  await fixture({
    handler: async request => {
      const { file_id } = await request.json() as { file_id: string };
      observed();
      await completed;
      return new Response(JSON.stringify({ event: "file.processing.completed", file_id }) + "\n");
    },
    run: async page => {
      const path = await image("private source.png");
      let returned = false;
      const uploading = attachImageReferences(page, { referenceImagePaths: [path, path], timeoutMs: 5000 }).then(value => { returned = true; return value; });
      await started;
      expect(returned).toBe(false);
      expect(await page.getByRole("group").count()).toBe(2);
      finish();
      expect(await uploading).toEqual({ referenceCount: 2 });
      const payloads = await page.evaluate(() => (window as unknown as { bytes: {name: string; type: string; bytes: number[]}[] }).bytes);
      expect(new Set(payloads.map(payload => payload.name)).size).toBe(2);
      for (const payload of payloads) {
        expect(payload.name).toMatch(/^codex-reference-[a-f0-9-]+\.png$/);
        expect(payload.type).toBe("image/png");
        expect(Buffer.from(payload.bytes)).toEqual(png);
      }
      expect(await page.locator("#prompt-textarea").textContent()).toBe("keep this prompt");
      expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
    },
  });
}, 10000);

for (const failure of ["http", "processing", "unconfirmed"] as const) {
  test.skipIf(!executable)(`rejects ${failure} upload failure even with visible cards`, async () => {
    await fixture({
      handler: () => {
        if (failure === "http") return new Response("unavailable", { status: 503 });
        const event = failure === "processing" ? "file.processing.error" : "file.processing.file_ready";
        return new Response(JSON.stringify({ event }) + "\n");
      },
      run: async page => {
        let error: unknown;
        try { await attachImageReferences(page, { referenceImagePaths: [await image()], timeoutMs: 3000 }); }
        catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          failure === "http" ? "HTTP 503" : failure === "processing" ? "file.processing.error" : "without a completion event",
        );
        expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
      },
    });
  }, 10000);
}

test.skipIf(!executable)("processing completion cannot replace a visible per-file card", async () => {
  await fixture({
    handler: () => new Response('{"event":"file.processing.completed"}\n'),
    run: async page => {
      await page.evaluate(() => { (window as unknown as { cards: boolean }).cards = false; });
      expect(await failureMessage(attachImageReferences(page, { referenceImagePaths: [await image()], timeoutMs: 300 }))).toBeTruthy();
    },
  });
}, 10000);

test.skipIf(!executable)("abort interrupts pending processing without sending", async () => {
  let observed!: () => void;
  const started = new Promise<void>(resolve => { observed = resolve; });
  await fixture({
    handler: () => { observed(); return new Response(new ReadableStream({ start() {} })); },
    run: async page => {
      const controller = new AbortController();
      const uploading = attachImageReferences(page, { referenceImagePaths: [await image()], signal: controller.signal, timeoutMs: 2000 });
      await started;
      controller.abort(new Error("fixture disconnected"));
      expect(await failureMessage(uploading)).toContain("fixture disconnected");
      expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
    },
  });
}, 10000);

for (const layout of ["generic", "lexical-outside-form", "test-id-outside-form"] as const) {
  test.skipIf(!executable)(`supports ${layout} composer without a prompt-textarea id`, async () => {
    await fixture({
      handler: () => new Response('{"event":"file.processing.completed"}\n'),
      run: async page => {
        await page.evaluate(layout => {
          const composer = document.querySelector("#prompt-textarea")!;
          composer.removeAttribute("id");
          composer.setAttribute("role", "textbox");
          const form = document.querySelector("form")!;
          form.removeAttribute("data-chatgpt-composer");
          if (layout === "lexical-outside-form") composer.setAttribute("data-lexical-editor", "true");
          if (layout === "test-id-outside-form") composer.setAttribute("data-testid", "prompt-textarea");
          if (layout !== "generic") document.body.append(document.querySelector('input[type="file"]')!);
        }, layout);
        expect(await attachImageReferences(page, { referenceImagePaths: [await image()], timeoutMs: 2000 })).toEqual({ referenceCount: 1 });
      },
    });
  }, 10000);
}

test.skipIf(!executable)("wrapper requires exact CDP target and ChatGPT origin and disconnects without closing pages", async () => {
  const browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--remote-debugging-port=0", "--enable-automation"] });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,fixture");
    const session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    const browserSession = await browser.newBrowserCDPSession();
    const { arguments: commandLine } = await browserSession.send("Browser.getBrowserCommandLine");
    const profile = commandLine.find(argument => argument.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    const { readFile } = await import("node:fs/promises");
    const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    const directory = await mkdtemp(join(tmpdir(), "image-reference-descriptor-"));
    directories.push(directory);
    const descriptorPath = join(directory, "descriptor.json");
    const surfaceId = "s".repeat(32);
    await writeFile(descriptorPath, JSON.stringify({
      version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
      endpoint: `http://127.0.0.1:${port}`, control: { endpoint: "http://127.0.0.1:9999", token: "t".repeat(40) },
      helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId, surfaceTargets: { [surfaceId]: targetInfo.targetId }, createdAt: new Date().toISOString(),
    }));
    const options = { browserHostDescriptorPath: descriptorPath, referenceImagePaths: [await image()], timeoutMs: 3000 };
    expect(await failureMessage(uploadImageReferences({ ...options, targetId: "missing" }))).toContain("exactly one");
    expect(await failureMessage(uploadImageReferences({ ...options, targetId: targetInfo.targetId }))).toContain("exact https://chatgpt.com origin");
    expect(page.isClosed()).toBe(false);
    expect(await page.title()).toBe("");
    await page.route("https://chatgpt.com/**", async route => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { file_id: string };
        await route.fulfill({ body: JSON.stringify({ event: "file.processing.completed", file_id: body.file_id }) + "\n" });
      } else await route.fulfill({ contentType: "text/html", body: fixtureHtml });
    });
    await page.goto("https://chatgpt.com/");
    const decoy = await browser.newPage();
    await decoy.setContent(fixtureHtml);
    expect(await uploadImageReferences({ ...options, targetId: targetInfo.targetId })).toEqual({ referenceCount: 1 });
    expect(await page.getByRole("group").count()).toBe(1);
    expect(await decoy.getByRole("group").count()).toBe(0);
    expect(page.isClosed()).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
    await session.detach();
    await browserSession.detach();
  } finally {
    await browser.close();
  }
}, 10000);
