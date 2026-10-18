import { createHash } from "node:crypto";

export interface PresentedImage {
  data: string;
  mimeType: string;
  alt: string;
}

export function presentedImageRef(image: PresentedImage): string {
  return `CODEXIMAGE:${createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex")}`;
}

export function materializeFinalImages(answer: string, images: PresentedImage[]): string {
  if (!answer.includes("CODEXIMAGE:")) return answer;
  const byRef = new Map(images.map(image => [presentedImageRef(image), image]));
  let references = 0;
  let outputChars = answer.length;
  return answer.replace(/CODEXIMAGE:[a-f0-9]{64}/g, ref => {
    const image = byRef.get(ref);
    if (!image) throw new Error("Final image reference was not read in the current turn");
    references++;
    outputChars += image.data.length + image.mimeType.length + 13 - ref.length;
    if (references > 8 || outputChars > 20 * 1024 * 1024) throw new Error("Final image expansion budget exceeded");
    assertPresentedImage(image);
    const alt = image.alt.replace(/[\[\]\r\n]/g, " ");
    return `![${alt}](data:${image.mimeType};base64,${image.data})`;
  });
}

export function summarizeDeliveredImages(text: string): string {
  return text.replace(/!\[([^\]\r\n]*)\]\(data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)\)/g, (_match, alt: string, data: string) => {
    const sha256 = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
    return `[previously delivered image: ${alt}; sha256=${sha256}; use codex_view_image to present again]`;
  });
}

export function assertPresentedImage(value: unknown): asserts value is PresentedImage {
  if (!value || typeof value !== "object") throw new Error("Invalid presented image");
  const image = value as Partial<PresentedImage>;
  if (typeof image.data !== "string" || image.data.length > 16 * 1024 * 1024
    || typeof image.alt !== "string" || image.alt.length > 500) throw new Error("Invalid presented image payload");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== image.data) throw new Error("Invalid presented image Base64");
  const png = image.mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = image.mimeType === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  const webp = image.mimeType === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("Presented image content must match PNG, JPEG, or WebP MIME type");
}
