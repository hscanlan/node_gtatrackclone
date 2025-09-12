// moveToTest.js
// Simple movers with tolerances:
//   - moveWholeOnly: only whole-number steps (>=1) toward integer(target) with wholeTol
//   - moveDecimalsOnly: only decimal steps (<1) toward exact target with fracTol
//   - moveToTest: two-phase (whole→integer within wholeTol, then decimals→exact within fracTol)
//
// Requires helpers: tapName, keyDownName, keyUpName, readCurrent, sleep

import { tapName, keyDownName, keyUpName } from "../helpers/keys.js";
import { readCurrent } from "../helpers/utils.js";
import { sleep } from "../helpers/sleep.js";

/* ----------------------------- Utilities ---------------------------------- */

function buildPlan(calibration) {
  return calibration
    .map((c) => ({
      step: Number(c.target),
      ms: Number(c.ms),
      heldKey: c.heldKey ?? "-",
    }))
    .filter((p) => isFinite(p.step) && p.step > 0 && isFinite(p.ms) && p.ms > 0)
    .sort((a, b) => b.step - a.step); // largest → smallest
}

function splitWholeVsDecimal(plan) {
  return {
    whole: plan.filter((p) => p.step >= 1),
    frac: plan.filter((p) => p.step < 1),
  };
}

