// utils.js
import { captureRegion } from "../capture-window.js";
import { extractText } from "../ocr-text.js";

// ----- Utils -----
export async function readCurrent(region, axis) {
  const { buffer } = await captureRegion({ screenIndex: 1, region });
  const txt = await extractText(buffer, { numericOnly: true, psm: 7 });
  const n = Number(txt);
  if (Number.isNaN(n)) throw new Error(`OCR failed on ${axis}: "${txt}"`);
  return n;
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