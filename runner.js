import fs from "fs/promises";

import { extractText } from "./ocr-text.js";
import { captureRegion } from "./capture-window.js";
import robot from "robotjs";

// ----------------------------
// Utility
// ----------------------------
function resolve(val, ctx) {
  if (typeof val === "string" && val in ctx) return ctx[val];
  return val;
}


let rejectAbort;
const abortPromise = new Promise((_, rej) => {
  rejectAbort = rej;
});


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
 
    await tapName(name, holdMs);
  }
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

// ----------------------------
// Command Handlers
// ----------------------------
// NOTE: your real implementations of these helpers
// (repeat, tapName, keyDownName, keyUpName, sleep,
// captureRegion, extractText, moveAxis, moveRotationSmart)
// must be imported or defined somewhere accessible.
const handlers = {
  async repeat(step, ctx) {
    await repeat(step.name, resolve(step.times, ctx));
  },
  async tap(step) {
    await tapName(step.name, step.ms ?? 200);
  },
  async keyDown(step) {
    keyDownName(step.name);
  },
  async keyUp(step) {
    keyUpName(step.name);
  },
  async sleep(step) {
    await sleep(step.ms ?? 0);
  },
  async capture(step) {
    await captureRegion({
      out: step.out,
      screenIndex: step.screenIndex ?? 0,
      region: step.region
    });
  },
  async ocr(step, ctx) {
    const raw = await extractText(step.in, step.options ?? {});
    let n;

    if (typeof raw === "number") {
      n = raw;
    } else if (typeof raw === "string") {
      // If your OCR ever returns a string like "123.45", parse it:
      const parsed = Number(raw);
      n = Number.isNaN(parsed) ? NaN : parsed;
    } else {
      n = NaN;
    }

    ctx[step.assign] = n;
  },
  async moveAxis(step, ctx) {
    const from = resolve(step.from, ctx);
    const to = resolve(step.to, ctx);
    const spd = resolve(step.speed, ctx);
    await moveAxis(from, to, spd, step.axis);
  },
  async moveRotationSmart(step, ctx) {
    const from = resolve(step.from, ctx);
    const to = resolve(step.to, ctx);
    const spd = resolve(step.speed, ctx);
    await moveRotationSmart(from, to, spd, step.axis);
  },
  async log(step) {
    console.log(step.text ?? "");
  },
  async logValue(step, ctx) {
    console.log(ctx[step.var]);
  },
  async set(step, ctx) {
    ctx[step.var] = resolve(step.value, ctx);
  }
};

// ----------------------------
// Run commands for a single model spec
// ----------------------------
async function runModelCommands(spec, initialContext = {}) {
  const ctx = { ...initialContext };

  for (const step of spec.commands) {
    const fn = handlers[step.cmd];
    if (!fn) {
      console.warn(`Unknown cmd: ${step.cmd} — skipping`);
      continue;
    }
    await fn(step, ctx);
  }

  return ctx;
}

// ----------------------------
// Exported API
// ----------------------------
export async function runModelFromFile(jsonPath, modelId, initialContext = {}) {
  const raw = await fs.readFile(jsonPath, "utf-8");
  const models = JSON.parse(raw); // array of models

  const modelSpec = models.find(
    m => m.modelNumber === modelId || m.modelName === modelId
  );

  if (!modelSpec) {
    throw new Error(`Model "${modelId}" not found in ${jsonPath}`);
  }

  console.log(`\n▶ Running model: ${modelSpec.modelName} (${modelSpec.modelNumber})`);

  return await runModelCommands(modelSpec, initialContext);
}
