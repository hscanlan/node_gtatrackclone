// cloneJob.js — X-only with menu movements (enter -> move X -> exit)
// Adds CLI range selection: --start <n> --end <n>

import fs from "fs/promises";
import { tapName, repeat } from "./helpers/keys.js";
import { sleep } from "./helpers/sleep.js";
import parseTrackData from "./trackParser.js";
import MenuScript from "./classes/MenuScript.js";
import { to360From180 } from "./helpers/utils.js";
import { loadCalibration } from "./helpers/calibrationIO.js";
import { moveTo } from "./helpers/moveTo.js";
import { moveToTest } from "./helpers/moveToTest.js";

// ===== Config =====

// load calibration
const positionCal = await loadCalibration("positionCal.json");
const rotationCal = await loadCalibration("rotationCal.json");

// OCR regions (leave as-is unless you need to tweak)
const X_REGION = { left: 760, top: 168, width: 140, height: 35 };
const Y_REGION = { left: 760, top: 204, width: 140, height: 35 };
const Z_REGION = { left: 760, top: 244, width: 140, height: 35 };

const XROT_REGION = { left: 708, top: 168, width: 140, height: 35 };
const YROT_REGION = { left: 708, top: 204, width: 140, height: 35 };
const ZROT_REGION = { left: 708, top: 242, width: 140, height: 35 };

// Move tolerances
const MOVE_ABS_TOL = 0.01;
const MOVE_REL_TOL = 0.01;

const HOLD_LEAD_MS = 0;
const HOLD_TAIL_MS = 0;

const CAL_TOL_PCT = 0.0005;
const CAL_ABS_TOL = 0.000025;

// Limits
const START_DELAY_MS = 8000;
const MAX_STEPS = 1000;
const SMALLEST_MAX_TRIES = 50;

// ===== CLI helpers =====
function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

function parseIndex(val) {
  if (val == null) return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
}

// ===== Menu runner =====
async function runMenuScript(script, blockName) {
  if (!script || !blockName) throw new Error("runMenuScript: bad args");
  const block = script.menuCommands.find((b) => b[blockName]);
  if (!block) {
    console.warn(`No "${blockName}" block for ${script.modelName}`);
    return;
  }

  for (const s of block[blockName]) {
    if (s.op === "repeat") {
      const times = Number(s.times) || 0;
      if (times > 0) await repeat(s.key, times);
    } else if (s.op === "tap") {
      const delay = s.ms != null ? Number(s.ms) : 225;
      await tapName(s.key, delay);
    } else if (s.op === "sleep") {
      await sleep(Number(s.ms) || 0);
    }
  }
}

