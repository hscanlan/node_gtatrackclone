// moveToTest.js
// Simpler "two-phase" mover:
//   1) Move to the integer part of target using only whole-number steps (>= 1).
//   2) Finish to exact target using only decimal steps (< 1).
//
// Assumptions:
// - You have helpers: tapName, keyDownName, keyUpName, readCurrent, sleep
// - Calibration items: { target: number, ms: number, heldKey: string|"-" }
// - Steps are "distance per ms calibration": we just multiply ms * repeats per step picked.

import { tapName, keyDownName, keyUpName } from "./helpers/keys.js";
import { readCurrent } from "./helpers/utils.js";
import { sleep } from "./helpers/sleep.js";

/* ----------------------------- Utilities ---------------------------------- */

function buildPlan(calibration) {
  // Normalize & sort (largest → smallest)
  return calibration
    .map((c) => ({
      step: Number(c.target),
      ms: Number(c.ms),
      heldKey: c.heldKey ?? "-",
    }))
    .filter((p) => isFinite(p.step) && p.step > 0 && isFinite(p.ms) && p.ms > 0)
    .sort((a, b) => b.step - a.step);
}

function splitWholeVsDecimal(plan) {
  return {
    whole: plan.filter((p) => p.step >= 1),
    frac: plan.filter((p) => p.step < 1),
  };
}

// Direction keys you pass in; default is LR for 1D axis
const DEFAULT_DIR_KEYS = { positive: "DPAD_RIGHT", negative: "DPAD_LEFT" };

/**
 * Execute one aggregated segment for a given heldKey.
 * If heldKey is "-" -> just tap; otherwise press, tap, release.
 */
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
 * Greedy aggregator over a plan (already filtered to whole or frac),
 * selecting from largest → smallest. Returns grouped segments by heldKey
 * so each heldKey is pressed once. Stops when cap is covered or no step fits.
 *
 * NOTE: If exact coverage is needed (e.g., to hit an integer), pass exact=true.
 * If exact=true and we have step=1 available, we will exactly hit cap.
 * If step=1 does not exist, we'll get as close as possible without exceeding cap.
 */
function aggregateGreedy(cap, subPlan, { exact = false } = {}) {
  if (cap <= 0 || subPlan.length === 0) return { segments: [], covered: 0, exactHit: cap === 0 };

  let covered = 0;
  const picks = []; // linear sequence of picks

  for (const p of subPlan) {
    if (covered >= cap) break;
    const remaining = cap - covered;
    const repeats = Math.floor(remaining / p.step);
    if (repeats <= 0) continue;
    picks.push({ heldKey: p.heldKey ?? "-", step: p.step, repeats, msEach: p.ms });
    covered += repeats * p.step;
  }

  // Try to top off exactly if requested and we have step=1 (or any step that fits the residual exactly)
  if (exact && covered < cap) {
    const residual = cap - covered;
    // Look for a step that divides residual exactly
    const exactStep = subPlan.find((p) => Math.abs(residual / p.step - Math.round(residual / p.step)) < 1e-12);
    if (exactStep) {
      const repeats = Math.round(residual / exactStep.step);
      if (repeats > 0) {
        picks.push({ heldKey: exactStep.heldKey ?? "-", step: exactStep.step, repeats, msEach: exactStep.ms });
        covered += repeats * exactStep.step;
      }
    }
  }

  // Group adjacent by heldKey for one press/tap/release per held
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
    exactHit: Math.abs(covered - cap) < 1e-12, // boolean
  };
}

/* --------------------------- Phase runners -------------------------------- */

/**
 * Phase 1: Move to the integer part of target using ONLY whole-number steps (>=1).
 * - Integer target is trunc(target) (toward zero): eg -1235.324 -> -1235;  1235.324 -> 1235
 * - Tries to hit integer EXACTLY (exact=true) if possible.
 * - If exact coverage can't be achieved (no step=1), it gets as close as possible (< 1 away).
 */
