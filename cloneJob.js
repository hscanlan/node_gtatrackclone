// cloneJob.js
import robot from "robotjs";
import fs from "fs/promises";
import { captureRegion } from "./capture-window.js";
import { extractText } from "./ocr-text.js";
import parseTrackData from "./trackParser.js";
import MenuScript from "./classes/MenuScript.js"; // note the .js extension

// ---------------- Abort (single listener) ----------------
const ac = new AbortController();
const { signal } = ac;

let rejectAbort;
const abortPromise = new Promise((_, rej) => {
  rejectAbort = rej;
});

if (signal.aborted) {
  rejectAbort?.(new Error("aborted"));
} else {
  signal.addEventListener("abort", () => rejectAbort?.(new Error("aborted")), {
    once: true,
  });
}

function requestAbort(reason = "User requested quit") {
  if (!signal.aborted) {
    console.log(`\n⏹  ${reason}`);
    ac.abort();
  
}
}

// Keyboard: Q/q or Ctrl-C to abort
//process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const k = chunk.toString();
  if (k === "q" || k === "Q" || k === "\u0003") requestAbort();
});
process.on("SIGINT", () => requestAbort("SIGINT"));

// ---------------- Sleep (races with abort) ----------------
function sleep(ms) {
  return Promise.race([
    new Promise((resolve) => setTimeout(resolve, ms)),
    abortPromise,
  ]);
}

// ---------------- Mappings & helpers ----------------
const PS_MAP = {
  CROSS: "enter",
  CIRCLE: "backspace",
  SQUARE: "s",
  TRIANGLE: "c",
  DPAD_UP: "up",
  DPAD_DOWN: "down",
  DPAD_LEFT: "left",
  DPAD_RIGHT: "right",

  L1: "q",
  L2: "w",
  R1: "e",
  R2: "r",
};

function keyDownName(name) {
  console.log(name);
  const key = PS_MAP[name.toUpperCase()];
  robot.keyToggle(key, "down");
}
function keyUpName(name) {
  const key = PS_MAP[name.toUpperCase()];
  robot.keyToggle(key, "up");
}

function keyDown(key) {
  robot.keyToggle(key, "down");
}

function keyUp(key) {
  robot.keyToggle(key, "up");
}

// Always releases key even if aborted during hold
async function tap(key, holdMs = 200) {
  keyDown(key);
  try {
    await sleep(holdMs);
  } finally {
    keyUp(key);
  }
}

async function tapName(name, holdMs = 200) {
  const key = PS_MAP[name.toUpperCase()];
  if (!key) throw new Error(`Unknown button: ${name}`);
  await tap(key, holdMs);
}

function travelTimeMs(start, target, speed) {
  const distance = Math.abs(target - start);

  console.log(
    `----------------------\n` +
      `Current: ${start}\n` +
      `Target: ${target}\n` +
      `Difference: ${distance}\n` +
      `Travel Time: ${(distance / speed) * 1000}`
  );

  return (distance / speed) * 1000;
}

