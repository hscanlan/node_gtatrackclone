// calibration.js (ESM)

import { tapName, keyDownName, keyUpName } from "./helpers/keys.js";
import { readCurrent } from "./helpers/utils.js";
import { sleep } from "./helpers/sleep.js";
import { saveCalibration, loadCalibration } from "./helpers/calibrationIO.js";
import { createInterface } from "readline/promises";
import { moveTo } from "./helpers/moveTo.js";
import {
  moveToTest,
  moveWholeOnly,
  moveDecimalsOnly,
} from "./helpers/moveToTest.js";

import { moveTo as moveToSimple } from "./helpers/moveToSimple.js";
import { read } from "fs";

// ==== Config ====

// --- Calibration tolerances ---
const CAL_TOL_PCT = 0.0005;
const CAL_ABS_TOL = 0.000025;

// --- Move tolerances (configurable) ---
const MOVE_TOL_REL = 0.0;
const MOVE_TOL_ABS = 0.0;

const MOVE_ABS_TOL = 0.0;
const MOVE_REL_TOL = 0.0;

// Limits
const START_DELAY_MS = 8000;
const MAX_STEPS = 2000;
const SMALLEST_MAX_TRIES = 50;

// --- Calibration targets ---
const calibrationTargets = [2,3,5,6,7];

// --- Other calibration config ---
const MAX_SUB_ITERS = 30;
const MIN_MS = 0;
const MAX_MS = 1000;

// Hold thresholds
const HOLD_SQUARE_BELOW = 0.3;
const HOLD_TRIANGLE_ABOVE = 2.9;

const HOLD_LEAD_MS = 0;
const HOLD_TAIL_MS = 0;

// OCR regions
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
  currentResults = [];
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
function to360(signedDeg) {
  let t = signedDeg % 360;
  if (t < 0) t += 360;
  return t;
}
function forwardDelta360(a, b) {
  let d = (b - a) % 360;
  if (d < 0) d += 360;
  return d;
}

async function measureOnceRotation(ms, target360) {
  const holdKey = chooseHoldKey(target360);
  const rotOrig = await readCurrent(XROT_REGION, "rot");

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

  const rotNew = await readCurrent(XROT_REGION, "rot");
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

  bestResultsRotation.push({
    Target: Number(targetSigned.toFixed(6)),
    ms: best.ms,
    HeldKey: best.held,
  });
}

// ==== NEW: Sweep calibration over ms range (position) ====
// Tries ms = start..end stepping by stepMs; measures delta each time; saves as {target, ms, heldKey}
async function runCalibrationSweepPosition(startMs, endMs, stepMs) {
  const SWEEP_TARGET_FOR_HOLD = 0.5; // middle range => no hold key by rule
  const s = Math.max(MIN_MS, Math.min(MAX_MS, Math.floor(startMs)));
  const e = Math.max(MIN_MS, Math.min(MAX_MS, Math.floor(endMs)));
  const d = Math.max(1, Math.floor(stepMs));

  const [lo, hi] = s <= e ? [s, e] : [e, s];

  console.log(
    `Starting ms sweep in 5 seconds... (range: ${lo}..${hi} step ${d})`
  );
  await sleep(5000);

  const rows = [];
  let i = 0;
  for (let ms = lo; ms <= hi; ms += d) {
    const { xOriginalPos, xNewPosition, diff } = await measureOnce(
      ms,
      SWEEP_TARGET_FOR_HOLD
    );
    rows.push({
      target: Number(diff.toFixed(6)),
      ms,
      heldKey: "-", // we intentionally avoid holds in the sweep
      xOrig: Number(xOriginalPos.toFixed(6)),
      xNew: Number(xNewPosition.toFixed(6)),
      i: ++i,
    });
    console.clear();
    console.log(`Sweep progress: ms=${ms} (${i} samples)`);
    console.table(rows.map(({ i, ms, target }) => ({ i, ms, step: target })));
  }

  // Save ONLY the schema movers consume
  const compact = rows.map(({ target, ms, heldKey }) => ({
    target,
    ms,
    heldKey,
  }));
  await saveCalibration(compact, {
    filename: "positionCal.json",
    timestamp: false,
  });

  console.log(
    "\nSweep calibration complete. Saved positionCal.json with entries like:"
  );
  console.table(compact.slice(0, Math.min(10, compact.length)));
  console.log(`Total entries: ${compact.length}`);
}

