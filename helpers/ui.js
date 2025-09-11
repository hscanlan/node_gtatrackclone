// helpers/ui.js

// ---------- ANSI + formatting helpers ----------
export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  fg: {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
  },
};

export function pad(str, width) {
  str = String(str);
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

export function f6(n) {
  return Number(n).toFixed(6);
}

/**
 * Creates a render function bound to a specific target/tol/axis.
 * Keeps its own reference to totalMsTapped (passed by ref).
 */
export function createRenderer({ target, tol, axisLabel, totalMsRef, ui }) {
  return (val) => {
    if (!ui?.live) return;

    const remaining = target - val;
    const absRem = Math.abs(remaining);

    // Colour remaining by closeness to tolerance
    let remColor = ANSI.fg.red;
    if (absRem <= tol) remColor = ANSI.fg.green;
    else if (absRem <= tol * 10) remColor = ANSI.fg.yellow;

    const sign = remaining === 0 ? "" : remaining > 0 ? "+" : "";

    const LBL = ANSI.dim;
    const B = ANSI.bold;
    const R = ANSI.reset;

    const line =
      `${B}${axisLabel.toUpperCase()}${R}  ` +
      `${LBL}Target:${R} ${ANSI.fg.cyan}${pad(f6(target), 12)}${R}  ` +
      `${LBL}Current:${R} ${ANSI.fg.yellow}${pad(f6(val), 12)}${R}  ` +
      `${LBL}Remaining:${R} ${remColor}${pad(sign + f6(remaining), 12)}${R}  ` +
      `${LBL}Tol:${R} ${pad(tol.toExponential(2), 10)}  ` +
      `${LBL}Total ms:${R} ${ANSI.fg.magenta}${pad(totalMsRef.value, 8)}${R}`;

    process.stdout.write("\r" + line);
  };
}