// --- helpers ---
function toFinite(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

// Normalize to (-180, 180]
function normSigned(a) {
  a = toFinite(a, 0);
  const r = ((a % 360) + 360) % 360; // [0, 360)
  return r > 180 ? r - 360 : r; // (-180, 180]
}

/**
 * Rotate from current -> target using shortest path.
 * - delta > 0  => RIGHT
 * - delta < 0  => LEFT
 * - |delta| ≈ 0 or ≈ 180 => do nothing (treated as zero)
 *
 * If target is NaN/undefined, we treat it as current (delta=0).
 */
async function moveRotationSmart(
  current,
  target,
  speed,
  axis = "rot",
  epsilon = 1e-3
) {
  if (signal.aborted) throw new Error("aborted");

  console.log(current);

  // Sanitize inputs
  const cur = normSigned(toFinite(current, 0));
  const tgt = normSigned(toFinite(target, cur)); // if target invalid → use current
  const spd = toFinite(speed, 0);

  // Shortest signed delta
  let delta = normSigned(tgt - cur);

  // Treat near-0 and near-±180 as zero movement
  const isZeroish =
    Math.abs(delta) < epsilon || Math.abs(Math.abs(delta) - 180) < epsilon;

  // Travel time (0 if speed invalid or no movement)
  let ttms = 0;
  if (!isZeroish && spd > 0) {
    ttms = toFinite(travelTimeMs(0, Math.abs(delta), spd), 0);
  }

  // For cleaner logs, print 0 instead of tiny epsilon jitter
  const deltaForLog = isZeroish ? 0 : delta;

  // Optional: your debug lines
  console.log(`Current: ${cur}`);
  console.log(`Target: ${tgt}`);
  console.log(`Difference: ${deltaForLog}`);
  console.log(`Travel Time: ${ttms}`);

  if (isZeroish || ttms === 0) {
    console.log(`${axis.toUpperCase()}: Not rotating`);
    return;
  }

  if (delta > 0) {
    console.log(
      `${axis.toUpperCase()}: rotating RIGHT ${deltaForLog.toFixed(
        3
      )}° for ${ttms.toFixed(0)} ms`
    );
    await tapName("DPAD_RIGHT", ttms);
  } else {
    console.log(
      `${axis.toUpperCase()}: rotating LEFT ${Math.abs(deltaForLog).toFixed(
        3
      )}° for ${ttms.toFixed(0)} ms`
    );
    await tapName("DPAD_LEFT", ttms);
  }
}

async function moveAxis(current, target, speed, axis = "x") {
  if (signal.aborted) throw new Error("aborted");
  const ttms = travelTimeMs(current, target, speed);

  if (target > current) {
    console.log(
      `${axis.toUpperCase()}: moving right for ${ttms.toFixed(0)} ms`
    );
    await tapName("DPAD_RIGHT", ttms);
  } else if (target < current) {
    console.log(`${axis.toUpperCase()}: moving left for ${ttms.toFixed(0)} ms`);
    await tapName("DPAD_LEFT", ttms);
  } else {
    console.log(`${axis.toUpperCase()}: Not moving`);
  }
}

async function repeat(name, times, holdMs = 200) {
  for (let i = 0; i < times; i++) {
    if (signal.aborted) throw new Error("aborted");
    await tapName(name, holdMs);
  }
}

const DEFAULT_TAP_MS = 250;

async function runCmd(step) {
  if (step.op === "repeat") {
    const times = Number(step.times) || 0;
    if (times > 0) await repeat(step.key, times);
  } else if (step.op === "tap") {
    const delay = step.ms != null ? Number(step.ms) : DEFAULT_TAP_MS;
    await tapName(step.key, delay);
  } else if (step.op === "sleep") {
    await sleep(Number(step.ms) || 0);
  }
}

async function runBlock(steps = []) {
  for (const s of steps) {
    await runCmd(s);
  }
}

/**
 * Run a specific block by name (e.g., "enter", "exit", "rotate", "place"…).
 *
 * @param {MenuScript} script
 * @param {string} blockName
 */
export async function runMenuScript(script, blockName) {
  if (!script || !blockName) {
    throw new Error("runMenuScript requires a script and a block name");
  }

  // menuCommands is like: [ { enter: [...] }, { exit: [...] }, { rotate: [...] } ]
  const block = script.menuCommands.find((b) => b[blockName]);
  if (!block) {
    console.warn(`No "${blockName}" block defined for ${script.modelName}`);
    return;
  }

  await runBlock(block[blockName]);
}

async function main() {
  try {
    const speed = 60.0;

    try {
      const rows = await parseTrackData("./data/hotdog.json", {
        root: "mission",
      });

      const raw = await fs.readFile(
        new URL("./commands/propMenu.json", import.meta.url),
        "utf-8"
      );
      const data = JSON.parse(raw);

      // Turn plain objects into MenuScript instances
      const scripts = data.map(
        (s) =>
          new MenuScript(Math.abs(s.modelNumber), s.modelName, s.menuCommands)
      );

      const startIn = 5000;
      console.log(
        `Loaded ${rows.length} rows. Starting in ${
          startIn / 1000
        }'s... press Q to quit.`
      );
      await sleep(startIn);

      for (let i = 9; i < rows.length; i++) {
        if (signal.aborted) break;

        const row = rows[i] || {};
        const { model, location, rotation, modelName } = row;
        const modelNumber = model;

        if (!location || !rotation) {
          console.warn(`Row ${i}: missing location/rotation; skipping.`);
          continue;
        }

        try {
          const script = scripts.find((s) => s.modelNumber === modelNumber);
          if (!script) {
            console.error(`No script found for modelNumber ${modelNumber}`);
            continue;
          }

          console.log(
            `\n▶ Row ${i + 1}/${rows.length} model: ${modelNumber} name: ${
              script.modelName
            }`
          );
          console.log(rotation.x, rotation.y, rotation.z);

          await runMenuScript(script, "enter");

          await runPlacement({
            target_x: location.x,
            target_y: location.y,
            target_z: location.z,
            vrot_x: rotation.x ?? 0,
            vrot_y: rotation.y ?? 0,
            vrot_z: rotation.z ?? 0,
            speed,
          });

          await runMenuScript(script, "exit");
        } catch (err) {
          if (err?.message === "aborted") throw err;
          console.error(`Row ${i}: error:`, err?.message || err);
        }

        await sleep(250);
      }
    } catch (err) {
      console.error("Error parsing file:", err.message);
    }

    console.log("✅ Done.");
  } catch (err) {
    if (err?.message === "aborted") {
      console.log("✅ Stopped cleanly.");
    } else {
      console.error("Error:", err);
    }
  } finally {
    // cleanup stdin
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {}
    process.exit(0);
  }
}



/**
 * Refine one axis by repeatedly:
 *  1) reading OCR
 *  2) moving toward target at decaying speed
 *  3) re-reading until within tolerance or maxIters hit
 *
 * @param {Object} opts
 * @param {"x"|"y"|"z"} opts.axis
 * @param {number} opts.target                   // desired coordinate
 * @param {number} opts.initialSpeed             // your coarse speed (e.g., 1.0)
 * @param {Object} opts.region                   // captureRegion {left, top, width, height}
 * @param {boolean} [opts.triangleOnFirst=true]  // hold TRIANGLE for the first pass only
 * @param {number} [opts.tolerance=0.003]        // stop when |target-current| <= tolerance
 * @param {number} [opts.minSpeed=0.02]          // don't go below this speed
 * @param {number} [opts.decay=0.45]             // multiply speed by this each iteration
 * @param {number} [opts.maxIters=8]
 * @param {number} [opts.settleMs=120]           // wait after moves before re-read
 * @returns {Promise<number>} final OCR’d value
 */
async function nudgeToTargetAxis({
  axis,
  target,
  initialSpeed,
  region,
  tolerance = 0.003,
  minSpeed = 0.02,
  decay = 0.45,
  maxIters = 10,
  settleMs = 120,
}) {
  let iter = 0;
  let speed = Math.max(initialSpeed, minSpeed);

  const readCurrent = async () => {
    const { buffer } = await captureRegion({ screenIndex: 1, region });
    const txt = await extractText(buffer, { numericOnly: true, psm: 7 });
    const n = Number(txt);
    if (Number.isNaN(n)) throw new Error(`OCR failed on ${axis}: "${txt}"`);
    return n;
  };

  let current = await readCurrent();

  while (iter < maxIters) {
    const delta = target - current;
    if (Math.abs(delta) <= tolerance) break;

    // Decide which modifier to hold
    if (iter <= 2) keyDownName("TRIANGLE");        // coarse
    else if (iter >= 3) keyDownName("SQUARE");     // fine

    await moveAxis(current, target, speed, axis);

    // Release modifiers after move
    if (iter <= 2) keyUpName("TRIANGLE");
    if (iter >= 3) keyUpName("SQUARE");

    await sleep(settleMs);
    current = await readCurrent();

    speed = Math.max(speed * decay, minSpeed);
    iter++;
  }

  // Safety: make sure nothing is stuck
  keyUpName("TRIANGLE");
  keyUpName("SQUARE");

  return current;
}



// ---- Updated runPlacement that uses nudgeToTargetAxis ----
async function runPlacement({
  target_x,
  target_y,
  target_z, // not used below, but wired for future
  vrot_x,
  vrot_y,
  vrot_z,
  speed,     // coarse speed for first pass (e.g., 1.0)
}) {
  // Navigate into the coordinate edit UI (as you had)
  await repeat("DPAD_DOWN", 5);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await repeat("DPAD_DOWN", 2);

  // X AXIS — coarse (triangle) then fine nudges
  const finalX = await nudgeToTargetAxis({
    axis: "x",
    target: target_x,
    initialSpeed: speed,
    triangleOnFirst: true, // first pass fast, then precision
    region: { left: 760, top: 168, width: 140, height: 35 },
    tolerance: 0.001,      // tweak based on your OCR precision
    minSpeed: 2,
    decay: 0.025,
    maxIters: 12,
    settleMs: 120,
  });

  // Move down to Y field
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // (Optional) If you later add Z, do the same with its region here.

  // Confirm & exit as before
  await tapName("CROSS", 200); // confirm
  await sleep(250);
  await tapName("CIRCLE", 200);
  await sleep(250);
  await tapName("CIRCLE", 200);

  await repeat("DPAD_DOWN", 3);

  // (Optional) Log results
  console.log(`[placement] finalX=${finalX.toFixed(3)} targetX=${target_x.toFixed(3)}`);
}

/**
 * Convert angle from [-180, 180] to [0, 360)
 * @param {number} angle - input angle
 * @returns {number} - normalized angle
 */
function to360(angle) {
  return ((angle % 360) + 360) % 360;
}

main();
