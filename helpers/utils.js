// utils.js
import { captureRegion } from "../capture-window.js";
import { extractText } from "../ocr-text.js";

// ----- Utils -----
/**
 * Read the current value from a screen region and return a number.
 * Defaults:
 *  - screenIndex: 1 (your original behavior)
 *  - numericOnly: true
 *  - minConf: 60
 * You can override via the optional third param (opts) without breaking old calls.
 */
export async function readCurrent(region, axis, opts = {}) {
  const { buffer } = await captureRegion({
    screenIndex: opts.screenIndex ?? 1, // keep your original default
    region
  });

  // Use the new OCR helper; still numeric-only by default
  const val = await extractText(buffer, {
    numericOnly: true,
    minConf: opts.minConf ?? 60,
    debug: !!opts.debug,                     // optional: save orig/proc images with timestamp
    debugOutBase: opts.debugOutBase ?? `ocr-${axis}`,
    showConfidence: !!opts.showConfidence,   // optional: log per-char confidence
    // Optional preprocessing knobs (only used if you pass them):
    scale: opts.scale,
    sharpen: opts.sharpen,
    threshold: opts.threshold
  });

  if (!Number.isFinite(val)) {
    throw new Error(`OCR failed on ${axis}: "${val}"`);
  }
  return val;
}

// Map signed target in [-180, 180] to [0, 360]
export function to360From180(signedDeg) {
  if (signedDeg < -180 || signedDeg > 180) {
    throw new RangeError("Input must be between -180 and 180");
  }

  if (signedDeg < 0) {
    return 360 + signedDeg; // shift negative values around the circle
  }

  return signedDeg; // 0 and positives stay as-is
}
