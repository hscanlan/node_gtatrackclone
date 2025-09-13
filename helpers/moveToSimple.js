// helpers/moveTo.js
import { keyDownName, keyUpName, tapName } from "./keys.js";
import { readCurrent } from "./utils.js";

async function difference(a, b) {
  return Math.abs(a - b);
}

/**
 * Move a numeric axis to `target` using calibrated steps until within tolerance.
 * - Re-reads current after each pass (but avoids double-reading if caller already has it)
 * - Recomputes plan and DPAD direction each pass
 * - Stops when |target - current| <= tol or maxLoops reached
 *
 * @param {number} target
 * @param {Array<{target:number, ms:number, heldKey:string}>} calibration
 * @param {object} region - capture/ocr region for readCurrent
 * @param {object} opts
 * @param {number} [opts.tol=0.001] - absolute tolerance to stop
 * @param {number} [opts.maxLoops=12] - safety cap
 * @param {number} [opts.settleMs=50] - wait after a pass before re-reading
 * @param {boolean} [opts.verbose=true]
 * @param {number} [opts.current] - optional already-read current value
 */
export async function moveTo(
  target,
  calibration,
  region,
  opts = {}
) {
  const tol = opts.tol ?? 0.000;
  const maxLoops = opts.maxLoops ?? 12;
  const settleMs = opts.settleMs ?? 50;
  const verbose = opts.verbose ?? false;

  const readNum = async () => Number((await readCurrent(region)).toFixed(6));
  const log = (...args) => { if (verbose) console.log(...args); };

  // Start with provided current if available, else read
  let current = opts.current !== undefined ? Number(opts.current.toFixed(6)) : await readNum();

  for (let attempt = 1; attempt <= maxLoops; attempt++) {
    const diffSigned = target - current;        // signed distance
    const diffAbs = Math.abs(diffSigned);       // absolute distance
    const diffRounded = Number(diffAbs.toFixed(3));

    log(`\n[moveTo] attempt ${attempt}`);
    log(`current: ${current} target: ${target} diffAbs: ${diffRounded}`);

    if (diffAbs <= tol) {
      log(`[moveTo] within tolerance (tol=${tol}). Done.`);
      return { reached: true, attempts: attempt, final: current, error: target - current };
    }

    // Build plan for remaining distance
    const plan = calculateClosestPlanGrouped(diffAbs, calibration);
    log(`[moveTo] plan:`);
    log(JSON.stringify(plan, null, 2));

    // Direction: if target > current, go LEFT; otherwise RIGHT
    const padDirection = diffSigned > 0 ? "DPAD_RIGHT" : "DPAD_LEFT";

    // Execute plan
    for (const entry of plan) {
      const hold = entry.heldKey && entry.heldKey !== "-" ? entry.heldKey : null;
      try {
        if (hold) await keyDownName(hold);
        await tapName(padDirection, entry.groupMsTotal);
      } finally {
        if (hold) await keyUpName(hold);
      }
    }

    //if (settleMs > 0) await sleep(settleMs);

    // Re-read once at end of pass
    current = await readNum();
    const newDiffAbs = Math.abs(target - current);
    log(`[moveTo] after pass -> current: ${current} | remaining: ${Number(newDiffAbs.toFixed(3))}`);

    if (newDiffAbs <= tol) {
      log(`[moveTo] within tolerance after pass. Done.`);
      return { reached: true, attempts: attempt, final: current, error: target - current };
    }
  }

  // Safety exit
  const error = target - current;
  console.warn(`[moveTo] maxLoops reached. final=${current}, error=${error}`);
  return { reached: false, attempts: maxLoops, final: current, error };
}


/**
 * Move a numeric axis to target using calibrated steps with batching for ALL step sizes.
 */
/*
export async function moveTo(target, calibration, region) {
  var current = await readCurrent(region);
  current = Number(current.toFixed(6));

  var diff = await difference(current, target);
  diff = Number(diff.toFixed(3));

  console.log(`current: ${current} target: ${target} diff: ${diff}`);

  var plan = calculateClosestPlanGrouped(diff, calibration);
  console.log(plan,null,2);
  var final = 0;

  var padDirection = getDirection(target,current);

  for (const entry of plan) {
    try {
      if (entry.heldKey !== "-") {
        keyDownName(entry.heldKey);
      }

      await tapName(padDirection, entry.groupMsTotal);
    } finally {
      if (entry.heldKey !== "-") {
        keyUpName(entry.heldKey);
      }
    }
  }

  var final = await readCurrent(region);
  diff = await difference(current, final);
  diff = Number(diff.toFixed(3));

  console.log(
    `current: ${current} target: ${target} diff: ${diff} final: ${final}`
  );
}*/

function getDirection(target, current) {
  if (target > current) {
    return "DPAD_RIGHT";
  } else {
    return "DPAD_LEFT";
  }
}

/**
 * Build a step plan (largest -> smallest) using all calibration rows.
 * If exact target isn't representable, it snaps to the nearest representable value.
 *
 * Returns:
 * [
 *   {
 *     heldKey: string,
 *     steps: [{ step:number, count:number, msEach:number, msTotal:number }, ...],
 *     groupMsTotal: number
 *   },
 *   ...,
 *   { achieved:number, error:number, totalMs:number }
 * ]
 */
function calculateClosestPlanGrouped(targetValue, calibration) {
  console.log(targetValue);

  if (!Number.isFinite(targetValue))
    throw new Error("targetValue must be finite");
  if (!Array.isArray(calibration) || calibration.length === 0) {
    throw new Error("calibration must be a non-empty array");
  }

  // Determine integer scaling from max decimals across step targets
  const maxDecimals = calibration.reduce((acc, c) => {
    const s = String(c.target);
    const i = s.indexOf(".");
    const d = i >= 0 ? s.length - i - 1 : 0;
    return Math.max(acc, d);
  }, 0);
  const scale = Math.pow(10, maxDecimals);

  // Normalize steps
  const steps = calibration
    .map((c) => ({
      step: Number(c.target),
      stepInt: Math.round(Number(c.target) * scale),
      msEach: Number(c.ms),
      heldKey: c.heldKey || "-",
    }))
    .filter((s) => s.stepInt > 0 && Number.isFinite(s.msEach))
    .sort((a, b) => b.stepInt - a.stepInt);

  if (steps.length === 0) throw new Error("No usable calibration steps.");

  // GCD of step sizes -> representable lattice
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const stepGcd = steps.reduce((g, s) => gcd(g, s.stepInt), steps[0].stepInt);

  const targetInt = Math.round(targetValue * scale);
  const snappedInt = Math.round(targetInt / stepGcd) * stepGcd;

  // Greedy decomposition
  let remainingInt = snappedInt;
  const groupsMap = new Map(); // heldKey -> { heldKey, steps:[], groupMsTotal }

  for (const s of steps) {
    if (remainingInt <= 0) break;

    const count = Math.floor(remainingInt / s.stepInt);
    if (count > 0) {
      const msTotal = count * s.msEach;

      let group = groupsMap.get(s.heldKey);
      if (!group) {
        group = { heldKey: s.heldKey, steps: [], groupMsTotal: 0 };
        groupsMap.set(s.heldKey, group);
      }
      group.steps.push({
        step: s.step,
        count,
        msEach: s.msEach,
        msTotal,
      });
      group.groupMsTotal += msTotal;

      remainingInt -= count * s.stepInt;
    }
  }

  return Array.from(groupsMap.values());
}
