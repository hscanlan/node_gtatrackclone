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
