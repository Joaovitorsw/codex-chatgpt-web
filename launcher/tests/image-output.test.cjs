const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const { normalizeImageOutputOptions, prepareImageOutput } = require("../electron/image-output.cjs");

function fixture(width, height, pixel) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return PNG.sync.write({ width, height, data });
}

function pixelAt(image, x, y) {
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4)];
}

function visibleColors(image) {
  const colors = new Set();
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3]) colors.add(image.data.readUIntBE(i, 3));
  }
  return colors;
}

test("normalizes only explicitly requested snake_case output properties", () => {
  assert.equal(normalizeImageOutputOptions(undefined), undefined);
  const input = { width: 32, height: 64, max_colors: 16, binary_alpha: false };
  const output = normalizeImageOutputOptions(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.deepEqual(normalizeImageOutputOptions({ binary_alpha: false }), { binary_alpha: false });
  assert.deepEqual(normalizeImageOutputOptions({ width: 2048, height: 2048 }), { width: 2048, height: 2048 });
  assert.deepEqual(normalizeImageOutputOptions({ max_colors: 256 }), { max_colors: 256 });
});

test("rejects invalid output options before inspecting PNG input", () => {
  const invalid = [null, [], "32", 32, true, new Date(), {}, { width: 32 }, { height: 32 },
    { width: 0, height: 32 }, { width: 32, height: -1 }, { width: 2049, height: 32 },
    { width: 1.5, height: 32 }, { width: "32", height: 32 }, { width: NaN, height: 32 },
    { width: Infinity, height: 32 }, { width: undefined, height: undefined },
    { max_colors: 1 }, { max_colors: 257 }, { max_colors: 2.5 }, { max_colors: "16" },
    { binary_alpha: 1 }, { binary_alpha: undefined }, { maxColors: 16 },
    { binary_alpha: true, extra: false }, Object.create({ width: 32, height: 32 }),
    { [Symbol("unknown")]: true, binary_alpha: false }];
  for (const value of invalid) {
    assert.throws(() => normalizeImageOutputOptions(value), /image output|width|height|max_colors|binary_alpha/i);
    assert.throws(() => prepareImageOutput(Buffer.alloc(0), value), /image output|width|height|max_colors|binary_alpha/i);
  }
});

test("exact 32x32 RGBA roundtrip preserves known pixels and input bytes", () => {
  const source = fixture(32, 32, (x, y) => [x * 7, y * 7, 91, (x + y) % 256]);
  const original = Buffer.from(source);
  const result = prepareImageOutput(source, { width: 32, height: 32 });
  assert.deepEqual(PNG.sync.read(result.png).data, PNG.sync.read(source).data);
  assert.deepEqual(source, original);
  assert.deepEqual({ ...result, png: undefined }, {
    png: undefined, width: 32, height: 32, sourceWidth: 32, sourceHeight: 32,
    colorCount: 1023, binaryAlpha: false, processed: true,
  });
  assert.equal(result.png[25], 6);
});

test("missing options preserves the original PNG bytes", () => {
  const source = fixture(2, 1, (x) => [30, 40, 50, x * 127]);
  const result = prepareImageOutput(source);
  assert.equal(result.png, source);
  assert.equal(result.width, 2);
  assert.equal(result.colorCount, 1);
  assert.equal(result.binaryAlpha, false);
});

test("wide source is contained with centered transparent padding and nearest-neighbor blocks", () => {
  const source = fixture(4, 2, (x, y) => [x * 60, y * 200, 10, 255]);
  const result = prepareImageOutput(source, { width: 8, height: 8 });
  const image = PNG.sync.read(result.png);
  assert.equal(image.width, 8);
  assert.equal(image.height, 8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const expected = y < 2 || y >= 6 ? [0, 0, 0, 0] : [Math.floor(x / 2) * 60, Math.floor((y - 2) / 2) * 200, 10, 255];
      assert.deepEqual(pixelAt(image, x, y), expected);
    }
  }
  assert.equal(result.sourceWidth, 4);
  assert.equal(result.sourceHeight, 2);
});

test("portrait downsampling contains the full image without cropping", () => {
  const source = fixture(2, 4, (x, y) => [x * 200, y * 60, 10, 255]);
  const image = PNG.sync.read(prepareImageOutput(source, { width: 4, height: 2 }).png);
  assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(image, 1, 0), [0, 0, 10, 255]);
  assert.deepEqual(pixelAt(image, 1, 1), [0, 120, 10, 255]);
  assert.deepEqual(pixelAt(image, 2, 1), [0, 0, 0, 0]);
});

test("contain preserves existing transparent margins instead of trimming", () => {
  const source = fixture(4, 4, (x, y) => [90, 60, 20, x === 1 && y === 1 ? 255 : 0]);
  const image = PNG.sync.read(prepareImageOutput(source, { width: 8, height: 8 }).png);
  assert.deepEqual(pixelAt(image, 2, 2), [90, 60, 20, 255]);
  assert.deepEqual(pixelAt(image, 0, 0), [90, 60, 20, 0]);
});

