const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PNG } = require("pngjs");
const { imageOutputDestination, saveImageOutput } = require("../electron/image-output-files.cjs");

test("saving a processed PNG preserves source and verifies exact dimensions, palette and alpha", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-image-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "icon.png");
  const source = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < source.data.length; i += 4) {
    source.data.set([i * 3, i * 2, i, i % 8 ? 180 : 40], i);
  }
  const png = PNG.sync.write(source);
  const options = { width: 32, height: 32, max_colors: 4, binary_alpha: true };
  const result = saveImageOutput({ png, outputPath, outputOptions: options, sourceWidth: 4, sourceHeight: 4 });
  assert.equal(result.sourcePath, path.join(root, "icon.source.png"));
  assert.deepEqual(fs.readFileSync(result.sourcePath), png);
  const final = PNG.sync.read(fs.readFileSync(outputPath));
  assert.deepEqual([final.width, final.height], [32, 32]);
  const colors = new Set();
  for (let i = 0; i < final.data.length; i += 4) {
    assert.ok(final.data[i + 3] === 0 || final.data[i + 3] === 255);
    if (final.data[i + 3]) colors.add(final.data.subarray(i, i + 3).toString("hex"));
  }
  assert.ok(colors.size <= 4);
  assert.equal(result.colorCount, colors.size);
  assert.equal(result.binaryAlpha, true);
  assert.equal(result.bytes, fs.statSync(outputPath).size);
  assert.throws(() => saveImageOutput({ png, outputPath, outputOptions: options }), /exist|overwrite/i);
});

test("legacy output bytes are unchanged and a source collision fails before any write", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-image-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = PNG.sync.write(new PNG({ width: 2, height: 3 }));
  const outputPath = path.join(root, "legacy.png");
  const result = saveImageOutput({ png, outputPath, sourceWidth: 2, sourceHeight: 3 });
  assert.deepEqual(fs.readFileSync(outputPath), png);
  assert.equal(result.processed, undefined);
  assert.equal(fs.existsSync(path.join(root, "legacy.source.png")), false);
  const collision = path.join(root, "collision.png");
  fs.writeFileSync(path.join(root, "collision.source.png"), "keep original");
  assert.throws(() => imageOutputDestination(collision, { width: 32, height: 32 }), /exist|overwrite/i);
  assert.equal(fs.existsSync(collision), false);
  assert.equal(fs.readFileSync(path.join(root, "collision.source.png"), "utf8"), "keep original");
  assert.throws(() => imageOutputDestination(path.join(root, "bad.png"), { width: 32 }), /height|together/i);
});

test("a source outside processing limits remains recoverable when preparation fails", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-image-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = PNG.sync.write(new PNG({ width: 4097, height: 1 }));
  const outputPath = path.join(root, "large.png");
  assert.throws(() => saveImageOutput({ png, outputPath, outputOptions: { width: 32, height: 32 } }), /4096/);
  assert.deepEqual(fs.readFileSync(path.join(root, "large.source.png")), png);
  assert.equal(fs.existsSync(outputPath), false);
});
