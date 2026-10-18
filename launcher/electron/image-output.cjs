const { PNG } = require("pngjs");

const OPTION_KEYS = new Set(["width", "height", "max_colors", "binary_alpha"]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_OUTPUT_DIMENSION = 2048;
const MAX_SOURCE_DIMENSION = 4096;
const HISTOGRAM_SIZE = 32768;

function requireInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`Image output ${name} must be an integer from ${min} to ${max}.`);
  }
}

function normalizeImageOutputOptions(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object"
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Image output options must be a plain object.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) throw new TypeError("Image output options must not be empty.");
  const options = {};
  for (const key of keys) {
    if (!OPTION_KEYS.has(key)) throw new TypeError(`Unknown image output option: ${String(key)}.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value")) throw new TypeError("Image output options must contain values, not accessors.");
    options[key] = descriptor.value;
  }
  if (Object.hasOwn(options, "width") || Object.hasOwn(options, "height")) {
    requireInteger(options.width, "width", 1, MAX_OUTPUT_DIMENSION);
    requireInteger(options.height, "height", 1, MAX_OUTPUT_DIMENSION);
    if (options.width * options.height > 4194304) throw new RangeError("Image output dimensions exceed 4194304 pixels.");
  }
  if (Object.hasOwn(options, "max_colors")) requireInteger(options.max_colors, "max_colors", 2, 256);
  if (Object.hasOwn(options, "binary_alpha") && typeof options.binary_alpha !== "boolean") {
    throw new TypeError("Image output binary_alpha must be a boolean.");
  }
  return options;
}

function validateChunks(source) {
  let offset = 8;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > source.length) throw new Error("Truncated PNG chunk.");
    if (type === "IHDR" && offset !== 8) throw new Error("Duplicate PNG IHDR chunk.");
    if (type === "IEND") {
      if (length !== 0 || end !== source.length) throw new Error("Invalid PNG end chunk.");
      return;
    }
    offset = end;
  }
  throw new Error("PNG end chunk is missing.");
}

function readSourcePng(source) {
  if (!Buffer.isBuffer(source) || source.length < 33
    || !source.subarray(0, 8).equals(PNG_SIGNATURE)
    || source.readUInt32BE(8) !== 13 || source.toString("ascii", 12, 16) !== "IHDR") {
    throw new TypeError("Image source must be a PNG Buffer with a valid IHDR header.");
  }
  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION) {
    throw new RangeError("PNG source dimensions must be between 1 and 4096 pixels per axis.");
  }
  if (source[28] !== 0) throw new Error("Image source must be a non-interlaced Electron PNG.");
  validateChunks(source);
  const image = PNG.sync.read(source, { checkCRC: true });
  if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) {
    throw new Error("Decoded PNG source dimensions do not match the header.");
  }
  return image;
}

function containImage(source, width, height) {
  if (source.width === width && source.height === height) return source;
  const scale = Math.min(width / source.width, height / source.height);
  const contentWidth = Math.max(1, Math.min(width, Math.round(source.width * scale)));
  const contentHeight = Math.max(1, Math.min(height, Math.round(source.height * scale)));
  const left = Math.floor((width - contentWidth) / 2);
  const top = Math.floor((height - contentHeight) / 2);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < contentHeight; y += 1) {
    const sourceY = Math.floor(y * source.height / contentHeight);
    for (let x = 0; x < contentWidth; x += 1) {
      const sourceX = Math.floor(x * source.width / contentWidth);
      const from = (sourceY * source.width + sourceX) * 4;
      const to = ((top + y) * width + left + x) * 4;
      data.writeUInt32BE(source.data.readUInt32BE(from), to);
    }
  }
  return { width, height, data };
}

function applyBinaryAlpha(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= 128) data[i + 3] = 255;
    else data.writeUInt32BE(0, i);
  }
}

function inspectPixels(data) {
  const seen = new Uint8Array(2097152);
  let colorCount = 0;
  let binaryAlpha = true;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha !== 0 && alpha !== 255) binaryAlpha = false;
    if (alpha === 0) continue;
    const color = data.readUIntBE(i, 3);
    const byte = color >>> 3;
    const mask = 1 << (color & 7);
    if ((seen[byte] & mask) === 0) {
      seen[byte] |= mask;
      colorCount += 1;
    }
  }
  return { colorCount, binaryAlpha };
}

function histogramKey(data, offset) {
  return ((data[offset] >>> 3) << 10) | ((data[offset + 1] >>> 3) << 5) | (data[offset + 2] >>> 3);
}

function buildHistogram(data) {
  const counts = new Uint32Array(HISTOGRAM_SIZE);
  const reds = new Uint32Array(HISTOGRAM_SIZE);
  const greens = new Uint32Array(HISTOGRAM_SIZE);
  const blues = new Uint32Array(HISTOGRAM_SIZE);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = histogramKey(data, i);
    counts[key] += 1;
    reds[key] += data[i];
    greens[key] += data[i + 1];
    blues[key] += data[i + 2];
  }
  const bins = [];
  for (let key = 0; key < counts.length; key += 1) {
    const count = counts[key];
    if (count === 0) continue;
    bins.push({ key, count, sums: [reds[key], greens[key], blues[key]],
      rgb: [reds[key] / count, greens[key] / count, blues[key] / count] });
  }
  return bins;
}

function colorBox(bins) {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  let count = 0;
  for (const bin of bins) {
    count += bin.count;
    for (let channel = 0; channel < 3; channel += 1) {
      min[channel] = Math.min(min[channel], bin.rgb[channel]);
      max[channel] = Math.max(max[channel], bin.rgb[channel]);
    }
  }
  let channel = 0;
  for (let i = 1; i < 3; i += 1) {
    if (max[i] - min[i] > max[channel] - min[channel]) channel = i;
  }
  return { bins, count, channel, score: (max[channel] - min[channel]) * count };
}

function splitBox(box) {
  const { bins, channel } = box;
  bins.sort((a, b) => a.rgb[channel] - b.rgb[channel] || a.key - b.key);
  let count = 0;
  let split = 1;
  for (let i = 0; i < bins.length - 1; i += 1) {
    count += bins[i].count;
    split = i + 1;
    if (count >= box.count / 2) break;
  }
  return [colorBox(bins.slice(0, split)), colorBox(bins.slice(split))];
}

function paletteMapping(bins, maxColors) {
  const boxes = [colorBox(bins)];
  while (boxes.length < maxColors) {
    let next = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].bins.length > 1 && (next === -1 || boxes[i].score > boxes[next].score)) next = i;
    }
    if (next === -1) break;
    boxes.splice(next, 1, ...splitBox(boxes[next]));
  }
  const mapping = new Uint32Array(HISTOGRAM_SIZE);
  for (const box of boxes) {
    const sums = [0, 0, 0];
    for (const bin of box.bins) {
      for (let channel = 0; channel < 3; channel += 1) sums[channel] += bin.sums[channel];
    }
    const rgb = sums.map((sum) => Math.round(sum / box.count));
    const packed = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    for (const bin of box.bins) mapping[bin.key] = packed;
  }
  return mapping;
}

function reduceColors(data, maxColors) {
  const mapping = paletteMapping(buildHistogram(data), maxColors);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) data.writeUIntBE(mapping[histogramKey(data, i)], i, 3);
  }
}

function prepareImageOutput(sourcePng, value) {
  const options = normalizeImageOutputOptions(value);
  const source = readSourcePng(sourcePng);
  const image = options?.width === undefined ? source : containImage(source, options.width, options.height);
  if (options?.binary_alpha === true) applyBinaryAlpha(image.data);
  let metadata = inspectPixels(image.data);
  if (options?.max_colors !== undefined && metadata.colorCount > options.max_colors) {
    reduceColors(image.data, options.max_colors);
    metadata = inspectPixels(image.data);
  }
  const png = options === undefined ? sourcePng
    : PNG.sync.write(image, { colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true });
  return { png, width: image.width, height: image.height,
    sourceWidth: source.width, sourceHeight: source.height, ...metadata, processed: true };
}

module.exports = { normalizeImageOutputOptions, prepareImageOutput };