const DEFAULT_DIR_KEYS = { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" };

async function execSegment(dirKey, heldKey, msTotal, lead = 20, tail = 10) {
  if (heldKey && heldKey !== "-") {
    await keyDownName(heldKey);
    if (lead > 0) await sleep(lead);
    try {
      await tapName(dirKey, msTotal);
    } finally {
      if (tail > 0) await sleep(tail);
      await keyUpName(heldKey);
    }
  } else {
    await tapName(dirKey, msTotal);
  }
}

/**
 * Greedy aggregator over a (filtered) plan (desc by step).
 * - Picks largest→smallest steps under cap
 * - Groups adjacent picks by heldKey so each held key is pressed once
 * - If exact=true, tries to exactly top off cap by finding a step that divides the residual.
 */
function aggregateGreedy(cap, subPlan, { exact = false } = {}) {
  if (cap <= 0 || subPlan.length === 0) return { segments: [], covered: 0, exactHit: cap === 0 };

  let covered = 0;
  const picks = [];

  for (const p of subPlan) {
    if (covered >= cap) break;
    const remaining = cap - covered;
    const repeats = Math.floor(remaining / p.step);
    if (repeats <= 0) continue;
    picks.push({ heldKey: p.heldKey ?? "-", step: p.step, repeats, msEach: p.ms });
    covered += repeats * p.step;
  }

  if (exact && covered < cap) {
    const residual = cap - covered;
    const exactStep = subPlan.find((p) => Math.abs(residual / p.step - Math.round(residual / p.step)) < 1e-12);
    if (exactStep) {
      const repeats = Math.round(residual / exactStep.step);
      if (repeats > 0) {
        picks.push({ heldKey: exactStep.heldKey ?? "-", step: exactStep.step, repeats, msEach: exactStep.ms });
        covered += repeats * exactStep.step;
      }
    }
  }

  const segments = [];
  for (const pick of picks) {
    const last = segments[segments.length - 1];
    if (last && last.heldKey === pick.heldKey) {
      last.detail.push({ step: pick.step, repeats: pick.repeats, msEach: pick.msEach });
    } else {
      segments.push({
        heldKey: pick.heldKey,
        detail: [{ step: pick.step, repeats: pick.repeats, msEach: pick.msEach }],
      });
    }
  }

  for (const seg of segments) {
    seg.msTotal = seg.detail.reduce(
      (s, d) => s + Math.max(1, Math.round(d.msEach * d.repeats)),
      0
    );
    seg.repeatsTotal = seg.detail.reduce((s, d) => s + d.repeats, 0);
  }

  return {
    segments,
    covered,
    exactHit: Math.abs(covered - cap) < 1e-12,
  };
}

/* --------------------------- Phase runners -------------------------------- */

/**
 * Whole-number phase: drive to integer(target) using steps >= 1.
 * Stops when |now - targetInt| <= wholeTol.
 * Returns the latest on-screen reading so the next phase can reuse it.
 */
async function moveToIntegerPart({
  target,
  current,
  planWhole,
  dirKeys = DEFAULT_DIR_KEYS,
  lead = 20,
  tail = 10,
  region,
  wholeTol = 0.49, // ★ NEW: tolerance for how close to the integer we need to be
}) {
  const targetInt = target < 0 ? Math.ceil(target) : Math.floor(target); // trunc toward 0
  let now = current;

  const maxCycles = 8;
  for (let i = 0; i < maxCycles; i++) {
    const remaining = targetInt - now;
    const absCap = Math.abs(remaining);

    // If we're already within tolerance, stop.
    if (absCap <= wholeTol) {
      return { current: now, reachedInt: true, targetInt };
    }

    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;
    const agg = aggregateGreedy(absCap, planWhole, { exact: true });

    if (!agg.segments.length) {
      // Nothing to do; report whether we're within tolerance.
      return { current: now, reachedInt: Math.abs(now - targetInt) <= wholeTol, targetInt };
    }

    for (const seg of agg.segments) {
      await execSegment(dirKey, seg.heldKey, seg.msTotal, lead, tail);
    }

    // Single capture per loop.
    now = Number(await readCurrent(region));
  }

  return { current: now, reachedInt: Math.abs(now - targetInt) <= wholeTol, targetInt };
}

/**
 * Decimal phase: refine to target using <1 steps.
 * Stops when |target - now| <= fracTol.
 * IMPORTANT: It does NOT capture at the start; it trusts the `current` you pass in.
 * It captures once after executing segments in each iteration.
 */
async function finishWithDecimals({
  target,
  current,          // trusted initial reading passed in from whole phase
  planFrac,
  dirKeys = DEFAULT_DIR_KEYS,
  // Kept for backward compat; prefer fracTol
  absTol,            // deprecated alias
  fracTol = 0.0005,  // ★ NEW: tolerance for fractional finish
  maxIters = 200,
  lead = 15,
  tail = 8,
  region,
}) {
  const tol = Number.isFinite(fracTol) ? fracTol : (Number.isFinite(absTol) ? absTol : 0.0005);
  let now = current;

  for (let i = 0; i < maxIters; i++) {
    const remaining = target - now;
    const absCap = Math.abs(remaining);
    if (absCap <= tol) break;

    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;

    const agg = aggregateGreedy(absCap, planFrac, { exact: false });
    if (!agg.segments.length) {
      const smallest = planFrac[planFrac.length - 1];
      if (!smallest) break;
      await execSegment(dirKey, smallest.heldKey ?? "-", Math.max(1, Math.round(smallest.ms)), lead, tail);
    } else {
      for (const seg of agg.segments) {
        await execSegment(dirKey, seg.heldKey, seg.msTotal, lead, tail);
      }
    }

    // Exactly one capture per iteration (after we move).
    now = Number(await readCurrent(region));
  }

  return { current: now, ok: Math.abs(target - now) <= tol, tol };
}

/* ------------------------------ Public API -------------------------------- */

/** Whole-only test: push using only whole steps (>=1) toward integer(target). */
export async function moveWholeOnly({
  target,
  calibration,
  dirKeys = DEFAULT_DIR_KEYS,
  region,
  lead = 20,
  tail = 10,
  wholeTol = 0.49, // ★ NEW
} = {}) {
  if (!Array.isArray(calibration) || calibration.length === 0) {
    throw new Error("calibration (non-empty array) is required");
  }
  const plan = buildPlan(calibration);
  const { whole: planWhole } = splitWholeVsDecimal(plan);
  if (planWhole.length === 0) throw new Error("No whole-number steps (>=1) in calibration.");

  let current = Number(await readCurrent(region));
  const p1 = await moveToIntegerPart({ target, current, planWhole, dirKeys, lead, tail, region, wholeTol });
  const targetInt = p1.targetInt ?? (target < 0 ? Math.ceil(target) : Math.floor(target));

  console.log("\n\nmoveWholeOnly summary:");
  console.table([
    {
      Phase: "WholeOnly",
      TargetInteger: targetInt,
      Final: Number(p1.current.toFixed(6)),
      WithinWholeTol: p1.reachedInt,
      WholeTol: wholeTol,
    },
  ]);

  return { final: p1.current, afterPhase1: p1.current, targetInt, reachedInt: p1.reachedInt, wholeTol };
}

/**
 * Decimals-only test: from current to target using only decimal steps (<1).
 * If you ALREADY have a fresh reading, pass it in as `initialCurrent` to skip
 * the upfront capture.
 */
export async function moveDecimalsOnly({
  target,
  calibration,
  dirKeys = DEFAULT_DIR_KEYS,
  region,
  fracTol = 0.0005, // ★ NEW
  // kept for compat; if provided and fracTol not set, we'll use this
  absTol,           // deprecated alias
  lead = 15,
  tail = 8,
  initialCurrent = null,
} = {}) {
  if (!Array.isArray(calibration) || calibration.length === 0) {
    throw new Error("calibration (non-empty array) is required");
  }
  const plan = buildPlan(calibration);
  const { frac: planFrac } = splitWholeVsDecimal(plan);
  if (planFrac.length === 0) throw new Error("No decimal steps (<1) in calibration.");

  const startCurrent = (initialCurrent != null && Number.isFinite(initialCurrent))
    ? Number(initialCurrent)
    : Number(await readCurrent(region));

  const p2 = await finishWithDecimals({
    target,
    current: startCurrent,
    planFrac,
    dirKeys,
    fracTol,
    absTol, // legacy
    lead,
    tail,
    region
  });

  console.log("\n\nmoveDecimalsOnly summary:");
  console.table([
    {
      Phase: "DecimalsOnly",
      Target: Number(target.toFixed(6)),
      Final: Number(p2.current.toFixed(6)),
      WithinFracTol: p2.ok,
      FracTol: p2.tol,
    },
  ]);

  return { final: p2.current, ok: p2.ok, target, fracTol: p2.tol };
}

/** Two-phase test: whole→integer (within wholeTol), then decimals→exact (within fracTol).
 *  Reuses the final read from whole-phase as the starting read for decimals.
 */
export async function moveToTest({
  target,
  calibration,
  dirKeys = DEFAULT_DIR_KEYS,
  region,
  wholeTol = 0.49,  // ★ NEW
  fracTol = 0.0005, // ★ NEW
  // kept for compat with older callers
  absTol,           // deprecated alias of fracTol
  lead = 20,
  tail = 10,
} = {}) {
  if (!Array.isArray(calibration) || calibration.length === 0) {
    throw new Error("calibration (non-empty array) is required");
  }

  const plan = buildPlan(calibration);
  const { whole: planWhole, frac: planFrac } = splitWholeVsDecimal(plan);
  if (planWhole.length === 0 && planFrac.length === 0) {
    throw new Error("calibration produced no valid steps");
  }

  // Initial capture once at the very beginning.
  let current = Number(await readCurrent(region));

  // Phase 1: whole numbers to integer(target), within wholeTol
  const p1 = planWhole.length
    ? await moveToIntegerPart({ target, current, planWhole, dirKeys, lead, tail, region, wholeTol })
    : { current, reachedInt: Math.abs((target < 0 ? Math.ceil(target) : Math.floor(target)) - current) <= wholeTol };

  // Reuse the last capture from phase 1 as the starting point for phase 2.
  current = p1.current;

  // Phase 2: decimals to exact target — within fracTol (or absTol if provided)
  const p2 = planFrac.length
    ? await finishWithDecimals({ target, current, planFrac, dirKeys, fracTol, absTol, lead, tail, region })
    : { current, ok: Math.abs(target - current) <= (Number.isFinite(fracTol) ? fracTol : (Number.isFinite(absTol) ? absTol : 0.0005)), tol: Number.isFinite(fracTol) ? fracTol : absTol };

  const final = p2.current;
  const ok = p2.ok;
  const tInt = p1.targetInt ?? (target < 0 ? Math.ceil(target) : Math.floor(target));

  console.log("\n\nmoveToTest summary:");
  console.table([
    { Phase: "Whole→Integer", TargetInteger: tInt, AfterPhase1: Number(p1.current.toFixed(6)), WithinWholeTol: p1.reachedInt, WholeTol: wholeTol },
    { Phase: "Decimal Finish", Target: Number(target.toFixed(6)), Final: Number(final.toFixed(6)), WithinFracTol: ok, FracTol: p2.tol },
  ]);

  return { ok, final, target, afterPhase1: p1.current, wholeTol, fracTol: p2.tol };
}
