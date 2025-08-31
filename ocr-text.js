// ocr-text.js
// Extract text from an image (PNG/JPG). Compatible with tesseract.js v4 and v5.
// Supports numeric-only mode (digits + dot + minus).

import sharp from "sharp";
import { createWorker } from "tesseract.js";

/**
 * Extract text from an image.
 * Ensures the parsed number is interpreted with exactly 3 decimal places:
 * - If OCR found a decimal, we round to 3 dp.
 * - If OCR didn't find one, we insert it before the last 3 digits.
 *
 * @param {string} imagePath
 * @param {object} [opts]
 * @param {string} [opts.lang="eng"]
 * @param {number} [opts.psm=7]  // 7 = single line, 6 = block
 * @param {boolean} [opts.numericOnly=true]  Only return digits, dot, minus
 * @param {string} [opts.preprocess="auto"]  "auto" | "gentle" | "hard" | false
 * @returns {Promise<number>} numeric value coerced to 3 decimals
 */
export async function extractText(imagePath, opts = {}) {
  const {
    lang = "eng",
    psm = 7,
    numericOnly = true,
    preprocess = "auto",
  } = opts;

  // Decide preprocessing attempts
  const attempts = [];
  if (preprocess === "auto") attempts.push("gentle", "hard");
  else if (preprocess) attempts.push(preprocess);
  else attempts.push(false);

  // Create a tesseract worker
  const { worker, apiVersion } = await createCompatWorker(lang);

  try {
    // Set recognition parameters
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

    // Try each preprocessing mode
    for (const mode of attempts) {
      const imgPath = await preprocessImage(imagePath, mode);
      const { data: { text } } = await worker.recognize(imgPath);

      const cleaned = postClean(text, numericOnly);
      const score = scoreNumeric(cleaned);

      if (score > best.score) best = { text: cleaned, score };
      if (best.score >= 3) break; // good enough (digits + dot, maybe minus)
    }

    // NEW: coerce to a number with 3 decimal places logic applied
    return toThreeDecimalNumber(best.text.trim());
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/* ---------- Helpers ---------- */

function postClean(text, numericOnly) {
  // Keep digits, dot, and dash-like characters
  let t = text.replace(/[^\d.\-−–—\n\r]/g, "");

  // Normalize Unicode dashes to ASCII hyphen
  t = t.replace(/[−–—]/g, "-");

  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();

  if (!numericOnly) return t;

  // Extract the first signed decimal/integer
  const m = t.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return t;

  // Normalize decimal comma to dot
  return m[0].replace(",", ".");
}

function scoreNumeric(s) {
  if (!s) return -1;
  let score = 0;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) score += 3; // looks like a number
  if (/\./.test(s)) score += 1;
  if (/\d/.test(s)) score += 1;
  if ((s.match(/-/g) || []).length > 1) score -= 1; // too many dashes
  return score;
}

// NEW: enforce "last 3 digits are the decimals" if none present; round to 3 dp otherwise.
function toThreeDecimalNumber(s) {
  if (!s) return NaN;
  let str = s.trim().replace(",", ".");
  let neg = false;
  if (str.startsWith("-")) {
    neg = true;
    str = str.slice(1);
  }

  // accept only digits and optional single dot (postClean already enforced this)
  if (!/^\d+(\.\d+)?$/.test(str)) {
    return NaN; // couldn't parse cleanly
  }

  let out;
  if (str.includes(".")) {
    // Already has a decimal: round to 3 dp
    const n = Number(str);
    if (!Number.isFinite(n)) return NaN;
    out = Math.round(n * 1000) / 1000;
  } else {
    // No decimal present: insert before last 3 digits
    const padded = str.padStart(3, "0");       // ensure at least 3 fractional digits
    const frac = padded.slice(-3);             // last 3 are decimals
    const intPart = padded.slice(0, -3) || "0";
    out = Number(`${neg ? "-" : ""}${intPart}.${frac}`);
  }

  return neg ? -Math.abs(out) : out;
}

async function preprocessImage(inputPath, mode) {
  if (mode === "gentle") {
    const buf = await sharp(inputPath)
      .resize({ width: 2000, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen()
      .toFormat("png")
      .toBuffer();
    const out = inputPath.replace(/(\.\w+)?$/, ".gentle.png");
    await sharp(buf).toFile(out);
    return out;
  }

  if (mode === "hard") {
    const buf = await sharp(inputPath)
      .resize({ width: 2000, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .median(1)
      .threshold(150)  // adjust 130–160 if dots/minus get lost
      .toFormat("png")
      .toBuffer();
    const out = inputPath.replace(/(\.\w+)?$/, ".hard.png");
    await sharp(buf).toFile(out);
    return out;
  }

  return inputPath; // no preprocessing
}

async function createCompatWorker(lang) {
  try {
    const w = await createWorker(); // v4-style
    if (typeof w?.loadLanguage === "function") {
      return { worker: w, apiVersion: "v4" };
    }
    await safeTerminate(w);
  } catch {}
  const w5 = await createWorker(lang, 1); // v5-style
  return { worker: w5, apiVersion: "v5" };
}

async function safeTerminate(w) { try { await w?.terminate?.(); } catch {} }

/* ---------- CLI ---------- */
/*
Usage:
  node ocr-text.js <imagePath> [psm] [lang]

Examples:
  node ocr-text.js number.png
  node ocr-text.js number.png 7 eng
*/
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const img = process.argv[2];
    const psm = Number(process.argv[3] ?? 7);
    const lang = process.argv[4] ?? "eng";
    if (!img) {
      console.error("Usage: node ocr-text.js <imagePath> [psm] [lang]");
      process.exit(1);
    }
    try {
      const value = await extractText(img, { lang, psm, numericOnly: true });
      // Print with exactly 3 decimals for display
      console.log(Number.isFinite(value) ? value.toFixed(3) : "NaN");
    } catch (e) {
      console.error(e?.message || e);
      process.exit(1);
    }
  })();
}
