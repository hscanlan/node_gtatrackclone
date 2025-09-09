// helpers/runMoveFlow.js (ESM)

import { loadCalibration } from "./calibrationIO.js";
import { moveTo } from "./moveTo.js";
import { readCurrent } from "./utils.js";
import { sleep } from "./sleep.js";
import { createInterface } from "readline/promises";

/**
 * Interactive flow to move ANY axis to a target. You can pass:
 * - axisLabel: "x" | "y" | "yaw" (for logs)
 * - region: capture region for readCurrent()
 * - dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" } (change per axis)
 * - or override readFn entirely if you use a different reader.
 */
export async function runMoveFlow({
  axisLabel = "x",
  region = { left: 760, top: 168, width: 140, height: 35 },
  readFn, // optional override: async () => number
  dirKeys = { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
  calibrationFile = "calibration.json",
  tolerances = { relPct: 0.0, absTol: 0.001 },
  maxSteps = 400,
  smallestMaxTries = 100,
  lead = 30,
  tail = 10,
  live = true,
} = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const calibration = await loadCalibration(calibrationFile);

    const ans = await rl.question(`Enter target ${axisLabel} value (e.g., -2242.999): `);
    const target = Number(ans);
    if (!Number.isFinite(target)) throw new Error("Invalid number.");

    console.log(
      `\nMoving ${axisLabel} in 3 seconds… (Tolerance: rel=${tolerances.relPct}, abs=${tolerances.absTol})`
    );
    await sleep(3000);

    const result = await moveTo({
      target,
      calibration,
      axisLabel,
      dirKeys,
      readFn: readFn ?? (async () => readCurrent(region, axisLabel)),
      tolerances,
      maxSteps,
      smallestMaxTries,
      ui: { live },
      lead,
      tail,
      defaultRegion: region,
    });

    console.log("\nMove result:");
    console.table(result.rows);
    console.log(`\nAxis: ${axisLabel}  Target: ${target}  Final: ${result.final}, Error: ${result.error}`);
    return result;
  } finally {
    rl.close();
  }
}

/**
 * Non-interactive convenience: pass target directly.
 */
export async function moveOnce({
  target,
  axisLabel = "x",
  region = { left: 760, top: 168, width: 140, height: 35 },
  readFn,
  dirKeys = { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
  calibrationFile = "calibration.json",
  tolerances = { relPct: 0.0, absTol: 0.001 },
  maxSteps = 400,
  smallestMaxTries = 100,
  lead = 30,
  tail = 10,
  live = true,
} = {}) {
  const calibration = await loadCalibration(calibrationFile);

  const result = await moveTo({
    target,
    calibration,
    axisLabel,
    dirKeys,
    readFn: readFn ?? (async () => readCurrent(region, axisLabel)),
    tolerances,
    maxSteps,
    smallestMaxTries,
    ui: { live },
    lead,
    tail,
    defaultRegion: region,
  });

  return result;
}
