// helpers/moveTo.js
import { tapName, keyDownName, keyUpName, repeat } from "./keys.js";
import { readCurrent } from "./utils.js";
import { sleep } from "./sleep.js";
import { createRenderer } from "./ui.js";
/**
 * Press using calibration. If repeats > 1, hold once and long-press (ms * repeats).
 * Returns msTotal actually tapped.
 */
export async function applyCalibratedBatch(
  dirKey,
  entry,
  repeats,
  lead = 30,
  tail = 10
) {
  const hold = entry.heldKey && entry.heldKey !== "-" ? entry.heldKey : null;
  const msEach = Math.max(1, Math.round(entry.ms));
  const msTotal = Math.max(1, Math.round(msEach * repeats));

  if (hold) {
    await keyDownName(hold);
    if (lead > 0) await sleep(lead);
    try {
      await tapName(dirKey, msTotal);
    } finally {
      if (tail > 0) await sleep(tail);
      await keyUpName(hold);
    }
  } else {
    await tapName(dirKey, msTotal);
  }

  return msTotal;
}

/* ---------------------------------------------------------------------- */
/* --------------------------- Planning helpers ------------------------- */
/* ---------------------------------------------------------------------- */

/**
 * Normalize + sort calibration into a descending step plan.
 * Each item: { step:number, ms:number, heldKey:string|"-" }
 */
function toMapByStep(calibration) {
  const plan = calibration
    .map((c) => ({
      step: Number(c.target),
      ms: Number(c.ms),
      heldKey: c.heldKey ?? "-",
    }))
    .filter((p) => isFinite(p.step) && p.step > 0 && isFinite(p.ms) && p.ms > 0)
    .sort((a, b) => b.step - a.step); // largest -> smallest
  return plan;
}

/**
 * Pick which heldKey is likely best for the remaining amount:
 * choose the heldKey whose largest step ≤ remaining is itself the largest among peers.
 */
function pickHeldKeyForRemaining(absRem, plan) {
  // Group by heldKey, then find each HK's largest step that fits.
  const byHK = new Map();
  for (const p of plan) {
    const hk = p.heldKey ?? "-";
    if (!byHK.has(hk)) byHK.set(hk, []);
    byHK.get(hk).push(p);
  }
  let bestHK = "-";
  let bestStep = 0;
  for (const [hk, items] of byHK.entries()) {
    const largestFits = items.find((x) => x.step <= absRem); // items sorted desc via plan
    if (largestFits && largestFits.step > bestStep) {
      bestStep = largestFits.step;
      bestHK = hk;
    }
  }
  return bestHK;
}

/**
 * Pick the largest step within a specific heldKey that does not overshoot cap (absRem - tol).
 */
function pickLargestStepWithinHK(absRem, plan, heldKey, tol) {
  const cap = Math.max(0, absRem - tol);
  const hk = heldKey ?? "-";
  const sameHK = plan.filter((p) => (p.heldKey ?? "-") === hk);
  return sameHK.find((p) => p.step <= cap) || null;
}

/**
 * Conservative single-heldKey aggregate: pack repeats of HK-specific steps (desc) up to cap.
 * Returns {picks:[{step,repeats,msEach}], msTotal, repeatsTotal, covered} or null.
 */
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

  const msTotal = picks.reduce(
    (s, d) => s + Math.max(1, Math.round(d.msEach * d.repeats)),
    0
  );
  const repeatsTotal = picks.reduce((s, d) => s + d.repeats, 0);

  return { picks, msTotal, repeatsTotal, covered };
}
/**
 * Aggregate across ALL heldKeys:
 * - First consumes whole number steps (>= 1)
 * - Then consumes fractional steps (< 1)
 * Groups by heldKey so each is pressed once.
 */
