// helpers/ocr-text.js
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "fs/promises";
import { readCurrent } from "./helpers/utils.js"; // NEW: to pull kernel from config

/**
 * Parse string → number with exactly 3 decimals.
 */
function toThreeDecimalNumber(str) {
  if (!str) return NaN;
  let cleaned = str.replace(/[^\d\-.]/g, "");

  if (cleaned.includes(".")) {
    const num = parseFloat(cleaned);
    return isNaN(num) ? NaN : parseFloat(num.toFixed(3));
  }

  const negative = cleaned.startsWith("-");
  const digits = cleaned.replace("-", "");
  if (!/^\d+$/.test(digits)) return NaN;

  const absVal = parseInt(digits, 10);

  if (absVal >= 10000) {
    const intPart = digits.slice(0, -3);
    const fracPart = digits.slice(-3).padStart(3, "0");
    const composed = `${negative ? "-" : ""}${intPart}.${fracPart}`;
    const num = parseFloat(composed);
    return isNaN(num) ? NaN : parseFloat(num.toFixed(3));
  }

  const normal = negative ? -absVal : absVal;
  return parseFloat(normal.toFixed(3));
}

// ---- helpers ----
function nowStamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    "-" +
    pad(d.getMilliseconds(), 3)
  );
}
// brightness: 1 = no change, >1 brighter, <1 darker
// contrast:   1 = no change, >1 more contrast, <1 less contrast
// gamma:      1 = no change, typical useful range ~0.8–1.4

function applyPreprocess(
  pipeline,
  {
    scale,
    sharpen,
    threshold,
    w,
    h,
    kernel,
    brightness = 1,
    contrast = 1,
    gamma, // optional
  }
) {
  let p = pipeline;

  // 1) Resize first so later ops work on final size
  if (typeof scale === "number" && scale > 0 && scale !== 1) {
    const width = Math.round(w * scale);
    const height = Math.round(h * scale);
    const chosenKernel =
      typeof kernel === "string" && kernel.length ? kernel : "nearest";
    p = p.resize({ width, height, kernel: chosenKernel });
  }

  // 2) Brightness via modulate (multiplicative)
  if (
    typeof brightness === "number" &&
    isFinite(brightness) &&
    brightness !== 1
  ) {
    p = p.modulate({ brightness: Math.max(0, brightness) });
  }

  // 3) Contrast via linear(mult, offset): new = mult*(x - 128) + 128
  if (typeof contrast === "number" && isFinite(contrast) && contrast !== 1) {
    const mult = Math.max(0, contrast);
    const offset = 128 * (1 - mult);
    p = p.linear(mult, offset);
  }

  // 4) Optional gamma correction (can help OCR)
  if (
    typeof gamma === "number" &&
    isFinite(gamma) &&
    gamma > 0 &&
    gamma !== 1
  ) {
    p = p.gamma(gamma);
  }

  // 5) Sharpen before binarization (threshold)
  if (sharpen) p = p.sharpen();

  // 6) Threshold last (0–255)
  if (typeof threshold === "number" && isFinite(threshold)) {
    p = p.threshold(Math.max(0, Math.min(255, Math.round(threshold))));
  }

  // p = p.negate({ alpha: false });

  // Optionally clamp to valid range if you’ve stacked transforms
  // p = p.clamp();

  return p;
}

/**
 * Extract text (digits) from an image buffer or file.
 * Returns a number with exactly 3 decimals.
 */
