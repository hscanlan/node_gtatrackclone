// capture-window.js
// Simple cross-platform desktop/monitor screenshot using screenshot-desktop.

import screenshot from "screenshot-desktop";
import sharp from "sharp";

/**
 * Capture the full desktop (primary screen by default).
 * @param {Object} options
 * @param {string} [options.out="desktop.png"]        Output filename
 * @param {number|string} [options.screenIndex]       Monitor index or id (from screenshot.listDisplays())
 * @returns {Promise<{out:string,width:number,height:number,screen?:any}>}
 */
export async function captureDesktop(options = {}) {
  const out = options.out || "desktop.png";

  let screenOpt = undefined;
  if (options.screenIndex !== undefined) {
    const displays = await screenshot.listDisplays();
    if (typeof options.screenIndex === "number") {
      if (!displays[options.screenIndex]) {
        throw new Error(`screenIndex ${options.screenIndex} not found (found ${displays.length} displays)`);
      }
      screenOpt = displays[options.screenIndex].id;
    } else {
      const found = displays.find(d => String(d.id) === String(options.screenIndex));
      if (!found) throw new Error(`Display id "${options.screenIndex}" not found`);
      screenOpt = found.id;
    }
  }

  const img = await screenshot({ format: "png", ...(screenOpt ? { screen: screenOpt } : {}) });
  const meta = await sharp(img).metadata();
  await sharp(img).toFile(out);

  return { out, width: meta.width || 0, height: meta.height || 0, screen: screenOpt };
}

/**
 * Capture a region of the desktop.
 * @param {Object} options
 * @param {string} [options.out="region.png"]   Output filename
 * @param {{left:number,top:number,width:number,height:number}} options.region  Crop rectangle
 * @param {number|string} [options.screenIndex] Monitor index/id
 * @returns {Promise<{out:string,width:number,height:number,region:any,screen?:any}>}
 */
export async function captureRegion(options = {}) {
  if (!options.region) throw new Error("options.region is required for captureRegion()");

  const out = options.out || "region.png";
  let screenOpt = undefined;
  if (options.screenIndex !== undefined) {
    const displays = await screenshot.listDisplays();
    if (typeof options.screenIndex === "number") {
      if (!displays[options.screenIndex]) {
        throw new Error(`screenIndex ${options.screenIndex} not found`);
      }
      screenOpt = displays[options.screenIndex].id;
    } else {
      const found = displays.find(d => String(d.id) === String(options.screenIndex));
      if (!found) throw new Error(`Display id "${options.screenIndex}" not found`);
      screenOpt = found.id;
    }
  }

  const img = await screenshot({ format: "png", ...(screenOpt ? { screen: screenOpt } : {}) });
  const meta = await sharp(img).metadata();

  const { left, top, width, height } = options.region;
  const crop = {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.min(width, (meta.width || 0) - left),
    height: Math.min(height, (meta.height || 0) - top)
  };

  await sharp(img).extract(crop).toFile(out);
  return { out, width: crop.width, height: crop.height, region: crop, screen: screenOpt };
}


/* ---------- CLI mode ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Usage:
  // node capture-window.js <outfile> <monitorIndex> [left top width height]
  //
  // Examples:
  //   node capture-window.js monitor0.png 0
  //   node capture-window.js crop.png 1 200 150 800 600

  (async () => {
    const out = process.argv[2] || "screenshot.png";
    const monitorIndex = process.argv[3] !== undefined ? Number(process.argv[3]) : 0;

    let region = undefined;
    if (process.argv.length >= 8) {
      region = {
        left: Number(process.argv[4]),
        top: Number(process.argv[5]),
        width: Number(process.argv[6]),
        height: Number(process.argv[7]),
      };
    }

    try {
      let result;
      if (region) {
        result = await captureRegion({ out, screenIndex: monitorIndex, region });
      } else {
        result = await captureDesktop({ out, screenIndex: monitorIndex });
      }
      console.log("Saved:", result);
    } catch (err) {
      console.error("Error:", err.message || err);
      process.exit(1);
    }
  })();
}