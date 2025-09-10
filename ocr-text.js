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

// --- Shared tesseract worker (singleton) ---
let _sharedWorkerPromise = null;
let _sharedLang = null;
let _sharedApiVersion = "v5";

async function getSharedWorker(lang = "eng") {
  // First time: create worker (and init if v4)
  if (!_sharedWorkerPromise) {
    _sharedLang = lang;
    _sharedWorkerPromise = (async () => {
      const { worker, apiVersion } = await createCompatWorker(lang);
      _sharedApiVersion = apiVersion;
      if (apiVersion === "v4") {
        await worker.loadLanguage(lang);
        await worker.initialize(lang);
      }
      return worker;
    })();
  } else if (_sharedLang !== lang) {
    // If a different language is requested later, (re)init only for v4
    const worker = await _sharedWorkerPromise;
    if (_sharedApiVersion === "v4") {
      await worker.loadLanguage(lang);
      await worker.initialize(lang);
    }
    _sharedLang = lang;
  }
  return { worker: await _sharedWorkerPromise, apiVersion: _sharedApiVersion };
}

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

  // Use the shared worker (singleton)
  const { worker, apiVersion } = await getSharedWorker(lang);

  try {
    const params = { tessedit_pageseg_mode: String(psm) };
    if (numericOnly) {
      params.tessedit_char_whitelist = "0123456789.-";
      params.classify_bln_numeric_mode = "1";
    }

    // v4 init handled in getSharedWorker; for v5 just set parameters
    await worker.setParameters(params);

    let best = { text: "", score: -1 };

    // Normalize input once
    const baseBuf = await toPngBuffer(image);

    // Save base (no-prep) if debugging
    const stamp = Date.now();
    const baseName = makeDebugBaseName(image, debugName);
    if (debug) {
      await saveDebugImage(baseBuf, `${baseName}_base_${stamp}.png`);
    }

    for (const mode of attempts) {
      const prepBuf = await preprocessImageToBuffer(baseBuf, mode);

      if (debug) {
        const tag = mode || "noprep";
        await saveDebugImage(prepBuf, `${baseName}_${tag}_${stamp}.png`);
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
    // Do NOT terminate the shared worker; keep it alive for reuse
    // await worker.terminate().catch(() => {});
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

// Replace your existing toThreeDecimalNumber with this version
function toThreeDecimalNumber(str) {
  if (!str) return NaN;

  // Keep only digits, optional leading minus, and dot
  let cleaned = str.replace(/[^\d\-.]/g, "");

  // If it already has a decimal point, parse and round
  if (cleaned.includes(".")) {
    const num = parseFloat(cleaned);
    return isNaN(num) ? NaN : parseFloat(num.toFixed(3));
  }

  // No decimal point present
  const negative = cleaned.startsWith("-");
  const digits = cleaned.replace("-", "");
  if (!/^\d+$/.test(digits)) return NaN;

  // --- Heuristic: leading zero decimal that lost the dot (e.g., "0419" => 0.419)
  // "0419" (len 4)  -> 0.419
  // "-0419" (len 5) -> -0.419
  if (digits.length === 4 && digits.startsWith("0")) {
    const frac = digits.slice(1).padStart(3, "0"); // "419"
    const composed = `${negative ? "-" : ""}0.${frac}`;
    const num = parseFloat(composed);
    return isNaN(num) ? NaN : parseFloat(num.toFixed(3));
  }

  // Existing rule:
  // If abs(value) >= 10000 → interpret last 3 digits as decimals
  const absVal = parseInt(digits, 10);
  if (absVal >= 10000) {
    const intPart = digits.slice(0, -3);
    const fracPart = digits.slice(-3).padStart(3, "0");
    const composed = `${negative ? "-" : ""}${intPart}.${fracPart}`;
    const num = parseFloat(composed);
    return isNaN(num) ? NaN : parseFloat(num.toFixed(3));
  }

  // Otherwise, treat as integer with .000
  const normal = negative ? -absVal : absVal;
  return parseFloat(normal.toFixed(3));
}

