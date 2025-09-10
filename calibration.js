// calibration.js (ESM)

import { tapName, keyDownName, keyUpName } from "./helpers/keys.js";
import { readCurrent } from "./helpers/utils.js";
import { sleep } from "./helpers/sleep.js";
import { saveCalibration } from "./helpers/calibrationIO.js";
import { runMoveFlow } from "./helpers/runMoveFlow.js";
import { createInterface } from "readline/promises";
import { moveTo } from "./helpers/moveTo.js";
import { loadCalibration } from "./helpers/calibrationIO.js";

// ==== Config ====

// --- Calibration tolerances ---
const CAL_TOL_PCT = 0.0005;
const CAL_ABS_TOL = 0.000025;

// --- Move tolerances (configurable) ---
const MOVE_TOL_REL = 0.0;
const MOVE_TOL_ABS = 0.0;

const MOVE_ABS_TOL = 0.0005;
const MOVE_REL_TOL = 0.0;

// Limits
const START_DELAY_MS = 8000;
const MAX_STEPS = 400;
const SMALLEST_MAX_TRIES = 150;

// --- Calibration targets ---
const calibrationTargets = [0.001, 0.01, 0.1, 1, 3, 6, 10, 20, 40, 60, 100];

// --- Other calibration config ---
const MAX_SUB_ITERS = 12;
const MIN_MS = 1;
const MAX_MS = 5000;

// Hold thresholds
const HOLD_SQUARE_BELOW = 0.1;
const HOLD_TRIANGLE_ABOVE = 0.999;
const HOLD_LEAD_MS = 30;
const HOLD_TAIL_MS = 10;

// OCR region for X field (adjust if needed)
const X_REGION = { left: 760, top: 168, width: 140, height: 35 };
const Y_REGION = { left: 760, top: 204, width: 140, height: 35 };
const Z_REGION = { left: 760, top: 244, width: 140, height: 35 };

const XROT_REGION = { left: 708, top: 168, width: 140, height: 35 };
const YROT_REGION = { left: 708, top: 204, width: 140, height: 35 };
const ZROT_REGION = { left: 708, top: 242, width: 140, height: 35 };

// ---- Result stores ----
let currentResults = [];
const bestResultsPosition = [];
const bestResultsRotation = [];

// ==== Helpers (shared) ====
function effectiveTolerance(target) {
  const relTol = Math.abs(target) * CAL_TOL_PCT;
  const eff = Math.max(CAL_ABS_TOL, relTol);
  const mode = eff === CAL_ABS_TOL ? "ABS" : "REL";
  return { eff, mode, relTol, absTol: CAL_ABS_TOL };
}

function chooseHoldKey(target) {
  if (target > HOLD_TRIANGLE_ABOVE) return "TRIANGLE";
  if (target < HOLD_SQUARE_BELOW) return "SQUARE";
  return null;
}

function pushAndRenderLive(row, target, tolInfo) {
  currentResults.push(row);
  console.clear();
  console.log(
    `Calibrating target: ${target}    ` +
      `(tol=${tolInfo.eff} ${tolInfo.mode}; rel=${tolInfo.relTol}, abs=${tolInfo.absTol})\n` +
      `Hold rule: target<${HOLD_SQUARE_BELOW} -> SQUARE, ${HOLD_SQUARE_BELOW}..${HOLD_TRIANGLE_ABOVE} -> none, target>${HOLD_TRIANGLE_ABOVE} -> TRIANGLE\n` +
      `Press Q/Ctrl-C to abort\n`
  );
  console.table(currentResults);
}

