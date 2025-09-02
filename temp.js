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
process.stdin.setRawMode(true);
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

// ---------------- Main sequence ----------------
async function runTubeCorner30D({
  target_x,
  target_y,
  target_z,
  vrot_x,
  vrot_y,
  vrot_z,
  speed,
}) {
  var current_x = 0;
  var current_y = 0;
  var current_z = 0;

  await repeat("DPAD_RIGHT", 4);

  await tapName("DPAD_DOWN", 200);

  await repeat("DPAD_RIGHT", 4);
  await repeat("DPAD_RIGHT", 4);

  await repeat("DPAD_DOWN", 5);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);

  await sleep(250);
  await repeat("DPAD_DOWN", 2);

  // HOLD TRIANGLE TO SPEED SHIT UP
  keyDownName("TRIANGLE");

  // X AXIS - Location
  const { buffer: xBuf } = await captureRegion({
    // out: "x.png",
    screenIndex: 1,
    region: { left: 760, top: 168, width: 140, height: 35 },
  });

  const xtxt = await extractText(xBuf, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_x = Number(xtxt);

  await moveAxis(current_x, target_x, speed, "x");
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // Y AXIS - Location
  const { buffer: yBuf } = await captureRegion({
    // out: "y.png",
    screenIndex: 1,
    //760 204 160 3
    region: { left: 760, top: 204, width: 140, height: 35 },
  });

  const ytxt = await extractText(yBuf, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_y = Number(ytxt);

  await moveAxis(current_y, target_y, speed, "y");
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // Z AXIS - Location
  const { buffer: zBuf } = await captureRegion({
    // out: "z.png",
    screenIndex: 1,
    // 760 244 140 35
    region: { left: 760, top: 244, width: 140, height: 35 },
  });

  const ztxt = await extractText(zBuf, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_z = Number(ztxt);

  await moveAxis(current_z, target_z, speed, "z");
  await sleep(500);

  // RElEASE TRIANGLE
  keyUpName("TRIANGLE");

  // ROTATION

  await tapName("CIRCLE", 200);
  await tapName("DPAD_DOWN", 200);

  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);

  await repeat("DPAD_DOWN", 2);

  console.log("\n===============\nROTATION\n===============\n");

  // HOLD TRIANGLE TO SPEED SHIT UP
  keyDownName("TRIANGLE");

  const { buffer: vrot_x_buff } = await captureRegion({
    // out: "vrot_x.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 168, width: 140, height: 35 },
  });

  const current_vrotx = await extractText(vrot_x_buff, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  await moveRotationSmart(current_vrotx, vrot_y, 60, "x");
  await sleep(500);

  await tapName("DPAD_DOWN", 200);

  const { buffer: vrot_y_buff } = await captureRegion({
    // out: "vrot_y.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 204, width: 140, height: 35 },
  });

  const current_vroty = await extractText(vrot_y_buff, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  await moveRotationSmart(current_vroty, vrot_x, 60, "y");
  await sleep(500);

  await tapName("DPAD_DOWN", 200);

  const { buffer: vrot_z_buff } = await captureRegion({
    // out: "vrot_z.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 242, width: 140, height: 35 },
  });

  const current_vrotz = await extractText(vrot_z_buff, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  console.log(current_vrotz);

  await moveRotationSmart(current_vrotz, vrot_z, 60, "z");
  await sleep(500);

  // RElEASE TRIANGLE
  keyUpName("TRIANGLE");

  // CONFIRM IT ALL
  await tapName("CROSS", 200);
  await sleep(250);

  await tapName("CIRCLE", 200);
  await sleep(250);
  await tapName("CIRCLE", 200);

  await repeat("DPAD_DOWN", 3);

  await repeat("DPAD_LEFT", 4);
}

async function runPlacement({
  target_x,
  target_y,
  target_z,
  vrot_x,
  vrot_y,
  vrot_z,
  speed,
}) {

  await repeat("DPAD_DOWN", 5);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);

  await sleep(250);
  await repeat("DPAD_DOWN", 2);

  // HOLD TRIANGLE TO SPEED SHIT UP
  keyDownName("TRIANGLE");

  // X AXIS - Location
  const { buffer: xBuf } = await captureRegion({
    // out: "x.png",
    screenIndex: 1,
    region: { left: 760, top: 168, width: 140, height: 35 },
  });

  const xtxt = await extractText(xBuf, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_x = Number(xtxt);

  await moveAxis(current_x, target_x, speed, "x");
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // Y AXIS - Location
  const { buffer: yBuf } = await captureRegion({
    // out: "y.png",
    screenIndex: 1,
    //760 204 160 3
    region: { left: 760, top: 204, width: 140, height: 35 },
  });

  const ytxt = await extractText(yBuf, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_y = Number(ytxt);

  await moveAxis(current_y, target_y, speed, "y");
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // Z AXIS - Location
  const { buffer: zBuf } = await captureRegion({
    // out: "z.png",
    screenIndex: 1,
    // 760 244 140 35
    region: { left: 760, top: 244, width: 140, height: 35 },
  });

  const ztxt = await extractText(zBuf, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_z = Number(ztxt);

  await moveAxis(current_z, target_z, speed, "z");
  await sleep(500);

  // RElEASE TRIANGLE
  keyUpName("TRIANGLE");

  // ROTATION

  await tapName("CIRCLE", 200);
  await tapName("DPAD_DOWN", 200);

  await tapName("CROSS", 200);
  await sleep(250);
  await tapName("CROSS", 200);
  await sleep(250);

  await repeat("DPAD_DOWN", 2);

  console.log("\n===============\nROTATION\n===============\n");

  // HOLD TRIANGLE TO SPEED SHIT UP
  keyDownName("TRIANGLE");

  const { buffer: vrot_x_buff } = await captureRegion({
    // out: "vrot_x.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 168, width: 140, height: 35 },
  });

  const current_vrotx = await extractText(vrot_x_buff, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  await moveRotationSmart(current_vrotx, vrot_y, 60, "x");
  await sleep(500);

  await tapName("DPAD_DOWN", 200);

  const { buffer: vrot_y_buff } = await captureRegion({
    // out: "vrot_y.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 204, width: 140, height: 35 },
  });

  const current_vroty = await extractText(vrot_y_buff, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  await moveRotationSmart(current_vroty, vrot_x, 60, "y");
  await sleep(500);

  await tapName("DPAD_DOWN", 200);

  const { buffer: vrot_z_buff } = await captureRegion({
    // out: "vrot_z.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 242, width: 140, height: 35 },
  });

  const current_vrotz = await extractText(vrot_z_buff, {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  console.log(current_vrotz);

  await moveRotationSmart(current_vrotz, vrot_z, 60, "z");
  await sleep(500);

  // RElEASE TRIANGLE
  keyUpName("TRIANGLE");

  // CONFIRM IT ALL
  await tapName("CROSS", 200);
  await sleep(250);

  await tapName("CIRCLE", 200);
  await sleep(250);
  await tapName("CIRCLE", 200);

  await repeat("DPAD_DOWN", 3);
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

      for (let i = 20; i < rows.length; i++) {
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

          await runPlacement();

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
 * Convert angle from [-180, 180] to [0, 360)
 * @param {number} angle - input angle
 * @returns {number} - normalized angle
 */
function to360(angle) {
  return ((angle % 360) + 360) % 360;
}

main();