export async function extractText(
  input,
  {
    numericOnly = true,
    minConf = 60,
    debug = false,
    debugOutBase = "debug-ocr",
    showConfidence = false,
    scale,
    sharpen,
    threshold,
    kernel, // NEW: optional per-call override (e.g., "nearest" | "cubic" | "lanczos2" | "lanczos3" | "mitchell")
  } = {}
) {
  // Normalize input → buffer
  let origBuffer;
  if (Buffer.isBuffer(input)) {
    origBuffer = input;
  } else {
    origBuffer = await fs.readFile(input);
  }

  // Get original dimensions
  const meta = await sharp(origBuffer).metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;

  // Resolve kernel from config via readCurrent('ocr'), unless explicitly provided in options
  let kernelFromConfig;
  try {
    const cfg = await readCurrent?.("ocr");
    if (cfg && typeof cfg.kernel === "string" && cfg.kernel.length) {
      kernelFromConfig = cfg.kernel;
    }
  } catch {
    // ignore config errors; fall back to defaults
  }
  const effectiveKernel = kernel ?? kernelFromConfig ?? "nearest";

  let proc = sharp(origBuffer);

  proc = applyPreprocess(proc, {
    scale,
    sharpen,
    threshold,
    w: srcW,
    h: srcH,
    kernel: effectiveKernel,
    brightness: 1.15, // +15% brighter
    contrast: 1.2, // +20% contrast
    // gamma: 0.9,    // optional: slight gamma lift
  });

  const processedBuffer = await proc.png().toBuffer();

  // Debug saves
  if (debug) {
    const stamp = nowStamp();
    const origPath = `${debugOutBase}-${stamp}-orig.png`;
    const procPath = `${debugOutBase}-${stamp}-proc.png`;
    await sharp(origBuffer).png().toFile(origPath);
    await sharp(processedBuffer).toFile(procPath);
    console.log("Debug images saved:", {
      original: origPath,
      processed: procPath,
    });
  }

  // OCR

// v5+ style: language + OEM passed to createWorker.
// Put init-only params under `initParameters`.
const worker = await createWorker("eng", 1, {
  initParameters: {
    // init-only:
    load_system_dawg: "0",
    load_freq_dawg: "0",

    // layout & hints that are OK at init:
    tessedit_pageseg_mode: "7", // or "13" for raw line
    user_defined_dpi: "300",
  },
  // optional: logger: m => console.log(m),
});

// Runtime params (safe to set after worker creation)
await worker.setParameters({
  tessedit_char_whitelist: "0123456789.-",
  tessedit_char_blacklist: "<>",      // ignore chevrons
  preserve_interword_spaces: "1",
  // classify_bln_numeric_mode often ignored by LSTM; omit or keep harmlessly:
  // classify_bln_numeric_mode: "1",
});

// Run OCR on your processed buffer
const { data } = await worker.recognize(processedBuffer);
  let raw = "";
  const keptSymbols = [];
  const allSymbols = [];

  if (Array.isArray(data.symbols)) {
    for (const s of data.symbols) {
      const ch = s.text ?? "";
      const conf = Number(s.confidence ?? 0);
      allSymbols.push({ ch, conf });
      if (conf >= minConf) {
        if (!numericOnly || /[0-9.\-]/.test(ch)) {
          raw += ch;
          keptSymbols.push({ ch, conf });
        }
      }
    }
  } else if (Array.isArray(data.words)) {
    for (const w of data.words) {
      const conf = Number(w.confidence ?? 0);
      const txt = String(w.text ?? "");
      for (const ch of txt) {
        allSymbols.push({ ch, conf });
        if (conf >= minConf) {
          if (!numericOnly || /[0-9.\-]/.test(ch)) {
            raw += ch;
            keptSymbols.push({ ch, conf });
          }
        }
      }
    }
  } else {
    raw = numericOnly
      ? (data.text ?? "").replace(/[^0-9.\-]/g, "")
      : data.text ?? "";
  }

  // Confidence reporting
  if (showConfidence) {
    const avg = (arr) =>
      arr.length ? arr.reduce((a, b) => a + b.conf, 0) / arr.length : 0;
    console.log("— OCR Confidence —");
    console.log(
      `All symbols: ${allSymbols.length}, avg=${avg(allSymbols).toFixed(1)}`
    );
    console.log(
      `Kept symbols: ${keptSymbols.length}, avg=${avg(keptSymbols).toFixed(1)}`
    );
    console.log(
      "Kept (char:conf):",
      keptSymbols.map((s) => `${s.ch}:${Math.round(s.conf)}`).join(" ")
    );
  }

  await worker.terminate();

  console.log("RAW: " + raw);
  
  return toThreeDecimalNumber(raw);
}