// ==== Position (unchanged logic) ====
async function measureOnce(ms, target) {
  const holdKey = chooseHoldKey(target);
  const xOriginalPos = await readCurrent(X_REGION, "x");

  if (holdKey) {
    await keyDownName(holdKey);
    if (HOLD_LEAD_MS > 0) await sleep(HOLD_LEAD_MS);
    try {
      await tapName("DPAD_RIGHT", ms);
    } finally {
      if (HOLD_TAIL_MS > 0) await sleep(HOLD_TAIL_MS);
      await keyUpName(holdKey);
    }
  } else {
    await tapName("DPAD_RIGHT", ms);
  }

  const xNewPosition = await readCurrent(X_REGION, "x");
  const diff = xNewPosition - xOriginalPos;
  return { xOriginalPos, xNewPosition, diff, held: holdKey ?? "-" };
}

async function tuneForTarget(target) {
  currentResults = []; // reset for this target
  const tolInfo = effectiveTolerance(target);

  let low = MIN_MS;
  let high = MAX_MS;
  let ms = Math.round((low + high) / 2);
  let best = null;

  for (let i = 0; i < MAX_SUB_ITERS; i++) {
    const { xOriginalPos, xNewPosition, diff, held } = await measureOnce(
      ms,
      target
    );
    const err = Math.abs(diff - target);
    const ok = err <= tolInfo.eff;

    const row = {
      Target: target,
      Iter: i + 1,
      ms,
      xOrig: Number(xOriginalPos.toFixed(6)),
      xNew: Number(xNewPosition.toFixed(6)),
      Diff: Number(diff.toFixed(6)),
      Error: Number(err.toFixed(6)),
      HeldKey: held,
    };

    pushAndRenderLive(row, target, tolInfo);

    if (!best || err < best.err) {
      best = {
        ms,
        xOriginalPos,
        xNewPosition,
        diff,
        err,
        iter: i + 1,
        target,
        tolInfo,
        held,
      };
    }

    if (ok) break;

    if (diff > target) high = ms;
    else low = ms;

    const next = Math.round((low + high) / 2);
    if (next === ms) break;
    ms = next;
  }

  bestResultsPosition.push({
    Target: best.target,
    ms: best.ms,
    Iterations: best.iter,
    xOrig: Number(best.xOriginalPos.toFixed(6)),
    xNew: Number(best.xNewPosition.toFixed(6)),
    Diff: Number(best.diff.toFixed(6)),
    Error: Number(best.err.toFixed(6)),
    TolEff: best.tolInfo.eff,
    TolMode: best.tolInfo.mode,
    HeldKey: best.held,
  });
}

// ==== Rotation (wrapped 0..360 logic) ====

// Map signed target in [-180, 180] to [0, 360)
function to360(signedDeg) {
  let t = signedDeg % 360;
  if (t < 0) t += 360;
  return t;
}

// Compute forward (positive) angular delta from a to b in [0,360)
function forwardDelta360(a, b) {
  let d = (b - a) % 360;
  if (d < 0) d += 360;
  return d;
}

async function measureOnceRotation(ms, target360) {
  const holdKey = chooseHoldKey(target360);
  const rotOrig = await readCurrent(XROT_REGION, "rot"); // new region + "rot"

  if (holdKey) {
    await keyDownName(holdKey);
    if (HOLD_LEAD_MS > 0) await sleep(HOLD_LEAD_MS);
    try {
      await tapName("DPAD_RIGHT", ms);
    } finally {
      if (HOLD_TAIL_MS > 0) await sleep(HOLD_TAIL_MS);
      await keyUpName(holdKey);
    }
  } else {
    await tapName("DPAD_RIGHT", ms);
  }

  const rotNew = await readCurrent(XROT_REGION, "rot"); // new region + "rot"
  const diff = forwardDelta360(rotOrig, rotNew);
  return { rotOrig, rotNew, diff, held: holdKey ?? "-" };
}