function aggregateAllHeldKeys(absRem, plan, tol) {
  const cap = Math.max(0, absRem - tol);
  if (cap <= 0) return null;

  let covered = 0;
  const picks = [];

  // Partition plan into whole steps (>=1) and decimals (<1)
  const wholePlan = plan.filter((p) => p.step >= 1);
  const fracPlan = plan.filter((p) => p.step < 1);

  // Helper to consume a plan in order
  function consumePlan(subPlan) {
    for (const p of subPlan) {
      if (covered >= cap) break;
      const remaining = cap - covered;
      const maxRepeats = Math.floor(remaining / p.step);
      if (maxRepeats <= 0) continue;
      picks.push({
        heldKey: p.heldKey ?? "-",
        step: p.step,
        repeats: maxRepeats,
        msEach: p.ms,
      });
      covered += maxRepeats * p.step;
    }
  }

  // First all whole numbers, then decimals
  consumePlan(wholePlan);
  consumePlan(fracPlan);

  if (picks.length === 0) return null;

  // Group adjacent same-heldKey picks
  const segments = [];
  for (const pick of picks) {
    const hk = pick.heldKey;
    const last = segments[segments.length - 1];
    if (last && last.heldKey === hk) {
      last.detail.push({
        step: pick.step,
        repeats: pick.repeats,
        msEach: pick.msEach,
      });
    } else {
      segments.push({
        heldKey: hk,
        detail: [{ step: pick.step, repeats: pick.repeats, msEach: pick.msEach }],
      });
    }
  }

  // Summaries per segment
  for (const seg of segments) {
    seg.msTotal = seg.detail.reduce(
      (s, d) => s + Math.max(1, Math.round(d.msEach * d.repeats)),
      0
    );
    seg.repeatsTotal = seg.detail.reduce((s, d) => s + d.repeats, 0);
    seg.stepsUsed = seg.detail.map((d) => d.step);
  }

  return { segments, covered };
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
    throw new Error("calibration is required and must be a non-empty array");
  }

  // Plan: largest -> smallest steps across all heldKeys
  const plan = toMapByStep(calibration);
  if (plan.length === 0) {
    throw new Error("calibration produced no valid steps");
  }

  // Tolerance
  const read = async () => {
    const v = await readCurrent(region);
    return Number(v);
  };
  let current = await read();
  const span = Math.max(1, Math.abs(target) || Math.abs(current) || 1);
  const tol = Math.max(
    Number(tolerances?.absTol ?? 0.0),
    (Number(tolerances?.relPct ?? 0.0) / 100.0) * span
  );

  // UI helpers
  const rows = [];
  let batch = 0;
  const render = (val) => {
    if (!ui?.live) return;
    const remaining = target - val;
    const sign = remaining === 0 ? "" : remaining > 0 ? "+" : "";
    process.stdout.write(
      `\r${axisLabel.toUpperCase()}: ` +
        `cur=${val.toFixed(6)} ` +
        `rem=${sign}${remaining.toFixed(6)} ` +
        `tol=${tol.toExponential(2)}     `
    );
  };

  render(current);

  /* ---------------- PRE-PASS: multi-heldKey aggregate → single tune ------------ */
  {
    const MAX_PREPASS_CYCLES = 9;

    for (let cycle = 1; cycle <= MAX_PREPASS_CYCLES; cycle++) {
      // Phase A: aggregate across ALL held keys (largest→smallest)
      const remainingA = target - current;
      const absRemA = Math.abs(remainingA);
      if (absRemA <= tol) break;

      const aggAll = aggregateAllHeldKeys(absRemA, plan, tol);

      if (aggAll && aggAll.segments.length > 0) {
        const dirKey = remainingA > 0 ? dirKeys.positive : dirKeys.negative;
        const before = current;

        for (const seg of aggAll.segments) {
          const hk = seg.heldKey;
          if (hk && hk !== "-") {
            await keyDownName(hk);
            if (lead > 0) await sleep(lead);
            try {
              await tapName(dirKey, seg.msTotal);
            } finally {
              if (tail > 0) await sleep(tail);
              await keyUpName(hk);
            }
          } else {
            await tapName(dirKey, seg.msTotal);
          }

          rows.push({
            Batch: 0,
            Phase: "AGG-ALL",
            HeldKey: hk ?? "-",
            Dir: dirKey,
            StepSize: `~${seg.stepsUsed.join(",")}`,
            Repeats: seg.repeatsTotal,
            msEach: "(agg)",
            msTotal: seg.msTotal,
            Before: null,
            After: null,
            Delta: null,
            Remaining: null,
          });
        }

        const after = await read();
        const delta = after - before;
        const lastIdx = rows.length - 1;
        if (lastIdx >= 0) {
          rows[lastIdx].Before = Number(before.toFixed(6));
          rows[lastIdx].After = Number(after.toFixed(6));
          rows[lastIdx].Delta = Number(delta.toFixed(6));
          rows[lastIdx].Remaining = Number((target - after).toFixed(6));
        }

        current = after;
        render(current);
      }

      // Phase B: one single calibrated step (best HK) to snap closer if needed
      const remainingB = target - current;
      const absRemB = Math.abs(remainingB);
      if (absRemB <= tol) break;

      const hkB = pickHeldKeyForRemaining(absRemB, plan);
      const singleEntry = pickLargestStepWithinHK(absRemB, plan, hkB, tol);

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
          HeldKey: singleEntry.heldKey ?? "-",
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

      if ((!aggAll || aggAll.segments.length === 0) && !singleEntry) {
        // nothing more to do in pre-pass
        break;
      }
    }
  }
  /* -------------------------------------------------------------------------- */

  // MAIN LOOP: fine approach using (largest that fits) repeats each batch
  while (Math.abs(target - current) > tol && rows.length < maxSteps) {
    batch += 1;

    const remaining = target - current;
    const absRem = Math.abs(remaining);
    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;

    // Choose the largest single step that fits across ALL HKs
    const cap = Math.max(0, absRem - tol);
    const chosen =
      plan.find((p) => p.step <= cap) || plan[plan.length - 1]; // fallback smallest

    // Compute repeats but avoid overstepping cap
    const repeats = Math.max(1, Math.floor(cap / chosen.step));
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
  }

  // If still outside tol, try nudging with the smallest step a few times
  let tries = 0;
  while (Math.abs(target - current) > tol && tries < smallestMaxTries) {
    tries++;
    const remaining = target - current;
    const dirKey = remaining > 0 ? dirKeys.positive : dirKeys.negative;
    const smallest = plan[plan.length - 1];

    await applyCalibratedBatch(dirKey, smallest, 1, lead, tail);

    const before = current;
    const after = await read();
    const delta = after - before;

    rows.push({
      Batch: batch,
      Dir: dirKey,
      StepSize: smallest.step,
      Repeats: 1,
      msEach: smallest.ms,
      msTotal: smallest.ms,
      HeldKey: smallest.heldKey ?? "-",
      Before: Number(before.toFixed(6)),
      After: Number(after.toFixed(6)),
      Delta: Number(delta.toFixed(6)),
      Remaining: Number((target - after).toFixed(6)),
    });

    current = after;
    render(current);
  }
  const finalErr = target - current;
  render(current);

  // Pretty-print the execution table
  if (ui?.table !== false) {
    console.log("\n\nExecution Table:");
    console.table(rows);
  }

  return {
    ok: Math.abs(finalErr) <= tol,
    reason: Math.abs(finalErr) <= tol ? "ok" : "max_steps",
    steps: rows.length,
    final: current,
    error: finalErr,
    rows,
  };
}



// Back-compat alias
export const moveXTo = (opts) => moveTo({ axisLabel: "x", ...opts });
