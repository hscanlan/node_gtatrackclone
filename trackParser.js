// trackParser.mjs
import { readFile } from "fs/promises";

/**
 * Parse a track JSON (file path or object) and return an array of rows where each row
 * combines model[i], loc[i], vRot[i], plus any other arrays in the same root
 * with the same length as model.
 *
 * @param {string|object} source - Path to JSON file OR already-parsed JSON object.
 * @param {{
 *   rootPath?: string,          // dot path to a sub-object, e.g. "mission" or "foo.bar"
 *   modelKey?: string,          // defaults "model" (case-insensitive match supported)
 *   locKey?: string,            // defaults "loc"
 *   rotKey?: string             // defaults "vRot"
 * }} [options]
 * @returns {Promise<Array<Object>>}
 */
export async function parseTrackData(source, options = {}) {
  const {
    rootPath,
    modelKey = "model",
    locKey = "loc",
    rotKey = "vRot",
  } = options;

  // 1) Load JSON
  const data = typeof source === "string"
    ? JSON.parse(await readFile(source, "utf8"))
    : source;

  if (!data || typeof data !== "object") {
    throw new Error("Input is not valid JSON/object.");
  }

  // 2) Resolve explicit root if provided
  let rootObj = data;
  if (rootPath) {
    rootObj = getByDotPath(data, rootPath);
    if (!rootObj) {
      throw new Error(`rootPath "${rootPath}" not found in JSON.`);
    }
  }

  // 3) Try to find a block that has the three arrays
  const keysCI = {
    model: modelKey,
    loc: locKey,
    rot: rotKey,
  };

  const found = findBlockWithCoreArrays(rootObj, keysCI)
             ?? findBlockWithCoreArrays(data, keysCI); // fallback: search whole doc

  if (!found) {
    const tips = collectShapeHints(data, keysCI);
    throw new Error(
      `Could not find required arrays (model, loc, vRot) anywhere in JSON.\n` +
      `Hints:\n${tips}`
    );
  }

  const { node, keyMap, path } = found;
  const model = node[keyMap.model];
  const loc   = node[keyMap.loc];
  const vRot  = node[keyMap.rot];

  // 4) Build rows using the shortest common length
  const len = Math.min(model.length, loc.length, vRot.length);
  const rows = Array.from({ length: len }, (_, i) => {
    const row = {
      model: model[i],
      location: loc[i],
      rotation: vRot[i],
    };

    // Include any sibling arrays with same length as model
    for (const [k, v] of Object.entries(node)) {
      if (k === keyMap.model || k === keyMap.loc || k === keyMap.rot) continue;
      if (Array.isArray(v) && v.length === model.length) {
        row[k] = v[i];
      }
    }
    return row;
  });

  // Optional: you can log where it found the arrays
  // console.log(`Found model/loc/vRot at: ${path.join(".")}`);

  return rows;
}

export default parseTrackData;

/* -------------------- helpers -------------------- */

function getByDotPath(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o && o[k] != null ? o[k] : null), obj);
}

// Case-insensitive key lookup with a few common alias fallbacks
const ALIASES = {
  model: ["model", "models"],
  loc:   ["loc", "location", "locations", "pos", "position", "positions"],
  rot:   ["vRot", "vrot", "rotation", "rotations", "v_rotation", "vrotations"],
};

function findBlockWithCoreArrays(root, keysCI) {
  const visited = new Set();
  const stack = [{ node: root, path: [] }];

  while (stack.length) {
    const { node, path } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    const keyMap = matchCoreKeys(node, keysCI);
    if (keyMap) {
      const { model, loc, rot } = keyMap;
      const m = node[model], l = node[loc], r = node[rot];
      if (isModelArray(m) && isXYZArray(l) && isXYZArray(r)) {
        return { node, keyMap, path };
      }
    }

    // traverse children
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") {
        stack.push({ node: v, path: path.concat(k) });
      }
    }
  }
  return null;
}

function matchCoreKeys(node, keysCI) {
  const nkeys = Object.keys(node);
  const findKey = (wanted, aliases) => {
    const wantedLC = wanted.toLowerCase();
    // exact or case-insensitive match
    let hit = nkeys.find(k => k === wanted || k.toLowerCase() === wantedLC);
    if (hit) return hit;
    // alias fallback
    hit = nkeys.find(k => aliases.some(a => k.toLowerCase() === a.toLowerCase()));
    return hit || null;
  };

  const mKey = findKey(keysCI.model, ALIASES.model);
  const lKey = findKey(keysCI.loc,   ALIASES.loc);
  const rKey = findKey(keysCI.rot,   ALIASES.rot);

  if (mKey && lKey && rKey) {
    return { model: mKey, loc: lKey, rot: rKey };
  }
  return null;
}

function isModelArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every(x => typeof x === "number");
}
function isXYZArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every(
    o => o && typeof o === "object" &&
         ["x","y","z"].every(k => k in o && typeof o[k] === "number")
  );
}

function collectShapeHints(obj, keysCI, limit = 6) {
  const hints = [];
  const visited = new Set();

  const dfs = (node, path) => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    const km = matchCoreKeys(node, keysCI);
    if (km) {
      const m = node[km.model], l = node[km.loc], r = node[km.rot];
      if (Array.isArray(m) || Array.isArray(l) || Array.isArray(r)) {
        hints.push(
          `candidate at "${path.join(".") || "<root>"}" with keys [${Object.keys(node).slice(0,10).join(", ")}]`
        );
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") dfs(v, path.concat(k));
    }
  };
  dfs(obj, []);
  if (hints.length === 0) return "No blocks resembled model/loc/vRot.";
  return hints.slice(0, limit).map(h => `- ${h}`).join("\n");
}
