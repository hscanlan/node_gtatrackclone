import robot from "robotjs";
import { sleep } from "../helpers/sleep.js";

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

export async function repeat(name, times, holdMs = 225) {
  for (let i = 0; i < times; i++) {
    await tapName(name, holdMs);
  }
}

export function keyDownName(name) {
//  console.log(name);
  const key = PS_MAP[name.toUpperCase()];
  robot.keyToggle(key, "down");
}
export function keyUpName(name) {
  const key = PS_MAP[name.toUpperCase()];
  robot.keyToggle(key, "up");
}

export function keyDown(key) {
  robot.keyToggle(key, "down");
}

export function keyUp(key) {
  robot.keyToggle(key, "up");
}

// Always releases key even if aborted during hold
export async function tap(key, holdMs = 225) {
//  console.log("tap " + key + " " + holdMs);
  keyDown(key);
  try {
    await sleep(holdMs);
  } finally {
    keyUp(key);
  }
}

export async function tapName(name, holdMs = 225) {
// console.log("tapName " + name + " " + holdMs);
  const key = PS_MAP[name.toUpperCase()];
  if (!key) throw new Error(`Unknown button: ${name}`);
  await tap(key, holdMs);
}
