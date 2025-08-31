import fs from "fs/promises";

// ----------------------------
// Utility
// ----------------------------
function resolve(val, ctx) {
  if (typeof val === "string" && val in ctx) return ctx[val];
  return val;
}

// ----------------------------
// Command Handlers
// ----------------------------
// NOTE: your real implementations of these helpers
// (repeat, tapName, keyDownName, keyUpName, sleep,
// captureRegion, extractText, moveAxis, moveRotationSmart)
// must be imported or defined somewhere accessible.
const handlers = {
  async repeat(step, ctx) {
    await repeat(step.name, resolve(step.times, ctx));
  },
  async tap(step) {
    await tapName(step.name, step.ms ?? 200);
  },
  async keyDown(step) {
    keyDownName(step.name);
  },
  async keyUp(step) {
    keyUpName(step.name);
  },
  async sleep(step) {
    await sleep(step.ms ?? 0);
  },
  async capture(step) {
    await captureRegion({
      out: step.out,
      screenIndex: step.screenIndex ?? 0,
      region: step.region
    });
  },
  async ocr(step, ctx) {
    const txt = await extractText(step.in, step.options ?? {});
    const n = txt.trim() === "" ? NaN : Number(txt);
    ctx[step.assign] = n;
  },
  async moveAxis(step, ctx) {
    const from = resolve(step.from, ctx);
    const to = resolve(step.to, ctx);
    const spd = resolve(step.speed, ctx);
    await moveAxis(from, to, spd, step.axis);
  },
  async moveRotationSmart(step, ctx) {
    const from = resolve(step.from, ctx);
    const to = resolve(step.to, ctx);
    const spd = resolve(step.speed, ctx);
    await moveRotationSmart(from, to, spd, step.axis);
  },
  async log(step) {
    console.log(step.text ?? "");
  },
  async logValue(step, ctx) {
    console.log(ctx[step.var]);
  },
  async set(step, ctx) {
    ctx[step.var] = resolve(step.value, ctx);
  }
};

// ----------------------------
// Run commands for a single model spec
// ----------------------------
async function runModelCommands(spec, initialContext = {}) {
  const ctx = { ...initialContext };

  for (const step of spec.commands) {
    const fn = handlers[step.cmd];
    if (!fn) {
      console.warn(`Unknown cmd: ${step.cmd} — skipping`);
      continue;
    }
    await fn(step, ctx);
  }

  return ctx;
}

// ----------------------------
// Exported API
// ----------------------------
export async function runModelFromFile(jsonPath, modelId, initialContext = {}) {
  const raw = await fs.readFile(jsonPath, "utf-8");
  const models = JSON.parse(raw); // array of models

  const modelSpec = models.find(
    m => m.modelNumber === modelId || m.modelName === modelId
  );

  if (!modelSpec) {
    throw new Error(`Model "${modelId}" not found in ${jsonPath}`);
  }

  console.log(`\n▶ Running model: ${modelSpec.modelName} (${modelSpec.modelNumber})`);

  return await runModelCommands(modelSpec, initialContext);
}
