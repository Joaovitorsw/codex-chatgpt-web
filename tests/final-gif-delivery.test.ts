import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertPresentedImage,
  materializeFinalImages,
  presentedImageRef,
  summarizeDeliveredImages,
} from "../src/adapters/chatgpt-web/final-images";

// Two 1x1 frames (black then white), with delays of 7 and 23 hundredths.
const animatedGif = Buffer.from([
  "474946383961",                 // GIF89a
  "01000100800000",               // Logical screen, two global colors
  "000000ffffff",                 // Black and white palette
  "21ff0b4e45545343415045322e300301000000", // Loop forever
  "21f9040407000000",             // First frame control
  "2c0000000001000100000202440100", // First frame, LZW: clear, black, end
  "21f9040417000000",             // Second frame control
  "2c00000000010001000002024c0100", // Second frame, LZW: clear, white, end
  "3b",
].join(""), "hex");

const gif87a = Buffer.from(
  "47494638376101000100800000000000ffffff2c00000000010001000002024401003b",
  "hex",
);

const image = { data: animatedGif.toString("base64"), mimeType: "image/gif", alt: "Animated preview" };

test.each([
  ["GIF87a", gif87a],
  ["GIF89a", animatedGif],
])("accepts %s with the GIF MIME type", (_version, bytes) => {
  expect(() => assertPresentedImage({ ...image, data: bytes.toString("base64") })).not.toThrow();
});

test("materializes both GIF frames and timing bytes without transcoding", () => {
  const ref = presentedImageRef(image);
  const delivered = materializeFinalImages(`Preview:\n${ref}`, [image]);
  expect(delivered).toBe(`Preview:\n![Animated preview](data:image/gif;base64,${image.data})`);
  const data = /data:image\/gif;base64,([A-Za-z0-9+/=]+)/.exec(delivered)?.[1];
  expect(data).toBeDefined();
  const bytes = Buffer.from(data!, "base64");
  expect(bytes).toEqual(animatedGif);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.slice("CODEXIMAGE:".length));
  expect(bytes.subarray(38, 46).toString("hex")).toBe("21f9040407000000");
  expect(bytes.subarray(61, 69).toString("hex")).toBe("21f9040417000000");
  expect(bytes.subarray(46, 61).toString("hex")).toBe("2c0000000001000100000202440100");
  expect(bytes.subarray(69, 84).toString("hex")).toBe("2c00000000010001000002024c0100");
});

test.each(["image/png", "image/jpeg", "image/webp", "application/octet-stream"])(
  "rejects GIF bytes labeled %s",
  mimeType => {
    expect(() => assertPresentedImage({ ...image, mimeType })).toThrow("MIME type");
  },
);

test.each([
  ["PNG", Buffer.from("89504e470d0a1a0a", "hex")],
  ["JPEG", Buffer.from("ffd8ff", "hex")],
  ["WebP", Buffer.from("RIFF0000WEBP")],
  ["unsupported GIF version", Buffer.from("GIF90a")],
  ["truncated header", Buffer.from("GIF89")],
  ["high-bit header lookalike", Buffer.from("c74946383961", "hex")],
])("rejects %s bytes labeled image/gif", (_kind, bytes) => {
  expect(() => assertPresentedImage({ ...image, data: bytes.toString("base64") })).toThrow("MIME type");
});

test("summarizes GIF data URLs so history cannot replay their Base64 payload", () => {
  const delivered = `![Animated preview](data:image/gif;base64,${image.data})`;
  const sha256 = createHash("sha256").update(animatedGif).digest("hex");
  const summary = `[previously delivered image: Animated preview; sha256=${sha256}; use codex_view_image to present again]`;
  const history = summarizeDeliveredImages(`Before\n${delivered}\n${delivered}\nAfter`);
  expect(history).toBe(`Before\n${summary}\n${summary}\nAfter`);
  expect(history).not.toContain(image.data);
  expect(history).not.toContain("data:image/");
  expect(summarizeDeliveredImages(history)).toBe(history);
});