// ==== Modes ====
// Calibration (position)
async function runCalibrationPosition() {
  console.log("Starting position calibration in 5 seconds...");
  await sleep(5000);
  for (const target of calibrationTargets) await tuneForTarget(target);
  console.clear();
  console.log("Calibration Complete (Position).\n\nBest Per Target:");
  console.table(bestResultsPosition);
  await saveCalibration(bestResultsPosition, {
    filename: "positionCal.json",
    timestamp: false,
  });
}

// Calibration (rotation)
async function runCalibrationRotation() {
  console.log("Starting rotation calibration in 5 seconds...");
  await sleep(5000);
  for (const targetSigned of calibrationTargets)
    await tuneForTargetRotation(targetSigned);
  console.clear();
  console.log("Calibration Complete (Rotation).\n\nBest Per Target:");
  console.table(bestResultsRotation);
  await saveCalibration(bestResultsRotation, {
    filename: "rotationCal.json",
    timestamp: false,
  });
}

// Regular move using moveTo (position)
async function runMovePosition(targetNum) {
  console.log(`\nMoving position in 3 seconds… (Target: ${targetNum})`);
  await sleep(3000);

  const calibration = await loadCalibration("positionCal.json");

  const targetName = "x";

  await moveTo({
    target: targetNum,
    calibration,
    axisLabel: targetName,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    tolerances: { relPct: MOVE_REL_TOL, absTol: MOVE_ABS_TOL },
    maxSteps: MAX_STEPS,
    smallestMaxTries: SMALLEST_MAX_TRIES,
    ui: { live: true },
    lead: HOLD_LEAD_MS,
    tail: HOLD_TAIL_MS,
    region: X_REGION,
  });
}

// Regular rotate using moveTo (rotation)
async function runMoveRotation(targetSigned) {
  const target360 = to360(Number(targetSigned));
  console.log(
    `\nMoving rotation in 3 seconds… (Input: ${targetSigned}, 0-360: ${target360})`
  );
  await sleep(3000);

  const calibration = await loadCalibration("rotationCal.json");
  const targetName = "xRot";

  await moveTo({
    target: target360,
    calibration,
    axisLabel: targetName,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    tolerances: { relPct: MOVE_REL_TOL, absTol: MOVE_ABS_TOL },
    maxSteps: MAX_STEPS,
    smallestMaxTries: SMALLEST_MAX_TRIES,
    ui: { live: true },
    lead: HOLD_LEAD_MS,
    tail: HOLD_TAIL_MS,
    region: XROT_REGION,
  });
}

// Two-phase test (whole → decimals)
async function runTwoPhaseMovePosition(targetNum) {
  console.log(`\nTwo-phase move starts in 3 seconds… (Target: ${targetNum})`);
  await sleep(3000);

  const calibration = await loadCalibration("positionCal.json");

  const result = await moveToTest({
    target: targetNum,
    calibration,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    region: X_REGION,
    absTol: CAL_ABS_TOL,
    lead: HOLD_LEAD_MS,
    tail: HOLD_TAIL_MS,
  });
  console.log("\nTwo-phase move result:", {
    ok: result.ok,
    target: result.target,
    afterPhase1: Number(result.afterPhase1.toFixed(6)),
    final: Number(result.final.toFixed(6)),
    err: Number((result.target - result.final).toFixed(6)),
  });
}

// Whole-only test (>=1 steps)
async function runWholeOnlyPosition(targetNum) {
  console.log(`\nWhole-only move in 3 seconds… (Target: ${targetNum})`);
  await sleep(3000);

  const calibration = await loadCalibration("positionCal.json");

  const result = await moveWholeOnly({
    target: targetNum,
    calibration,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    region: X_REGION,
    lead: HOLD_LEAD_MS,
    tail: HOLD_TAIL_MS,
  });

  console.log("\nWhole-only result:", {
    afterPhase1: Number(result.afterPhase1.toFixed(6)),
    targetInt: result.targetInt,
    reachedInt: result.reachedInt,
  });
}

async function runMovePositionNew(target) {
  console.log(`\nMoving position in 3 seconds… (Target: ${target})`);
  await sleep(3000);

  const calibration = await loadCalibration("positionCal.json");

  console.log(X_REGION);
  await moveToSimple(target, calibration, X_REGION);
}

