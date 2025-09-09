// cloneJob.js — X-only with menu movements (enter -> move X -> exit)

import fs from "fs/promises";
import { tapName, repeat } from "./helpers/keys.js";
import { sleep } from "./helpers/sleep.js";
import parseTrackData from "./trackParser.js";
import MenuScript from "./classes/MenuScript.js";

import { loadCalibration } from "./helpers/calibrationIO.js";
import { moveTo } from "./helpers/moveTo.js";

// ===== Config =====

// OCR region for X field (adjust if needed)
const X_REGION = { left: 760, top: 168, width: 140, height: 35 };
const Y_REGION = { left: 760, top: 204, width: 140, height: 35 };
const Z_REGION = { left: 760, top: 244, width: 140, height: 35 };

// Move tolerances (tighten/loosen to taste)
const MOVE_ABS_TOL = 0.001;
const MOVE_REL_TOL = 0.0;

// Limits
const START_DELAY_MS = 5000;
const MAX_STEPS = 400;
const SMALLEST_MAX_TRIES = 150;

// Run a named script block like "enter" or "exit"
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
      const delay = s.ms != null ? Number(s.ms) : 250;
      await tapName(s.key, delay);
    } else if (s.op === "sleep") {
      await sleep(Number(s.ms) || 0);
    }
  }
}

// ===== main Position placement using calibrated mover =====
async function runPlacementXYZ({ calibration, target, region, targetName }) {
  // Assumes your "enter" script leaves the cursor focused in the X field.
  const result = await moveTo({
    target: target,
    calibration,
    axisLabel: "x",
    dirKeys: { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
    tolerances: { relPct: MOVE_REL_TOL, absTol: MOVE_ABS_TOL },
    maxSteps: MAX_STEPS,
    smallestMaxTries: SMALLEST_MAX_TRIES,
    ui: { live: true },
    lead: 30,
    tail: 10,
    defaultRegion: region,
  });

  console.log(
    `[${targetName}] target=${target.toFixed(6)} final=${result.final.toFixed(
      6
    )} err=${result.error.toFixed(6)} steps=${result.steps} reason=${
      result.reason
    }`
  );

  return result;
}

async function main() {
  try {
    // 1) load target rows
    const rows = await parseTrackData("./data/hotdog.json", {
      root: "mission",
    });

    // 2) load menu scripts (enter/exit)
    const raw = await fs.readFile(
      new URL("./commands/propMenu.json", import.meta.url),
      "utf-8"
    );
    const data = JSON.parse(raw);
    const scripts = data.map(
      (s) =>
        new MenuScript(Math.abs(s.modelNumber), s.modelName, s.menuCommands)
    );

    // 3) load calibration
    const calibration = await loadCalibration("calibration.json");

    console.log(
      `Loaded ${rows.length} rows. Starting in ${START_DELAY_MS / 1000}s ...`
    );
    await sleep(START_DELAY_MS);

    const summary = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const modelNumber = row?.model;
      const targetX = Number(row?.location?.x);
      const targetY = Number(row?.location?.y);
      const targetZ = Number(row?.location?.z);

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
          `\n▶ Row ${i + 1}/${rows.length} model=${modelNumber} "${
            script.modelName
          }"`
        );

        // enter menu flow (your JSON drives the key taps)
        await runMenuScript(script, "enter");

        await repeat("DPAD_DOWN", 5);
        await sleep(250);
        await tapName("CROSS", 200);
        await sleep(250);
        await tapName("CROSS", 200);
        await sleep(250);
        await tapName("CROSS", 200);
        await sleep(250);
        await repeat("DPAD_DOWN", 2);

        // move X using calibrated steps (live table prints during the move)
        const xpos = await runPlacementXYZ({
          calibration,
          target: targetX,
          region: X_REGION,
          targetName: "X",
        });

        // Move down to Y field
        await tapName("DPAD_DOWN", 200);
        await sleep(250);

        // move Y using calibrated steps (live table prints during the move)
        const ypos = await runPlacementXYZ({
          calibration,
          target: targetY,
          region: Y_REGION,
          targetName: "Y",
        });

        // Move down to Z field
        await tapName("DPAD_DOWN", 200);
        await sleep(250);

        // move Z using calibrated steps (live table prints during the move)
        const zpos = await runPlacementXYZ({
          calibration,
          target: targetZ,
          region: Z_REGION,
          targetName: "Z",
        });

        //Move to Override Position
        await repeat("CIRCLE", 1);
        await repeat("DPAD_DOWN", 1);
        await repeat("CROSS", 1);

        // Move down to Rotation X
        await repeat("DPAD_DOWN", 2);

        // Move down to Rotation Y
        await repeat("DPAD_DOWN", 1);

        // Move down to Rotation Z
        await repeat("DPAD_DOWN", 1);
        await sleep(250);

        // Confirm & exit as before
        await tapName("CROSS", 200); // confirm
        await sleep(250);
        await tapName("CIRCLE", 200);
        await sleep(250);
        await tapName("CIRCLE", 200);

        await repeat("DPAD_DOWN", 3);

        // exit menu flow
        await runMenuScript(script, "exit");

        // show summary after each iteration
        console.clear();

        console.table(summary);
      } catch (err) {
        console.error(`Row ${i}: error:`, err?.message || err);
      }

      await sleep(250);
    }

    console.log("\n✅ Done.");
  } catch (err) {
    console.error("Error:", err?.message || err);
  } finally {
    process.exit(0);
  }
}

main();
