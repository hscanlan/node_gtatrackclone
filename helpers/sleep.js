// sleep.js
import { keyUpName } from "./keys.js";

// ----- Singleton AbortController -----
const GKEY = "__sleep_singleton__";
const S = (globalThis[GKEY] ??= (() => {
  const ac = new AbortController();
  return {
    controller: ac,
    signal: ac.signal,
    wired: false,
  };
})());

function _abort(reason = "User requested quit") {
  if (!S.signal.aborted) {
    console.log(`\n⏹  ${reason}`);

    // Release all held keys
    keyUpName("CROSS");
    keyUpName("CIRCLE");
    keyUpName("SQUARE");
    keyUpName("TRIANGLE");
    keyUpName("DPAD_UP");
    keyUpName("DPAD_DOWN");
    keyUpName("DPAD_LEFT");
    keyUpName("DPAD_RIGHT");
    keyUpName("L1");
    keyUpName("L2");
    keyUpName("R1");
    keyUpName("R2");

    S.controller.abort();

    // exit immediately
    process.exit(0);
  }
}

export function requestAbort(reason = "User requested quit") {
  _abort(reason);
}

export function globalSignal() {
  return S.signal;
}

// ----- Auto-wire abort listeners (idempotent) -----
if (!S.wired) {
  S.wired = true;

  // Ensure Ctrl-C triggers our full abort cleanup
  process.on("SIGINT", () => _abort("SIGINT (Ctrl-C)"));
}

// ----- Sleep -----
export function sleep(ms, { signal } = {}) {
  const signals = [S.signal, signal].filter(Boolean);

  const composed =
    typeof AbortSignal?.any === "function" && signals.length > 0
      ? AbortSignal.any(signals)
      : signals[0];

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      composed?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      composed?.removeEventListener?.("abort", onAbort);
      // Run cleanup
      _abort("Aborted during sleep");
    };

    if (composed) {
      if (composed.aborted) return onAbort();
      composed.addEventListener("abort", onAbort, { once: true });
    }
  });
}
