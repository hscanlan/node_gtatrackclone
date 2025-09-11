// tests/ocr.js
import { readCurrent } from "../helpers/utils.js";
import { sleep } from "../helpers/sleep.js";
import { tapName } from "../helpers/keys.js";

const TEST_REGION =  { left: 708, top: 168, width: 140, height: 35 };
const AXIS_LABEL = "TEST";

async function main() {
  try {

    await sleep(2000);

    await tapName("DPAD_UP", 100); // confirm
    
    const result = await readCurrent(TEST_REGION, AXIS_LABEL, {
      minConf: 80,
      showConfidence: false,
      debug: true,
      debugOutBase: "test-field",

      // existing
      scale: 2,
      sharpen: false,
      threshold: 0,
      kernel: "cubic",

      // NEW
      brightness: 5.15, // >1 brighter, <1 darker
      contrast: 3.5,    // >1 more contrast, <1 less
      gamma: 0.9,       // optional, can help OCR on greys
    });

    await tapName("DPAD_DOWN", 100); // confirm
   

    console.log("OCR Result:", result);
  } catch (err) {
    console.error("Error reading region:", err);
  }
}

main();
