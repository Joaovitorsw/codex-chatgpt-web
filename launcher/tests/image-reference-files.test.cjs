const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeImageReferencePaths } = require("../electron/image-reference-files.cjs");

test("reference files are optional, bounded and must be actual supported images", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-image-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = path.join(root, "original.png");
  fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a00000000", "hex"));
  assert.equal(normalizeImageReferencePaths(undefined), undefined);
  assert.deepEqual(normalizeImageReferencePaths([png]), [fs.realpathSync(png)]);
  for (const invalid of [null, [], "file.png", ["relative.png"], Array(6).fill(png), [png, png], [root], [path.join(root, "missing.png")]]) {
    assert.throws(() => normalizeImageReferencePaths(invalid));
  }
  const fake = path.join(root, "fake.png");
  fs.writeFileSync(fake, "not an image");
  assert.throws(() => normalizeImageReferencePaths([fake]), /image|format/i);
  const large = path.join(root, "large.png");
  fs.writeFileSync(large, Buffer.alloc(1));
  fs.truncateSync(large, 20 * 1024 * 1024 + 1);
  assert.throws(() => normalizeImageReferencePaths([large]), /20|size/i);
});
