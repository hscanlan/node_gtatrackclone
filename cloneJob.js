// cloneJob.js
import robot from "robotjs";
import { captureRegion } from "./capture-window.js";
import { extractText } from "./ocr-text.js";
import parseTrackData from "./trackParser.js";



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
  return r > 180 ? r - 360 : r;      // (-180, 180]
}

/**
 * Rotate from current -> target using shortest path.
 * - delta > 0  => RIGHT
 * - delta < 0  => LEFT
 * - |delta| ≈ 0 or ≈ 180 => do nothing (treated as zero)
 *
 * If target is NaN/undefined, we treat it as current (delta=0).
 */
async function moveRotationSmart(current, target, speed, axis = "rot", epsilon = 1e-3) {
  if (signal.aborted) throw new Error("aborted");

  console.log(current);

  // Sanitize inputs
  const cur = normSigned(toFinite(current, 0));
  const tgt = normSigned(toFinite(target, cur)); // if target invalid → use current
  const spd = toFinite(speed, 0);

  // Shortest signed delta
  let delta = normSigned(tgt - cur);

  // Treat near-0 and near-±180 as zero movement
  const isZeroish = Math.abs(delta) < epsilon || Math.abs(Math.abs(delta) - 180) < epsilon;

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
    console.log(`${axis.toUpperCase()}: rotating RIGHT ${deltaForLog.toFixed(3)}° for ${ttms.toFixed(0)} ms`);
    await tapName("DPAD_RIGHT", ttms);
  } else {
    console.log(`${axis.toUpperCase()}: rotating LEFT ${Math.abs(deltaForLog).toFixed(3)}° for ${ttms.toFixed(0)} ms`);
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
  await captureRegion({
    out: "x.png",
    screenIndex: 1,
    region: { left: 760, top: 168, width: 140, height: 35 },
  });

  const xtxt = await extractText("x.png", {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_x = Number(xtxt);

  await moveAxis(current_x, target_x, speed, "x");
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // Y AXIS - Location
  await captureRegion({
    out: "y.png",
    screenIndex: 1,
    //760 204 160 35
    region: { left: 760, top: 204, width: 140, height: 35 },
  });

  const ytxt = await extractText("y.png", {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  current_y = Number(ytxt);

  await moveAxis(current_y, target_y, speed, "y");
  await tapName("DPAD_DOWN", 200);
  await sleep(500);

  // Z AXIS - Location
  await captureRegion({
    out: "z.png",
    screenIndex: 1,
    // 760 244 140 35
    region: { left: 760, top: 244, width: 140, height: 35 },
  });

  const ztxt = await extractText("z.png", {
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

  await captureRegion({
    out: "vrot_x.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 168, width: 140, height: 35 },
  });

  const current_vrotx = await extractText("vrot_x.png", {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  await moveRotationSmart(current_vrotx, vrot_y, 60, "x");
  await sleep(500);

  await tapName("DPAD_DOWN", 200);
  

  await captureRegion({
    out: "vrot_y.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 204, width: 140, height: 35 },
  });

  const current_vroty = await extractText("vrot_y.png", {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });

  await moveRotationSmart(current_vroty, vrot_x, 60, "y");
  await sleep(500);

  await tapName("DPAD_DOWN", 200);

  await captureRegion({
    out: "vrot_z.png",
    screenIndex: 1,
    // 708 168 140 35
    region: { left: 708, top: 242, width: 140, height: 35 },
  });

  const current_vrotz = await extractText("vrot_z.png", {
    numericOnly: true, // keep only 0-9 and dot
    psm: 7, // single line
  });


  console.log(current_vrotz);

  await moveRotationSmart(current_vrotz,vrot_z,  60, "z");
  await sleep(500);

  // RElEASE TRIANGLE
  keyUpName("TRIANGLE");

  // CONFIRM IT ALL
  await tapName("CROSS", 200);
  await sleep(250);

  await tapName("CIRCLE", 200);
  await sleep(250);
  await tapName("CIRCLE", 200);

  await repeat("DPAD_DOWN", 2);

  await repeat("DPAD_LEFT", 4);
}

async function main() {
  try {
    const speed = 60.0;

    try {
      const rows = await parseTrackData("./data/hotdog.json", {
        root: "mission",
      });

      const startIn = 5000;
      console.log(
        `Loaded ${rows.length} rows. Starting in ${startIn/1000}'s... press Q to quit.`
      );
      await sleep(startIn);

      for (let i = 0; i < rows.length; i++) {
        if (signal.aborted) break;

        const row = rows[i] || {};
        const { model, location, rotation } = row;

        if(model !==2138176025)
        {
         console.log("\x1b[31m");
          console.warn(`Model ${model} missing.`);
         console.log("\x1b[0m");
          continue;
        }

        if (!location || !rotation) {
          console.warn(`Row ${i}: missing location/rotation; skipping.`);
          continue;
        }

        console.log(`\n▶ Row ${i + 1}/${rows.length} model=${model}`);

        console.log(rotation.x);
           console.log(rotation.y);
           console.log(rotation.z);
        
        try {
          await runTubeCorner30D({
            target_x: location.x,
            target_y: location.y,
            target_z: location.z,
            vrot_x: rotation.x ?? 0,
            vrot_y: rotation.y ?? 0,
            vrot_z: rotation.z ?? 0,
            speed,
          });
        } catch (err) {
          if (err?.message === "aborted") throw err; // bubble up abort
          console.error(`Row ${i}: error:`, err?.message || err);
        }

        // small pacing gap between rows
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
