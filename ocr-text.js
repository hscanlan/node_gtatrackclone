// ocr-text.js
// Extract text from an image (PNG/JPG). Compatible with tesseract.js v4 and v5.
// Supports numeric-only mode (digits + dot + minus).
// Updated: accepts file path OR Buffer. Saves debug images with meaningful names + timestamp.

import sharp from "sharp";
import { createWorker } from "tesseract.js";
import path from "path";

/**
 * Extract text from an image (file path OR Buffer).
 * Ensures the parsed number is interpreted with exactly 3 decimal places.
 *
 * @param {string|Buffer} image          File path or PNG/JPG Buffer
 * @param {object} [opts]
 * @param {string} [opts.lang="eng"]
 * @param {number} [opts.psm=7]
 * @param {boolean} [opts.numericOnly=true]
 * @param {string|false} [opts.preprocess="auto"]  "auto" | "gentle" | "hard" | false
 * @param {boolean} [opts.debug=false]   If true, write the base & preprocessed images to disk
 * @param {string}  [opts.debugName]     Optional logical name prefix for debug files
 * @returns {Promise<number>} numeric value coerced to 3 decimals
 */
export async function extractText(image, opts = {}) {
  const {
    lang = "eng",
    psm = 7,
    numericOnly = true,
    preprocess = "auto",
    debug = false,
    debugName,
  } = opts;

  const attempts = [];
  if (preprocess === "auto") attempts.push("gentle", "hard");
  else if (preprocess) attempts.push(preprocess);
  else attempts.push(false);

  const { worker, apiVersion } = await createCompatWorker(lang);

  try {
    const params = { tessedit_pageseg_mode: String(psm) };
    if (numericOnly) {
      params.tessedit_char_whitelist = "0123456789.-";
      params.classify_bln_numeric_mode = "1";
    }

    if (apiVersion === "v4") {
      await worker.loadLanguage(lang);
      await worker.initialize(lang);
    }
    await worker.setParameters(params);

    let best = { text: "", score: -1 };

    // Normalize input once
    const baseBuf = await toPngBuffer(image);

    // Save base (no-prep) if debugging
    const stamp = Date.now();
    const baseName = makeDebugBaseName(image, debugName);
    if (debug) {
      await saveDebugImage(baseBuf, `./screencaps/${baseName}_base_${stamp}.png`);
    }

    for (const mode of attempts) {
      const prepBuf = await preprocessImageToBuffer(baseBuf, mode);

      if (debug) {
        const tag = mode || "noprep";
        await saveDebugImage(prepBuf, `./screencaps/${baseName}_${tag}_${stamp}.png`);
      }

      const {
        data: { text },
      } = await worker.recognize(prepBuf);

      const cleaned = postClean(text, numericOnly);
      const score = scoreNumeric(cleaned);

      if (score > best.score) best = { text: cleaned, score };
      if (best.score >= 3) break;
    }

    return toThreeDecimalNumber(best.text.trim());
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/* ---------- helpers ---------- */

async function createCompatWorker(lang) {
  // Simple compatibility wrapper for tesseract.js v4/v5
  const worker = await createWorker(lang);
  return { worker, apiVersion: "v5" }; // adjust if you need v4
}

// Normalize any input (path/Buffer) into a PNG Buffer
async function toPngBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return await sharp(input).toFormat("png").toBuffer();
  }
  if (typeof input === "string") {
    return await sharp(input).toFormat("png").toBuffer();
  }
  throw new Error("extractText: `image` must be a file path or Buffer");
}

/**
 * Preprocess the image and return a Buffer.
 * (No file I/O here; saving handled centrally when debug is enabled.)
 */
async function preprocessImageToBuffer(inputBuf, mode) {
  if (mode === "gentle") {
    return await sharp(inputBuf)
      .resize({ width: 2000, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen()
      .toFormat("png")
      .toBuffer();
  }

  if (mode === "hard") {
    return await sharp(inputBuf)
      .resize({ width: 2000, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .median(1)
      .threshold(150)
      .toFormat("png")
      .toBuffer();
  }

  // No preprocessing
  return inputBuf;
}

/**
 * Save a PNG Buffer to disk with the provided filename (in CWD).
 */
async function saveDebugImage(buf, filename) {
  await sharp(buf).toFile(filename);
}

/**
 * Derive a meaningful debug name from either a provided debugName,
 * the original file path, or fall back to "ocr_buffer".
 */
function makeDebugBaseName(image, debugName) {
  if (debugName && typeof debugName === "string") {
    return sanitizeName(debugName);
  }
  if (typeof image === "string") {
    const base = path.basename(image, path.extname(image));
    return sanitizeName(base || "ocr_image");
  }
  return "ocr_buffer";
}

function sanitizeName(name) {
  return String(name).replace(/[^\w.-]+/g, "_");
}

/**
 * Strip noise from text (numbers only if numericOnly = true)
 */
function postClean(text, numericOnly) {
  let cleaned = text.replace(/\s+/g, "");
  if (numericOnly) cleaned = cleaned.replace(/[^0-9.-]/g, "");
  return cleaned;
}

/**
 * Heuristic: longer, more numeric-y text is “better”
 */
function scoreNumeric(txt) {
  if (!txt) return -1;
  let score = 0;
  if (/^-?\d/.test(txt)) score += 2;
  if (txt.includes(".")) score += 1;
  score += txt.length;
  return score;
}

/**
 * Parse string → number with exactly 3 decimals
 */
function toThreeDecimalNumber(str) {
  if (!str) return NaN;
  const num = parseFloat(str);
  if (isNaN(num)) return NaN;
  return parseFloat(num.toFixed(3));
}