async function tuneForTargetRotation(targetSigned) {
  const target360 = to360(targetSigned);

  currentResults = [];
  const tolInfo = effectiveTolerance(target360);

  let low = MIN_MS;
  let high = MAX_MS;
  let ms = Math.round((low + high) / 2);
  let best = null;

  for (let i = 0; i < MAX_SUB_ITERS; i++) {
    const { rotOrig, rotNew, diff, held } = await measureOnceRotation(
      ms,
      target360
    );
    const err = Math.abs(diff - target360);
    const ok = err <= tolInfo.eff;

    const row = {
      TargetSigned: Number(targetSigned.toFixed(6)),
      Target360: Number(target360.toFixed(6)),
      Iter: i + 1,
      ms,
      rotOrig: Number(rotOrig.toFixed(6)),
      rotNew: Number(rotNew.toFixed(6)),
      Diff: Number(diff.toFixed(6)),
      Error: Number(err.toFixed(6)),
      HeldKey: held,
    };

    pushAndRenderLive(row, target360, tolInfo);

    if (!best || err < best.err) {
      best = {
        ms,
        rotOrig,
        rotNew,
        diff,
        err,
        iter: i + 1,
        target360,
        held,
        tolInfo,
      };
    }

    if (ok) break;

    if (diff > target360) high = ms;
    else low = ms;

    const next = Math.round((low + high) / 2);
    if (next === ms) break;
    ms = next;
  }

  const signedTarget =
    best.target360 > 180 ? best.target360 - 360 : best.target360;

  // Write exactly the same internal keys as position uses
  bestResultsRotation.push({
    Target: Number(targetSigned.toFixed(6)), // step size you asked to calibrate
    ms: best.ms,
    HeldKey: best.held,
  });
}

// ==== Modes ====
async function runCalibrationPosition() {
  console.log("Starting position calibration in 5 seconds...");
  await sleep(5000);

  for (const target of calibrationTargets) {
    await tuneForTarget(target);
  }

  console.clear();
  console.log("Calibration Complete (Position).\n\nBest Per Target:");
  console.table(bestResultsPosition);

  await saveCalibration(bestResultsPosition, {
    filename: "positionCal.json",
    timestamp: false,
  });
}

async function runCalibrationRotation() {
  console.log("Starting rotation calibration in 5 seconds...");
  await sleep(5000);

  for (const targetSigned of calibrationTargets) {
    await tuneForTargetRotation(targetSigned);
  }

  console.clear();
  console.log("Calibration Complete (Rotation).\n\nBest Per Target:");
  console.table(bestResultsRotation);

  await saveCalibration(bestResultsRotation, {
    filename: "rotationCal.json",
    timestamp: false,
  });
}

// ==== Entry ====
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(
      "Select mode:\n  1) Calibrate Position\n  2) Calibrate Rotation\n  3) Move object to target\n  4) Rotate object to target"
    );
    const choice = await rl.question("Selection: ");

    if (choice.trim() === "1") {
      await runCalibrationPosition();
    } else if (choice.trim() === "2") {
      await runCalibrationRotation();
    } else if (choice.trim() === "3") {
      await runMoveFlow({
        calibrationFile: "calPosition.json",
        tolerances: { relPct: MOVE_TOL_REL, absTol: MOVE_TOL_ABS },
        maxSteps: 400,
        smallestMaxTries: 100,
        lead: 30,
        tail: 10,
        live: true,
      });
    } else if (choice.trim() === "4") {
      const ans = await rl.question(
        `Enter target rotation value (NOTE: Must be between -180 to 180): `
      );

      const target = to360(ans);

      console.log(
        `\nMoving rotation in 3 seconds… (Real: ${ans} Degrees: ${target})`
      );
      await sleep(3000);

      const calibration = await loadCalibration("rotationCal.json");
      const targetName = "xRot";

      const result = await moveTo({
        target: target,
        calibration,
        axisLabel: targetName,
        dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
        tolerances: { relPct: MOVE_REL_TOL, absTol: MOVE_ABS_TOL },
        maxSteps: MAX_STEPS,
        smallestMaxTries: SMALLEST_MAX_TRIES,
        ui: { live: true },
        lead: 30,
        tail: 10,
        region: XROT_REGION,
      });

   
    } else if (choice.trim().toUpperCase() === "Q") {
      process.exit();
    } else {
      console.log("Invalid choice.");
    }

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
