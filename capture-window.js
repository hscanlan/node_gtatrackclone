// capture-window.js
// Cross-platform desktop/monitor capture using screenshot-desktop.
// LEGACY BEHAVIOUR: If options.out is a non-empty string, save to disk.
// Otherwise, return a PNG Buffer in-memory on the result object.

import screenshot from "screenshot-desktop";
import sharp from "sharp";

function isDebug(out) {
  return !!(out && typeof out === "string" && out.trim().length > 0);
}

/**
 * Capture the full desktop (primary screen by default).
 * @param {Object} options
 * @param {string|null} [options.out]         If provided, save PNG to this path; else keep in memory
 * @param {number|string} [options.screenIndex] Monitor index or display id
 * @returns {Promise<{out:string|null,width:number,height:number,screen?:any,buffer?:Buffer}>}
 */
export async function captureDesktop(options = {}) {
  const out = options.out || null;
  const debug = isDebug(out);

  let screenOpt;
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

  if (debug) {
    await sharp(img).toFile(out);
    return { out, width: meta.width || 0, height: meta.height || 0, screen: screenOpt };
  } else {
    return { out: null, width: meta.width || 0, height: meta.height || 0, screen: screenOpt, buffer: img };
  }
}

/**
 * Capture a region of the desktop.
 * @param {Object} options
 * @param {string|null} [options.out]         If provided, save PNG to this path; else keep in memory
 * @param {{left:number,top:number,width:number,height:number}} options.region
 * @param {number|string} [options.screenIndex]
 * @returns {Promise<{out:string|null,width:number,height:number,region:any,screen?:any,buffer?:Buffer}>}
 */
export async function captureRegion(options = {}) {
  if (!options.region) throw new Error("options.region is required for captureRegion()");
  const out = options.out || null;
  const debug = isDebug(out);

  let screenOpt;
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

  const { left, top, width, height } = options.region;
  const crop = {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.min(width, (meta.width || 0) - left),
    height: Math.min(height, (meta.height || 0) - top),
  };

  if (debug) {
    await sharp(img).extract(crop).toFile(out);
    return { out, width: crop.width, height: crop.height, region: crop, screen: screenOpt };
  } else {
    const buffer = await sharp(img).extract(crop).png().toBuffer();
    return { out: null, width: crop.width, height: crop.height, region: crop, screen: screenOpt, buffer };
  }
}

/* ---------- Optional CLI ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Usage:
  // node capture-window.js <outfile|-> <monitorIndex> [left top width height]
  (async () => {
    const outArg = process.argv[2] || null;
    const out = outArg === "-" ? null : outArg;
    const monitorIndex = process.argv[3] !== undefined ? Number(process.argv[3]) : 0;

    let region;
    if (process.argv.length >= 8) {
      region = {
        left: Number(process.argv[4]),
        top: Number(process.argv[5]),
        width: Number(process.argv[6]),
        height: Number(process.argv[7]),
      };
    }

    try {
      const res = region
        ? await captureRegion({ out, screenIndex: monitorIndex, region })
        : await captureDesktop({ out, screenIndex: monitorIndex });

      if (res.out) {
        console.log("Wrote file:", res.out, { width: res.width, height: res.height, screen: res.screen });
      } else {
        console.log("In-memory result:", {
          width: res.width,
          height: res.height,
          screen: res.screen,
          bufferBytes: res.buffer?.length ?? 0,
        });
      }
    } catch (err) {
      console.error("Error:", err.message || err);
      process.exit(1);
    }
  })();
}
