// calibration.js (ESM)

import { tapName, keyDownName, keyUpName } from "./helpers/keys.js";
import { readCurrent } from "./helpers/utils.js";
import { sleep } from "./helpers/sleep.js";
import { saveCalibration } from "./helpers/calibrationIO.js";
import { runMoveFlow } from "./helpers/runMoveFlow.js";
import { createInterface } from "readline/promises";

// ==== Config ====

// --- Calibration tolerances ---
const CAL_TOL_PCT = 0.0005;
const CAL_ABS_TOL = 0.000025;

// --- Move tolerances (configurable) ---
const MOVE_TOL_REL =  0.0;       // e.g. 0.005 = 0.5%
const MOVE_TOL_ABS = 0.0;        // absolute tolerance to stop at

// --- Calibration targets ---
const calibrationTargets = [0.001, 0.01, 0.1, 1.0, 10.0, 100];

// --- Other calibration config ---
const MAX_SUB_ITERS = 12;
const MIN_MS = 1;
const MAX_MS = 5000;

// Hold thresholds
const HOLD_SQUARE_BELOW = 0.1;
const HOLD_TRIANGLE_ABOVE = 10;
const HOLD_LEAD_MS = 30;
const HOLD_TAIL_MS = 10;

// Shared region
const xRegion = { left: 760, top: 168, width: 140, height: 35 };

// ---- Result stores ----
let currentResults = [];
const bestResults = [];

// ==== Calibration helpers ====
function effectiveTolerance(target) {
  const relTol = Math.abs(target) * CAL_TOL_PCT;
  const eff = Math.max(CAL_ABS_TOL, relTol);
  const mode = eff === CAL_ABS_TOL ? "ABS" : "REL";
  return { eff, mode, relTol, absTol: CAL_ABS_TOL };
}

function withinTolerance(diff, target) {
  const { eff } = effectiveTolerance(target);
  const err = Math.abs(diff - target);
  return err <= eff;
}

function chooseHoldKey(target) {
  if (target > HOLD_TRIANGLE_ABOVE) return "TRIANGLE";
  if (target < HOLD_SQUARE_BELOW) return "SQUARE";
  return null;
}

async function measureOnce(ms, target) {
  const holdKey = chooseHoldKey(target);
  const xOriginalPos = await readCurrent(xRegion, "x");

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

  const xNewPosition = await readCurrent(xRegion, "x");
  const diff = xNewPosition - xOriginalPos;
  return { xOriginalPos, xNewPosition, diff, held: holdKey ?? "-" };
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

async function tuneForTarget(target) {
  currentResults = []; // reset for this target
  const tolInfo = effectiveTolerance(target);

  let low = MIN_MS;
  let high = MAX_MS;
  let ms = Math.round((low + high) / 2);
  let best = null;

  for (let i = 0; i < MAX_SUB_ITERS; i++) {
    const { xOriginalPos, xNewPosition, diff, held } = await measureOnce(ms, target);
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
      best = { ms, xOriginalPos, xNewPosition, diff, err, iter: i + 1, target, tolInfo, held };
    }

    if (ok) break;

    if (diff > target) high = ms;
    else low = ms;

    const next = Math.round((low + high) / 2);
    if (next === ms) break;
    ms = next;
  }

  bestResults.push({
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

// ==== Modes ====
async function runCalibration() {
  console.log("Starting calibration in 5 seconds...");
  await sleep(5000);

  for (const target of calibrationTargets) {
    await tuneForTarget(target);
  }

  console.clear();
  console.log("Calibration Complete.\n\nBest Per Target:");
  console.table(bestResults);

  await saveCalibration(bestResults, { filename: "calibration.json", timestamp: false });
}

// ==== Entry ====
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("Select mode:\n  1) Calibration\n  2) Move object to target");
    const choice = await rl.question("Enter 1 or 2: ");

    if (choice.trim() === "1") {
      await runCalibration();
    } else if (choice.trim() === "2") {
      // Delegate to shared runMoveFlow so you can reuse from anywhere
      await runMoveFlow({
        calibrationFile: "calibration.json",
        tolerances: { relPct: MOVE_TOL_REL, absTol: MOVE_TOL_ABS },
        maxSteps: 400,
        smallestMaxTries: 100,
        lead: 30,
        tail: 10,
        live: true,
      });
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
