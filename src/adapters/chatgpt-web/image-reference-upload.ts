import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { readLauncherBrowserHostDescriptor, selectLauncherPage } from "../../launcher-browser-host";
import { CHATGPT_COMPOSER_SELECTOR } from "../../chatgpt-session";
import { observeChatGptAttachmentUploads } from "./attachment-upload";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface ImageReferencePayload {
  referenceImagePaths: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UploadImageReferencesOptions extends ImageReferencePayload {
  browserHostDescriptorPath: string;
  targetId: string;
}

export interface ImageReferenceUploadResult {
  referenceCount: number;
}

function operationSignal(payload: ImageReferencePayload): AbortSignal {
  const timeoutMs = payload.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > UPLOAD_TIMEOUT_MS) {
    throw new Error("Image reference timeout must be 1..120000 ms");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return payload.signal ? AbortSignal.any([payload.signal, timeout]) : timeout;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

function imageFormat(buffer: Buffer): { extension: string; mimeType: string } {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  throw new Error("Image reference must contain PNG, JPEG or WebP data");
}

async function readReference(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("Image reference path must be an absolute local file path");
  }
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Image reference must be a regular file");
    if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error("Image reference must be nonempty and at most 20 MiB");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("Image reference changed while reading");
    const bytes = buffer.subarray(0, offset);
    const format = imageFormat(bytes);
    const extension = extname(path).toLowerCase();
    if (extension !== format.extension && !(format.mimeType === "image/jpeg" && extension === ".jpeg")) {
      throw new Error("Image reference extension does not match its PNG, JPEG or WebP format");
    }
    return { name: `codex-reference-${randomUUID()}${format.extension}`, mimeType: format.mimeType, buffer: bytes };
  } finally {
    await file.close();
  }
}

export async function attachImageReferences(page: Page, payload: ImageReferencePayload): Promise<ImageReferenceUploadResult> {
  const signal = operationSignal(payload);
  signal.throwIfAborted();
  const paths = payload.referenceImagePaths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 5) {
    throw new Error("Image references must contain 1..5 paths");
  }
  const files = await abortable(Promise.all(paths.map(path => readReference(path, signal))), signal);
  signal.throwIfAborted();
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  await abortable(composers.first().waitFor({ state: "visible", timeout: payload.timeoutMs ?? UPLOAD_TIMEOUT_MS }), signal);
  if (await abortable(composers.count(), signal) !== 1) throw new Error("Image reference upload requires exactly one visible ChatGPT composer");
  const form = composers.locator("xpath=ancestor::form[1]");
  const inputSelector = 'input[type="file"][multiple]:not([accept]), input[type="file"][accept*="image" i], input[data-testid="upload-photos-input"]';
  const scopedInputs = form.locator(inputSelector);
  const input = await abortable(scopedInputs.count(), signal) > 0 ? scopedInputs.last() : page.locator(inputSelector).last();
  await abortable(input.waitFor({ state: "attached", timeout: payload.timeoutMs ?? UPLOAD_TIMEOUT_MS }), signal);
  const observing = observeChatGptAttachmentUploads(page, files.map(file => file.name));
  void observing.then(observer => {
    if (signal.aborted) return observer.dispose();
  }, () => {});
  const uploads = await abortable(observing, signal);
  try {
    signal.throwIfAborted();
    await abortable(input.setInputFiles(files, { timeout: payload.timeoutMs ?? UPLOAD_TIMEOUT_MS }), signal);
    await abortable(Promise.all([
      uploads.wait(),
      ...files.map(file => page.getByRole("group", { name: file.name, exact: true })
        .or(page.locator(`.composer-attachment-surface:is(button, [role="button"])[aria-label=${JSON.stringify(file.name)}]`))
        .waitFor({ state: "visible", timeout: payload.timeoutMs ?? UPLOAD_TIMEOUT_MS })),
    ]), signal);
    uploads.throwIfFailed();
    signal.throwIfAborted();
    return { referenceCount: files.length };
  } finally {
    await uploads.dispose();
    signal.throwIfAborted();
  }
}

export async function uploadImageReferences(options: UploadImageReferencesOptions): Promise<ImageReferenceUploadResult> {
  const signal = operationSignal(options);
  signal.throwIfAborted();
  if (typeof options.targetId !== "string" || !options.targetId.trim() || options.targetId.length > 256) {
    throw new Error("Image reference targetId is invalid");
  }
  const descriptor = readLauncherBrowserHostDescriptor(options.browserHostDescriptorPath);
  const surfaces = Object.entries(descriptor.surfaceTargets).filter(([, targetId]) => targetId === options.targetId);
  if (surfaces.length !== 1) throw new Error("Image reference targetId must identify exactly one registered launcher surface");
  let browser: Browser | undefined;
  const disconnect = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener("abort", disconnect, { once: true });
  try {
    const connecting = chromium.connectOverCDP(descriptor.endpoint, { timeout: options.timeoutMs ?? UPLOAD_TIMEOUT_MS }).then(async connected => {
      browser = connected;
      if (signal.aborted) {
        await connected.close();
        signal.throwIfAborted();
      }
      return connected;
    });
    await abortable(connecting, signal);
    const { page } = await abortable(selectLauncherPage(browser!, descriptor, options.timeoutMs ?? UPLOAD_TIMEOUT_MS, surfaces[0]![0], signal), signal);
    if (new URL(page.url()).origin !== "https://chatgpt.com") {
      throw new Error("Image reference target must have the exact https://chatgpt.com origin");
    }
    return await attachImageReferences(page, { ...options, signal });
  } finally {
    signal.removeEventListener("abort", disconnect);
    await browser?.close();
    signal.throwIfAborted();
  }
}