// ===== Position placement using calibrated mover =====
async function runPlacementXYZ({ calibration, target, region, targetName }) {
  console.log(`\nTwo-phase move starts in 3 seconds… (Target: ${target})`);
  const result = await moveToTest({
    target: target,
    calibration,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    region: region, 
    wholeTol: 2, fracTol: 0.02,
    tolerances: { relPct: MOVE_REL_TOL, absTol: MOVE_ABS_TOL },
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

  return result;
}

// ===== Rotation placement using calibrated mover =====
async function runPlacementROT({ calibration, target, region, targetName }) {
  const convertedTarget = to360From180(target);
  console.log("Target: " + target + " " + "Converted: " + convertedTarget);

  const result = await moveToTest({
    target: convertedTarget,
    calibration,
    axisLabel: targetName,
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    tolerances: { relPct: MOVE_REL_TOL, absTol: MOVE_ABS_TOL },
    maxSteps: MAX_STEPS,
    wholeTol: 2, fracTol: 0.02,
    smallestMaxTries: SMALLEST_MAX_TRIES,
    ui: { live: true },
    lead: 30,
    tail: 10,
    region: region,
    rotation: true,
  });

  return result;
}

async function main() {
  try {
    // 1) load target rows
    const rows = await parseTrackData("./data/hotdog.json", {
      root: "mission",
    });

    // 2) parse CLI index range (inclusive)
    const total = rows.length;
    const minIndex = 0;
    const maxIndex = Math.max(0, total - 1);

    let startIdx = parseIndex(getArg("--start"));
    let endIdx = parseIndex(getArg("--end"));

    // defaults if not provided
    if (startIdx == null) startIdx = minIndex;
    if (endIdx == null) endIdx = maxIndex;

    // clamp to valid range
    startIdx = Math.max(minIndex, Math.min(startIdx, maxIndex));
    endIdx = Math.max(minIndex, Math.min(endIdx, maxIndex));

    // ensure start <= end
    if (startIdx > endIdx) {
      // swap
      const t = startIdx;
      startIdx = endIdx;
      endIdx = t;
    }

    const count = endIdx - startIdx + 1;

    console.log(
      [
        `Rows available: ${total} (valid index range: ${minIndex}..${maxIndex})`,
        `Selected range: ${startIdx}..${endIdx} (count: ${count})`,
        `Starting in ${START_DELAY_MS / 1000}s ...`,
        ``,
        `Tip: pass --start N --end M to change the range.`,
        `  e.g., node cloneJob.js --start 10 --end 25`,
      ].join("\n")
    );

    await sleep(START_DELAY_MS);

    // 3) load menu scripts (enter/exit)
    const raw = await fs.readFile(
      new URL("./commands/propMenu.json", import.meta.url),
      "utf-8"
    );
    const data = JSON.parse(raw);
    const scripts = data.map(
      (s) =>
        new MenuScript(Math.abs(s.modelNumber), s.modelName, s.menuCommands)
    );

    const summary = [];

    for (let i = startIdx; i <= endIdx; i++) {
      const row = rows[i] || {};
      const modelNumber = row?.model;
      const targetX = Number(row?.location?.x);
      const targetY = Number(row?.location?.y);
      const targetZ = Number(row?.location?.z);
      const targetXrot = Number(row?.rotation?.x);
      const targetYrot = Number(row?.rotation?.y);
      const targetZrot = Number(row?.rotation?.z);

      if (!Number.isFinite(targetX)) {
        console.warn(`Row ${i}: missing/invalid location.x — skipping.`);
        continue;
      }

      const script = scripts.find((s) => s.modelNumber === modelNumber);
      if (!script) {
        console.warn(
          `Row ${i}: no script for model ${modelNumber} — skipping.`
        );
        continue;
      }

      try {
        console.log(
          `\n▶ Row ${i + 1}/${rows.length} model=${modelNumber} "${script.modelName}"`
        );

        // enter menu flow (your JSON drives the key taps)
        await runMenuScript(script, "enter");

        await repeat("DPAD_DOWN", 5);
        await sleep(225);
        await tapName("CROSS", 225);
        await sleep(225);
        await tapName("CROSS", 225);
        await sleep(225);
        await tapName("CROSS", 225);
        await sleep(225);
        await repeat("DPAD_DOWN", 2);

        // X
        const xpos = await runPlacementXYZ({
          calibration: positionCal,
          target: targetX,
          region: X_REGION,
          targetName: `index ${i} for X`,
        });

        // Y
        await tapName("DPAD_DOWN", 225);
        await sleep(225);
        const ypos = await runPlacementXYZ({
          calibration: positionCal,
          target: targetY,
          region: Y_REGION,
          targetName: `index ${i} for Y`,
        });

        // Z
        await tapName("DPAD_DOWN", 225);
        await sleep(225);
        const zpos = await runPlacementXYZ({
          calibration: positionCal,
          target: targetZ,
          region: Z_REGION,
          targetName: `index ${i} for Z`,
        });

        // Override Position confirm path
        await repeat("CIRCLE", 1);
        await sleep(225);
        await tapName("DPAD_DOWN", 225);
        await tapName("CROSS", 225);
        await sleep(225);
        await tapName("CROSS", 225);
        await sleep(500);

        // Rotation X (actually Y in Rockstar)
        await repeat("DPAD_DOWN", 2);
        const xRot = await runPlacementROT({
          calibration: rotationCal,
          target: targetYrot,
          region: XROT_REGION,
          targetName: `index ${i} for XROT`,
        });

        // Rotation Y (actually X in Rockstar)
        await repeat("DPAD_DOWN", 1);
        const yRot = await runPlacementROT({
          calibration: rotationCal,
          target: targetXrot,
          region: YROT_REGION,
          targetName: `index ${i} for YROT`,
        });

        // Rotation Z
        await repeat("DPAD_DOWN", 1);
        const zRot = await runPlacementROT({
          calibration: rotationCal,
          target: targetZrot,
          region: ZROT_REGION,
          targetName: `index ${i} for ZROT`,
        });

        await sleep(225);

        // Confirm & exit
        await tapName("CROSS", 500); // confirm
        await sleep(225);
        await tapName("CIRCLE", 225);
        await sleep(225);
        await tapName("CIRCLE", 225);
        await sleep(225);

        await repeat("DPAD_DOWN", 3);

        await runMenuScript(script, "exit");

        // optional: record into summary (customize if you want)
        summary.push({
          i,
          model: modelNumber,
          X: xpos?.final ?? null,
          Y: ypos?.final ?? null,
          Z: zpos?.final ?? null,
          XROT: xRot?.final ?? null,
          YROT: yRot?.final ?? null,
          ZROT: zRot?.final ?? null,
        });

        console.clear();
        console.table(summary);
      } catch (err) {
        console.error(`Row ${i}: error:`, err);
      }

      await sleep(225);
    }

    console.log("\n✅ Done.");
  } catch (err) {
    console.error("Error:", err?.message || err);
  } finally {
    process.exit(0);
  }
}

main();
