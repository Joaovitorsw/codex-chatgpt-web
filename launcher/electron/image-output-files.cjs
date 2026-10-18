const fs = require("node:fs");
const path = require("node:path");
const { normalizeImageOutputOptions, prepareImageOutput } = require("./image-output.cjs");

function imageOutputDestination(outputPath, outputOptions) {
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== ".png") {
    throw new Error("Image output path must be an absolute new .png path");
  }
  const options = normalizeImageOutputOptions(outputOptions);
  const sourcePath = options ? outputPath.replace(/\.png$/i, ".source.png") : undefined;
  for (const candidate of [outputPath, sourcePath].filter(Boolean)) {
    if (fs.existsSync(candidate)) throw new Error(`Refusing to overwrite existing image: ${candidate}`);
  }
  return { options, sourcePath };
}

function saveImageOutput({ png, outputPath, outputOptions, sourceWidth, sourceHeight }) {
  const { options, sourcePath } = imageOutputDestination(outputPath, outputOptions);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (sourcePath) fs.writeFileSync(sourcePath, png, { flag: "wx" });
  let prepared;
  try {
    prepared = options ? prepareImageOutput(png, options) : undefined;
  } catch (error) {
    throw new Error(`Image preparation failed; source preserved at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const final = prepared?.png ?? png;
  fs.writeFileSync(outputPath, final, { flag: "wx" });
  return {
    path: outputPath,
    mimeType: "image/png",
    width: prepared?.width ?? sourceWidth,
    height: prepared?.height ?? sourceHeight,
    bytes: final.length,
    ...(prepared ? {
      processed: true,
      outputOptions: options,
      sourcePath,
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
      colorCount: prepared.colorCount,
      binaryAlpha: prepared.binaryAlpha,
    } : {}),
  };
}

module.exports = { imageOutputDestination, saveImageOutput };
