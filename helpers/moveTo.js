// helpers/moveTo.js
import { tapName, keyDownName, keyUpName, repeat } from "./keys.js";
import { readCurrent } from "./utils.js";
import { sleep } from "./sleep.js";

/**
 * Press using calibration. If repeats > 1, hold once and long-press (ms * repeats).
 */
export async function applyCalibratedBatch(
  dirKey,
  entry,
  repeats,
  lead = 30,
  tail = 10
) {
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
    map.push({
      step,
      ms: Number(r.ms),
      heldKey: r.heldKey ?? r.HeldKey ?? "-",
    });
  }
  // Largest -> smallest
  map.sort((a, b) => b.step - a.step);
  return map;
}

function effectiveFinalTolerance(target, relPct, absTol) {
  const rel = Math.abs(target) * (relPct ?? 0);
  return Math.max(absTol ?? 0, rel);
}

/* ---------------- conservative aggregate for a single heldKey ---------------- */
function conservativeAggregateForHeldKey(absRem, plan, heldKey, tol) {
  const hk = heldKey ?? "-";
  const sameHK = plan.filter((p) => (p.heldKey ?? "-") === hk);
  if (sameHK.length === 0) return null;

  const cap = Math.max(0, absRem - tol);
  let covered = 0;
  const picks = [];

  for (const p of sameHK) {
    if (covered >= cap) break;
    const maxRepeats = Math.floor((cap - covered) / p.step);
    if (maxRepeats <= 0) continue;
    picks.push({ step: p.step, repeats: maxRepeats, msEach: p.ms });
    covered += maxRepeats * p.step;
  }

  if (picks.length === 0) return null;

  if (covered >= cap && picks.length > 0) {
    const last = picks[picks.length - 1];
    if (last.repeats > 0) {
      covered -= last.step;
      last.repeats -= 1;
      if (last.repeats === 0) picks.pop();
    }
  }

  if (picks.length === 0) return null;

  const msTotal = picks.reduce(
    (s, x) => s + Math.max(1, Math.round(x.msEach * x.repeats)),
    0
  );
  const repeatsTotal = picks.reduce((s, x) => s + x.repeats, 0);
  const stepsUsed = picks.map((x) => x.step);

  return { msTotal, repeatsTotal, stepsUsed };
}

/* ---------------- helpers for picking next group/step ---------------- */
function pickHeldKeyForRemaining(absRem, plan) {
  const item = plan.find((p) => p.step <= absRem);
  return item ? item.heldKey ?? "-" : plan[plan.length - 1].heldKey ?? "-";
}

function pickLargestStepWithinHK(absRem, plan, heldKey, tol) {
  const cap = Math.max(0, absRem - tol);
  const hk = heldKey ?? "-";
  const sameHK = plan.filter((p) => (p.heldKey ?? "-") === hk);
  return sameHK.find((p) => p.step <= cap) || null;
}
/* ---------------------------------------------------------------------- */

/**
 * Move a numeric axis to target using calibrated steps with batching for ALL step sizes.
 */
