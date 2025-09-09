import fs from "fs/promises";

/**
 * Save calibration results to JSON file.
 * @param {Array} results - array of bestResults
 * @param {Object} [options]
 * @param {string} [options.filename="calibration.json"] - base filename
 * @param {boolean} [options.timestamp=false] - add timestamp to filename
 */
export async function saveCalibration(results, options = {}) {
  const { filename = "calibration.json", timestamp = false } = options;

  const data = results.map(r => ({
    target: r.Target,
    ms: r.ms,
    heldKey: r.HeldKey
  }));

  let outFile = filename;
  if (timestamp) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const [base, ext] = filename.split(/\.(?=[^\.]+$)/); // split at last dot
    outFile = `${base}-${ts}.${ext}`;
  }

  await fs.writeFile(outFile, JSON.stringify(data, null, 2), "utf-8");
  console.log(`\nCalibration data saved to ${outFile}`);
  return outFile;
}

/**
 * Load calibration data from JSON file.
 * @param {string} [filename="calibration.json"]
 * @returns {Promise<Array>} parsed calibration entries
 */
export async function loadCalibration(filename = "calibration.json") {
  try {
    const raw = await fs.readFile(filename, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("Calibration file format invalid: expected array");
    }

    console.log(`\nCalibration data loaded from ${filename}`);
    return data;
  } catch (err) {
    console.error(`Failed to load calibration file: ${filename}`);
    throw err;
  }
}