async function moveToIntegerPart({
  target,
  current,
  planWhole,
  dirKeys = DEFAULT_DIR_KEYS,
  lead = 20,
  tail = 10,
  region,
}) {
  const targetInt = target < 0 ? Math.ceil(target) : Math.floor(target); // trunc toward 0
  let now = current;

  // If already at the integer, nothing to do.
  if (Math.trunc(now) === targetInt && Math.abs(now - targetInt) < 1) {
    return { current: now, reachedInt: true };
  }

  // We always move in the direction of (targetInt - now)
  // BUT we only allow steps >=1.
  const maxCycles = 8; // safety
  for (let i = 0; i < maxCycles; i++) {
    const remaining = targetInt - now;
    const absCap = Math.abs(remaining);

    if (absCap < 1e-12) {
      return { current: now, reachedInt: true };
    }

    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;

    // Build an aggregate across whole steps only, aim for exact hit if possible.
    const agg = aggregateGreedy(absCap, planWhole, { exact: true });

    if (!agg.segments.length) {
      // Nothing fits (no >=1 steps) — cannot proceed with whole steps.
      return { current: now, reachedInt: Math.trunc(now) === targetInt };
    }

    // Execute each segment
    for (const seg of agg.segments) {
      await execSegment(dirKey, seg.heldKey, seg.msTotal, lead, tail);
    }

    // Read position and loop again if needed
    now = Number(await readCurrent(region));

    // If we got within < 1 of the integer but not exact (because plan/gcd), we still finish phase.
    if (Math.abs(now - targetInt) < 1) {
      // Stop Phase 1 here; decimals will finish.
      return { current: now, reachedInt: Math.abs(now - targetInt) < 1e-9 };
    }
  }

  // Failsafe return
  return { current: Number(await readCurrent(region)), reachedInt: Math.trunc(current) === (target < 0 ? Math.ceil(target) : Math.floor(target)) };
}

/**
 * Phase 2: Finish with decimals ONLY (<1 steps), never switching back to wholes.
 * - Works in the direction of (target - current) each loop.
 * - Greedy on fractional plan; breaks when within absTol.
 * - If we overshoot within this phase, we still only use fractional steps to correct.
 */
async function finishWithDecimals({
  target,
  current,
  planFrac,
  dirKeys = DEFAULT_DIR_KEYS,
  absTol = 0.0005,   // default finishing tolerance
  maxIters = 200,
  lead = 15,
  tail = 8,
  region,
}) {
  let now = current;

  for (let i = 0; i < maxIters; i++) {
    const remaining = target - now;
    const absCap = Math.abs(remaining);

    if (absCap <= absTol) break;

    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;

    // Aggregate using only fractional steps (<1)
    const agg = aggregateGreedy(absCap, planFrac, { exact: false });
    if (!agg.segments.length) {
      // No fractional step fits the remaining (tiny) distance. Nudge with smallest fractional once.
      const smallest = planFrac[planFrac.length - 1];
      if (!smallest) break;
      await execSegment(dirKey, smallest.heldKey ?? "-", Math.max(1, Math.round(smallest.ms)), lead, tail);
    } else {
      for (const seg of agg.segments) {
        await execSegment(dirKey, seg.heldKey, seg.msTotal, lead, tail);
      }
    }

    now = Number(await readCurrent(region));
  }

  return { current: now, ok: Math.abs(target - now) <= absTol };
}

/* ------------------------------ Public API -------------------------------- */

/**
 * moveToTest:
 * 1) Go to integer part of target using whole steps only.
 * 2) Finish to exact target using decimal steps only.
 */
export async function moveToTest({
  target,
  calibration,
  dirKeys = DEFAULT_DIR_KEYS,
  region,
  // Optional tuning knobs:
  absTol = 0.0005,
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

  let current = Number(await readCurrent(region));

  // ---------------- Phase 1: to integer part (whole steps only)
  const p1 = await moveToIntegerPart({
    target,
    current,
    planWhole,
    dirKeys,
    lead,
    tail,
    region,
  });
  current = p1.current;

  // ---------------- Phase 2: finish with decimals only
  const p2 = await finishWithDecimals({
    target,
    current,
    planFrac,
    dirKeys,
    absTol,
    lead,
    tail,
    region,
  });

  const final = p2.current;
  const ok = p2.ok;

  // Simple summary log (optional)
  const tInt = target < 0 ? Math.ceil(target) : Math.floor(target);
  console.log("\n\nmoveToTest summary:");
  console.table([
    { Phase: "Whole→Integer", TargetInteger: tInt, AfterPhase1: Number(p1.current.toFixed(6)), ReachedIntegerExactly: p1.reachedInt },
    { Phase: "Decimal Finish", Target: Number(target.toFixed(6)), Final: Number(final.toFixed(6)), WithinTol: ok },
  ]);

  return {
    ok,
    final,
    target,
    afterPhase1: p1.current,
  };
}