export async function moveTo({
  target,
  calibration,
  axisLabel = "axis",
  dirKeys = { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" },
  tolerances = { relPct: 0.0, absTol: 0.001 },
  maxSteps = 200,
  smallestMaxTries = 50,
  ui = { live: true },
  lead = 30,
  tail = 10,
  region,
} = {}) {
  if (!Array.isArray(calibration) || calibration.length === 0) {
    throw new Error("moveTo: calibration array is required.");
  }

  const rows = [];
  const plan = toMapByStep(calibration);
  const smallest = plan[plan.length - 1];

  const read = async () => {
    await tapName("DPAD_UP", 150); // confirm
    await sleep(100);
    const output = await readCurrent(region, axisLabel, {
      minConf: 80,
      showConfidence: false,
      debug: false,
      debugOutBase: "test-field",

      // existing
      scale: 2,
      sharpen: false,
      threshold: 0,
      kernel: "cubic",

      // NEW
      brightness: 5.15, // >1 brighter, <1 darker
      contrast: 3.5, // >1 more contrast, <1 less
      gamma: 0.9, // optional, can help OCR on greys
    });

    await tapName("DPAD_DOWN", 150); // confirm
    await sleep(100);

    return output;
  };

  const tol = effectiveFinalTolerance(
    target,
    tolerances.relPct,
    tolerances.absTol
  );

  const MAX_REPEATS_PER_BATCH = 200;

  function render(current) {
    if (!ui?.live) return;
    console.clear();
    console.log(
      `Move ${axisLabel} to ${target} (tol = ${tol}) — current = ${current}\n`
    );
    console.table(rows);
  }

  function chooseStep(absRem) {
    return plan.find((p) => absRem >= p.step) ?? smallest;
  }

  const nextStepOf = (step) => {
    const idx = plan.findIndex((s) => s.step === step);
    const next = plan[idx + 1];
    return next ? next.step : smallest.step;
  };

  let current = await read();
  let smallestTries = 0;

  /* ---------------- PRE-PASS: aggregate → single → re-evaluate ---------------- */
  {
    render(current);
    const MAX_PREPASS_CYCLES = 9;

    for (let cycle = 1; cycle <= MAX_PREPASS_CYCLES; cycle++) {
      const remainingA = target - current;
      const absRemA = Math.abs(remainingA);
      if (absRemA <= tol) break;

      const hk = pickHeldKeyForRemaining(absRemA, plan);

      const agg = conservativeAggregateForHeldKey(absRemA, plan, hk, tol);
      if (agg && agg.msTotal > 0) {
        const dirKey = remainingA > 0 ? dirKeys.positive : dirKeys.negative;
        const before = current;

        if (hk && hk !== "-") {
          await keyDownName(hk);
          if (lead > 0) await sleep(lead);
          try {
            await tapName(dirKey, agg.msTotal);
          } finally {
            if (tail > 0) await sleep(tail);
            await keyUpName(hk);
          }
        } else {
          await tapName(dirKey, agg.msTotal);
        }

        const after = await read();
        const delta = after - before;

        rows.push({
          Batch: 0,
          Phase: "AGG",
          HeldKey: hk ?? "-",
          Dir: dirKey,
          StepSize: `~${agg.stepsUsed.join(",")}`,
          Repeats: agg.repeatsTotal,
          msEach: "(agg)",
          msTotal: agg.msTotal,
          Before: Number(before.toFixed(6)),
          After: Number(after.toFixed(6)),
          Delta: Number(delta.toFixed(6)),
          Remaining: Number((target - after).toFixed(6)),
        });

        current = after;
        render(current);
      }

      const remainingB = target - current;
      const absRemB = Math.abs(remainingB);
      if (absRemB <= tol) break;

      const singleEntry = pickLargestStepWithinHK(absRemB, plan, hk, tol);
      if (singleEntry) {
        const dirKey = remainingB > 0 ? dirKeys.positive : dirKeys.negative;
        const before = current;
        const msTotal = await applyCalibratedBatch(
          dirKey,
          singleEntry,
          1,
          lead,
          tail
        );
        const after = await read();
        const delta = after - before;

        rows.push({
          Batch: 0,
          Phase: "SINGLE",
          HeldKey: hk ?? "-",
          Dir: dirKey,
          StepSize: singleEntry.step,
          Repeats: 1,
          msEach: singleEntry.ms,
          msTotal,
          Before: Number(before.toFixed(6)),
          After: Number(after.toFixed(6)),
          Delta: Number(delta.toFixed(6)),
          Remaining: Number((target - after).toFixed(6)),
        });

        current = after;
        render(current);
      }

      if ((!agg || agg.msTotal <= 0) && !singleEntry) break;
    }
  }
  /* -------------------------------------------------------------------------- */

  for (let batch = 1; batch <= maxSteps; batch++) {
    render(current);
    const remaining = target - current;
    const absRem = Math.abs(remaining);
    if (absRem <= tol) {
      render(current);
      return {
        ok: true,
        reason: "within_tolerance",
        steps: batch - 1,
        final: current,
        error: remaining,
        rows,
      };
    }

    let chosen = chooseStep(absRem);
    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;

    const isSmallest = chosen.step === smallest.step;
    const nextSmaller = isSmallest ? smallest.step : nextStepOf(chosen.step);
    const safety = isSmallest
      ? Math.max(tol, smallest.step * 0.5)
      : Math.max(nextSmaller * 0.5, tol);

    let repeats = Math.floor((absRem - safety) / chosen.step);
    if (!Number.isFinite(repeats) || repeats < 1) repeats = 1;
    repeats = Math.min(repeats, MAX_REPEATS_PER_BATCH);

    const msTotal = await applyCalibratedBatch(
      dirKey,
      chosen,
      repeats,
      lead,
      tail
    );

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
      smallestTries += repeats;
      if (smallestTries >= smallestMaxTries) {
        const finalRem = target - current;
        if (Math.abs(finalRem) <= tol) {
          return {
            ok: true,
            reason: "within_tolerance",
            steps: batch,
            final: current,
            error: finalRem,
            rows,
          };
        }
        return {
          ok: false,
          reason: "smallest_step_exhausted",
          steps: batch,
          final: current,
          error: finalRem,
          rows,
        };
      }
    } else {
      smallestTries = 0;
    }
  }

  const finalErr = target - current;
  render(current);
  return {
    ok: Math.abs(finalErr) <= tol,
    reason: "max_steps",
    steps: rows.length,
    final: current,
    error: finalErr,
    rows,
  };
}

// Back-compat alias
export const moveXTo = (opts) => moveTo({ axisLabel: "x", ...opts });
