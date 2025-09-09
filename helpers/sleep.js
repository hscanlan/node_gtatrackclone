// sleep.js
import { keyUpName } from "./keys.js";

// ----- Singleton AbortController -----
const GKEY = "__sleep_singleton__";
const S = globalThis[GKEY] ??= (() => {
  const ac = new AbortController();
  return {
    controller: ac,
    signal: ac.signal,
    wired: false
  };
})();

function _abort(reason = "User requested quit") {
  if (!S.signal.aborted) {


    console.log(`\n⏹  ${reason}`);

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
    process.exit(0); // <--- exit immediately, success code
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

  // Handle Ctrl-C as signal
  process.on("SIGINT", () => _abort("SIGINT"));

  // Handle Q/q/Ctrl-C on stdin if TTY
  if (process.stdin.isTTY) {
    try {
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
    } catch { /* ignore */ }

    process.stdin.setEncoding("utf8");
    if (!process.stdin.readableFlowing) {
      process.stdin.resume();
    }

    process.stdin.on("data", (chunk) => {
      const s = String(chunk).trim();
      if (s === "\u0003" || s.toLowerCase() === "q") _abort();
    });
  }
}

// ----- Sleep -----
export function sleep(ms, { signal } = {}) {
  const signals = [S.signal, signal].filter(Boolean);

  const composed = (typeof AbortSignal?.any === "function" && signals.length > 0)
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
      // don't reject → just exit
      process.exit(0);
    };

    if (composed) {
      if (composed.aborted) return onAbort();
      composed.addEventListener("abort", onAbort, { once: true });
    }
  });
}