async function moveSimple(ms) {
  for (var i = 0; i < 4; i++) {
    console.log(i + ": ====== ");
    const startVal = await readCurrent(X_REGION);
    await tapName("DPAD_RIGHT", 1);
    await tapName("DPAD_RIGHT", ms);
    const endVal = await readCurrent(X_REGION);

    console.table({
      startVal: Number(startVal.toFixed(6)),
      endValue: Number(endVal.toFixed(6)),
      differen: Number((startVal - endVal).toFixed(6)),
    });
  }
}

// Decimals-only test (<1 steps)
async function runDecimalsOnlyPosition(targetNum) {
  console.log(`\nDecimals-only move in 3 seconds… (Target: ${targetNum})`);
  await sleep(3000);

  const calibration = await loadCalibration("positionCal.json");

  const result = await moveDecimalsOnly({
    target: targetNum,
    calibration,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    region: X_REGION,
    absTol: CAL_ABS_TOL,
    lead: HOLD_LEAD_MS,
    tail: HOLD_TAIL_MS,
  });

  console.log("\nDecimals-only result:", {
    final: Number(result.final.toFixed(6)),
    err: Number((targetNum - result.final).toFixed(6)),
    ok: result.ok,
  });
}

// ==== Entry (single readline instance) ====
async function main() {
  // make sure we're NOT in raw mode
  process.stdin.setRawMode?.(false);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    console.log(
      "Select mode:\n" +
        "  1) Calibrate Position\n" +
        "  2) Calibrate Rotation\n" +
        "  3) Move object to target (position)\n" +
        "  4) Rotate object to target\n" +
        "  5) Move (two-phase test: whole→decimals)\n" +
        "  6) Move (WHOLE ONLY)\n" +
        "  7) Move (DECIMALS ONLY)\n" +
        "  8) Calibrate (sweep ms range → position)\n" +
        "  9) Move for x miliseconds\n" +
        "  Q) Quit"
    );

    const choice = (await rl.question("Selection: ")).trim();

    if (choice === "1") {
      await runCalibrationPosition();
    } else if (choice === "2") {
      await runCalibrationRotation();
    } else if (choice === "3") {
      const ans = await rl.question(
        `Enter target position value (e.g., -1235.324): `
      );
      const targetNum = Number.parseFloat(ans);
      if (!Number.isFinite(targetNum)) {
        console.log("Invalid number.");
      } else {
        await runMovePositionNew(targetNum);
      }
    } else if (choice === "4") {
      const ans = await rl.question(
        `Enter target rotation value (signed, -180..180): `
      );
      const targetSigned = Number.parseFloat(ans);
      if (!Number.isFinite(targetSigned)) {
        console.log("Invalid number.");
      } else {
        await runMoveRotation(targetSigned);
      }
    } else if (choice === "5") {
      const ans = await rl.question(
        `Enter target position value (e.g., -1235.324): `
      );
      const targetNum = Number.parseFloat(ans);
      if (!Number.isFinite(targetNum)) {
        console.log("Invalid number.");
      } else {
        await runTwoPhaseMovePosition(targetNum);
      }
    } else if (choice === "6") {
      const ans = await rl.question(
        `Enter target position value (e.g., -1235.324): `
      );
      const targetNum = Number.parseFloat(ans);
      if (!Number.isFinite(targetNum)) {
        console.log("Invalid number.");
      } else {
        await runWholeOnlyPosition(targetNum);
      }
    } else if (choice === "7") {
      const ans = await rl.question(
        `Enter target position value (e.g., -1235.324): `
      );
      const targetNum = Number.parseFloat(ans);
      if (!Number.isFinite(targetNum)) {
        console.log("Invalid number.");
      } else {
        await runDecimalsOnlyPosition(targetNum);
      }
    } else if (choice === "8") {
      const s = Number.parseInt(await rl.question("Start ms (e.g., 10): "));
      const e = Number.parseInt(await rl.question("End ms (e.g., 400): "));
      const d = Number.parseInt(await rl.question("Step ms (e.g., 10): "));
      if ([s, e, d].some((n) => !Number.isFinite(n))) {
        console.log("Invalid numbers.");
      } else {
        await runCalibrationSweepPosition(s, e, d);
      }
    } else if (choice === "9") {
      do {
        var s = Number.parseInt(await rl.question("Move for X ms: "));
        if ([s].some((n) => !Number.isFinite(n))) {
          console.log("Invalid numbers.");
        } else {
          await sleep(2000);
          await moveSimple(s);
        }
      } while (true);
    } else if (choice.toUpperCase() === "Q") {
      // fallthrough to finally
    } else {
      console.log("Invalid choice.");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    rl.close();
    process.exit(0);
  }
}

main();
