const fs = require("node:fs");
const path = require("node:path");

function normalizeImageReferencePaths(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error("Image reference paths must contain 1 to 5 files");
  }
  const unique = new Set();
  return value.map(file => {
    if (typeof file !== "string" || file.length > 4096 || !path.isAbsolute(file)) {
      throw new Error("Image reference path must be absolute");
    }
    const resolved = fs.realpathSync(file);
    const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (unique.has(identity)) throw new Error("Duplicate image reference path");
    unique.add(identity);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size < 12 || stat.size > 20 * 1024 * 1024) {
      throw new Error("Image reference must be a nonempty file of at most 20 MiB");
    }
    const header = Buffer.alloc(12);
    const fd = fs.openSync(resolved, "r");
    try { fs.readSync(fd, header, 0, header.length, 0); }
    finally { fs.closeSync(fd); }
    const extension = path.extname(resolved).toLowerCase();
    const png = extension === ".png" && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const jpeg = [".jpg", ".jpeg"].includes(extension) && header[0] === 255 && header[1] === 216 && header[2] === 255;
    const webp = extension === ".webp" && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) throw new Error("Image reference format must be PNG, JPEG or WebP");
    return resolved;
  });
}

module.exports = { normalizeImageReferencePaths };