test("palette reduction bounds varied RGB colors and preserves every alpha byte", () => {
  const source = fixture(64, 64, (x, y) => [x * 4, y * 4, (x * 17 + y * 31) % 256, (x + y) % 255 + 1]);
  const result = prepareImageOutput(source, { max_colors: 16 });
  const image = PNG.sync.read(result.png);
  const colors = visibleColors(image);
  assert.ok(colors.size <= 16 && colors.size > 1);
  assert.equal(result.colorCount, colors.size);
  assert.equal(result.binaryAlpha, false);
  const before = PNG.sync.read(source);
  for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], before.data[i]);
  assert.deepEqual(prepareImageOutput(source, { max_colors: 16 }).png, result.png);
});

test("already bounded colors remain byte-exact including partial alpha and hidden RGB", () => {
  const source = fixture(4, 1, (x) => [[10, 20, 30, 0], [21, 22, 23, 127], [201, 202, 203, 128], [21, 22, 23, 255]][x]);
  const image = PNG.sync.read(prepareImageOutput(source, { max_colors: 2 }).png);
  assert.deepEqual(image.data, PNG.sync.read(source).data);
});

test("binary alpha uses the 128 threshold and clears transparent RGB", () => {
  const alphas = [0, 1, 127, 128, 254, 255];
  const source = fixture(6, 1, (x) => [11, 22, 33, alphas[x]]);
  const result = prepareImageOutput(source, { binary_alpha: true });
  const image = PNG.sync.read(result.png);
  for (let x = 0; x < 6; x += 1) {
    assert.deepEqual(pixelAt(image, x, 0), x < 3 ? [0, 0, 0, 0] : [11, 22, 33, 255]);
  }
  assert.equal(result.binaryAlpha, true);
  assert.equal(result.colorCount, 1);
});

test("binary_alpha false preserves channels and reports actual binary alpha", () => {
  for (const alpha of [127, 255]) {
    const source = fixture(1, 1, () => [11, 22, 33, alpha]);
    const result = prepareImageOutput(source, { binary_alpha: false });
    assert.deepEqual(PNG.sync.read(result.png).data, PNG.sync.read(source).data);
    assert.equal(result.binaryAlpha, alpha === 255);
  }
});

test("all-transparent source reports zero visible colors with combined processing", () => {
  const source = fixture(3, 2, (x, y) => [x * 70, y * 100, 90, 0]);
  const result = prepareImageOutput(source, { width: 32, height: 32, max_colors: 16, binary_alpha: true });
  assert.equal(result.colorCount, 0);
  assert.equal(result.binaryAlpha, true);
  assert.ok(PNG.sync.read(result.png).data.every((byte) => byte === 0));
});

test("rejects malformed or oversized PNG headers before decoder allocation", () => {
  const source = fixture(1, 1, () => [1, 2, 3, 255]);
  for (const [width, height] of [[4097, 1], [1, 4097], [0, 1], [1, 0]]) {
    const oversized = Buffer.from(source);
    oversized.writeUInt32BE(width, 16);
    oversized.writeUInt32BE(height, 20);
    assert.throws(() => prepareImageOutput(oversized, { max_colors: 2 }), /source.*dimensions|4096/i);
  }
  for (const input of [null, "png", Buffer.alloc(0), source.subarray(0, 24), Buffer.from("not a PNG")]) {
    assert.throws(() => prepareImageOutput(input, { max_colors: 2 }), /PNG/i);
  }
  const corrupted = Buffer.from(source);
  corrupted[29] ^= 1;
  assert.throws(() => prepareImageOutput(corrupted, { max_colors: 2 }));
});

test("rejects duplicate IHDR chunks that could override the preflight dimension limit", () => {
  const source = fixture(1, 1, () => [1, 2, 3, 255]);
  const duplicate = Buffer.concat([source.subarray(0, 33), source.subarray(8)]);
  assert.throws(() => prepareImageOutput(duplicate, { max_colors: 2 }), /duplicate.*IHDR/i);
});

test("rejects interlaced sources outside the Electron PNG contract before inflation", () => {
  const source = fixture(1, 1, () => [1, 2, 3, 255]);
  source[28] = 1;
  assert.throws(() => prepareImageOutput(source, { max_colors: 2 }), /non-interlaced/i);
});

test("every histogram bin is bounded by palettes at both permitted endpoints", () => {
  const source = fixture(256, 128, (x, y) => {
    const key = y * 256 + x;
    return [(key >>> 10) * 8, ((key >>> 5) & 31) * 8, (key & 31) * 8, 255];
  });
  for (const max_colors of [2, 256]) {
    const result = prepareImageOutput(source, { max_colors });
    const count = visibleColors(PNG.sync.read(result.png)).size;
    assert.ok(count > 1 && count <= max_colors);
    assert.equal(result.colorCount, count);
  }
});

test("accepts the source dimension boundary and produces a one-pixel target", () => {
  const source = fixture(4096, 1, () => [19, 29, 39, 128]);
  const result = prepareImageOutput(source, { width: 1, height: 1 });
  assert.equal(result.sourceWidth, 4096);
  assert.deepEqual(pixelAt(PNG.sync.read(result.png), 0, 0), [19, 29, 39, 128]);
});
