// helpers/moveTo.js
import { tapName, keyDownName, keyUpName } from "./keys.js";
import { readCurrent as defaultReadCurrent } from "./utils.js";
import { sleep } from "./sleep.js";

/**
 * Press using calibration. If repeats > 1, hold once and long-press (ms * repeats).
 */
export async function applyCalibratedBatch(dirKey, entry, repeats, lead = 30, tail = 10) {
  const hold = entry.heldKey && entry.heldKey !== "-" ? entry.heldKey : null;
  const totalMs = Math.max(1, Math.round(entry.ms * repeats));

  if (hold) {
    await keyDownName(hold);
    if (lead > 0) await sleep(lead);
    try {
      await tapName(dirKey, totalMs);
    } finally {
      if (tail > 0) await sleep(tail);
      await keyUpName(hold);
    }
  } else {
    await tapName(dirKey, totalMs);
  }

  return totalMs;
}

function toMapByStep(calibArray) {
  const map = [];
  const seen = new Set();
  for (const r of calibArray) {
    const step = Number(r.target);
    const key = `${step}`;
    if (!Number.isFinite(step) || seen.has(key)) continue;
    seen.add(key);
    map.push({ step, ms: Number(r.ms), heldKey: r.heldKey ?? r.HeldKey ?? "-" });
  }
  // Largest -> smallest
  map.sort((a, b) => b.step - a.step);
  return map;
}

function effectiveFinalTolerance(target, relPct, absTol) {
  const rel = Math.abs(target) * (relPct ?? 0);
  return Math.max(absTol ?? 0, rel);
}

/**
 * Move a numeric axis to target using calibrated steps with batching for ALL step sizes.
 *
 * @param {Object} opts
 * @param {number} opts.target
 * @param {Array}  opts.calibration             // [{target, ms, heldKey}]
 * @param {Function} [opts.readFn]              // async () => currentValue
 * @param {string} [opts.axisLabel="axis"]      // logging only
 * @param {Object} [opts.dirKeys]               // { positive, negative }
 * @param {Object} [opts.tolerances]            // { relPct, absTol }
 * @param {number} [opts.maxSteps=200]          // max batched iterations
 * @param {number} [opts.smallestMaxTries=50]   // max effective repeats with smallest step
 * @param {Object} [opts.ui]                    // { live: true }
 * @param {number} [opts.lead=30]
 * @param {number} [opts.tail=10]
 * @param {Object} [opts.defaultRegion]
 */
export async function moveTo({
  target,
  calibration,
  readFn,
  axisLabel = "axis",
  dirKeys = { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
  tolerances = { relPct: 0.0, absTol: 0.001 },
  maxSteps = 200,
  smallestMaxTries = 50,
  ui = { live: true },
  lead = 30,
  tail = 10,
  defaultRegion = { left: 760, top: 168, width: 140, height: 35 },
} = {}) {
  if (!Array.isArray(calibration) || calibration.length === 0) {
    throw new Error("moveTo: calibration array is required.");
  }

  const rows = [];
  const plan = toMapByStep(calibration);
  const smallest = plan[plan.length - 1];

  const read = readFn ?? (async () => defaultReadCurrent(defaultRegion, axisLabel));
  const tol = effectiveFinalTolerance(target, tolerances.relPct, tolerances.absTol);

  // Guardrail on batch size (applies to ALL steps now)
  const MAX_REPEATS_PER_BATCH = 200;

  function render(current) {
    if (!ui?.live) return;
    console.clear();
    console.log(`Move ${axisLabel} to ${target} (tol = ${tol}) — current = ${current}\n`);
    console.table(rows);
  }

  // Strict picker: largest step <= remaining; default to smallest
  function chooseStep(absRem) {
    return plan.find(p => absRem >= p.step) ?? smallest;
  }

  const nextStepOf = (step) => {
    const idx = plan.findIndex(s => s.step === step);
    const next = plan[idx + 1];
    return next ? next.step : smallest.step;
  };

  let current = await read();
  let smallestTries = 0; // counts EFFECTIVE repeats with smallest step

  for (let batch = 1; batch <= maxSteps; batch++) {
    const remaining = target - current;
    const absRem = Math.abs(remaining);
    if (absRem <= tol) {
      render(current);
      return { ok: true, reason: "within_tolerance", steps: batch - 1, final: current, error: remaining, rows };
    }

    let chosen = chooseStep(absRem);
    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;

    // ---- batching for ALL steps ----
    const isSmallest = chosen.step === smallest.step;
    const nextSmaller = isSmallest ? smallest.step : nextStepOf(chosen.step);
    // leave buffer: half of next smaller (or tol if smallest)
    const safety = isSmallest ? Math.max(tol, smallest.step * 0.5) : Math.max(nextSmaller * 0.5, tol);

    let repeats = Math.floor((absRem - safety) / chosen.step);
    if (!Number.isFinite(repeats) || repeats < 1) repeats = 1;
    repeats = Math.min(repeats, MAX_REPEATS_PER_BATCH);

    const msTotal = await applyCalibratedBatch(dirKey, chosen, repeats, lead, tail);

    const before = current;
    const after = await read();
    const delta = after - before;

    rows.push({
      Batch: batch,
      Dir: dirKey,
      StepSize: chosen.step,
      Repeats: repeats,
      msEach: chosen.ms,
      msTotal,
      HeldKey: chosen.heldKey ?? "-",
      Before: Number(before.toFixed(6)),
      After: Number(after.toFixed(6)),
      Delta: Number(delta.toFixed(6)),
      Remaining: Number((target - after).toFixed(6)),
    });

    current = after;
    render(current);

    if (isSmallest) {
      smallestTries += repeats; // count effective attempts
      if (smallestTries >= smallestMaxTries) {
        const finalRem = target - current;
        if (Math.abs(finalRem) <= tol) {
          return { ok: true, reason: "within_tolerance", steps: batch, final: current, error: finalRem, rows };
        }
        return {
          ok: false,
          reason: "smallest_step_exhausted",
          steps: batch,
          final: current,
          error: finalRem,
          rows
        };
    }
    } else {
      smallestTries = 0;
    }
  }

  const finalErr = target - current;
  render(current);
  return { ok: Math.abs(finalErr) <= tol, reason: "max_steps", steps: rows.length, final: current, error: finalErr, rows };
}

// Back-compat alias
export const moveXTo = (opts) => moveTo({ axisLabel: "x", ...opts });
