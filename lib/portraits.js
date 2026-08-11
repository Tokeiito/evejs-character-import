"use strict";

/**
 * Download Tranquility character portrait JPEGs and store them for the local
 * image server under generated/Character/{localCharId}_{size}.jpg
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { ensureDir, writeJson, readJson } = require("./config");
const { REPO_ROOT, DEFAULT_DUMP_ROOT } = require("./paths");

const CHARACTER_PORTRAIT_SIZES = Object.freeze([32, 64, 128, 256, 512, 1024]);
/** Legacy host-tree path (bind-mounted or used by older EveJS). */
const CHARACTER_ROOT = path.join(
  REPO_ROOT,
  "server",
  "src",
  "_secondary",
  "image",
  "generated",
  "Character",
);

/**
 * EveJS 0.12.5+ runtime path: portraits live beside gamestore on the Docker
 * volume (or _local/gameStore natively). Prefer writing here so character
 * select works without relying only on a source-tree bind mount.
 */
function resolveRuntimeCharacterRoots() {
  const roots = [CHARACTER_ROOT];
  const envData = process.env.EVEJS_GAMESTORE_DATA_DIR;
  if (envData) {
    roots.push(path.join(path.resolve(envData), "..", "images", "Character"));
  }
  const localRuntime = path.join(
    REPO_ROOT,
    "_local",
    "gameStore",
    "images",
    "Character",
  );
  if (!roots.includes(localRuntime)) {
    roots.push(localRuntime);
  }
  // De-dupe resolved paths
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

const USER_AGENT = "evejs-character-import/1.0 (local portrait helper)";

function toPositiveInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function downloadBuffer(urlString) {
  return new Promise((resolve, reject) => {
    const request = (url, redirectsLeft) => {
      https
        .get(
          url,
          {
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "image/jpeg,image/*;q=0.8,*/*;q=0.5",
            },
          },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location &&
              redirectsLeft > 0
            ) {
              const next = new URL(res.headers.location, url).toString();
              res.resume();
              request(next, redirectsLeft - 1);
              return;
            }
            if (res.statusCode !== 200) {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                reject(
                  new Error(
                    `HTTP ${res.statusCode} for ${url}: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`,
                  ),
                );
              });
              return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          },
        )
        .on("error", reject);
    };
    request(urlString, 5);
  });
}

function portraitUrl(tqCharacterID, size) {
  return `https://images.evetech.net/characters/${tqCharacterID}/portrait?tenant=tranquility&size=${size}`;
}

function storePortraitFiles(localCharacterID, size, bytes) {
  const name = `${localCharacterID}_${size}.jpg`;
  const roots = resolveRuntimeCharacterRoots();
  let primary = null;
  for (const root of roots) {
    try {
      ensureDir(root);
      const filePath = path.join(root, name);
      fs.writeFileSync(filePath, bytes);
      if (!primary) primary = filePath;
    } catch (error) {
      // Volume path may not be writable from the host without docker; legacy path is enough with bind-mount.
    }
  }
  if (!primary) {
    ensureDir(CHARACTER_ROOT);
    primary = path.join(CHARACTER_ROOT, name);
    fs.writeFileSync(primary, bytes);
  }
  return primary;
}

/**
 * Copy host legacy portraits into a Docker named volume (0.12.5 runtime layout).
 * Call after portraits when the game DB lives in Docker.
 */
function syncPortraitsIntoDockerVolume(volumeName) {
  const { spawnSync } = require("child_process");
  if (!volumeName || !fs.existsSync(CHARACTER_ROOT)) {
    return { ok: false, error: "missing volume name or legacy portrait dir" };
  }
  const files = fs.readdirSync(CHARACTER_ROOT).filter((f) => /\.(jpg|png)$/i.test(f));
  if (!files.length) {
    return { ok: false, error: "no portrait files in legacy Character dir" };
  }
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${volumeName}:/data`,
      "-v",
      `${CHARACTER_ROOT}:/portraits:ro`,
      "alpine",
      "sh",
      "-c",
      "mkdir -p /data/gameStore/images/Character && cp -a /portraits/. /data/gameStore/images/Character/ && find /data/gameStore/images/Character -type f | wc -l",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || "docker failed").trim(),
    };
  }
  return { ok: true, count: String(result.stdout || "").trim() };
}

/**
 * Fetch all standard sizes for one character.
 * Falls back: if a size fails, reuse the largest successful JPEG.
 */
/**
 * After files are on disk, mark the character so character select loads the
 * image-server JPEG instead of the stock "hi" / bloodline placeholder.
 * paperDollState: 0 = NoRecustomization (client will request portrait).
 * paperDollState: 2 = NoExistingCustomization (client skips image server).
 */
function markCharacterPortraitReady(sqlitePath, localCharacterID) {
  const pathMod = require("path");
  let Database;
  try {
    Database = require(pathMod.join(
      REPO_ROOT,
      "server",
      "node_modules",
      "better-sqlite3",
    ));
  } catch (_) {
    Database = require("better-sqlite3");
  }
  const db = new Database(sqlitePath);
  const row = db
    .prepare("SELECT json FROM characters WHERE key = ?")
    .get(String(localCharacterID));
  if (!row) {
    db.close();
    return false;
  }
  const rec = JSON.parse(row.json);
  rec.paperDollState = 0;
  if (!rec.portraitInfo || typeof rec.portraitInfo !== "object") {
    rec.portraitInfo = {
      browLeftCurl: 0,
      browLeftTighten: 0,
      browLeftUpDown: 0.5,
      browRightCurl: 0.5,
      browRightTighten: 0,
      browRightUpDown: 0.5,
      eyeClose: 0,
      eyesLookHorizontal: 0.5,
      eyesLookVertical: 0.5,
      frownLeft: 0,
      frownRight: 0,
      headLookTargetX: 0,
      headLookTargetY: 1.5,
      headLookTargetZ: 1,
      headTilt: 0,
      jawSideways: 0.5,
      jawUp: 0.5,
      orientChar: 0,
      puckerLips: 0,
      smileLeft: 0,
      smileRight: 0,
      squintLeft: 0,
      squintRight: 0,
      cameraFieldOfView: 0.3,
      cameraPoiX: 0,
      cameraPoiY: 1.5,
      cameraPoiZ: 0,
      cameraX: 0,
      cameraY: 1.5,
      cameraZ: 1.5,
      backgroundID: 1,
      lightColorID: null,
      lightID: null,
      lightIntensity: null,
      renderStatus: 0,
      paperdollState: 0,
      portraitPoseNumber: 0,
    };
  } else {
    rec.portraitInfo.paperdollState = 0;
  }
  rec.portraitUploadedAt = new Date().toISOString();
  rec.portraitSizes = CHARACTER_PORTRAIT_SIZES.slice();
  db.prepare("UPDATE characters SET json = ? WHERE key = ?").run(
    JSON.stringify(rec),
    String(localCharacterID),
  );
  db.close();
  return true;
}

async function fetchAndStoreCharacterPortraits(localCharacterID, tqCharacterID) {
  const localID = toPositiveInt(localCharacterID, 0);
  const tqID = toPositiveInt(tqCharacterID, 0);
  if (localID <= 0 || tqID <= 0) {
    return { ok: false, error: "invalid ids", files: [] };
  }

  const files = [];
  let lastGood = null;
  const errors = [];

  // Prefer largest first so fallbacks look better if a small size 404s.
  const sizesDesc = [...CHARACTER_PORTRAIT_SIZES].sort((a, b) => b - a);
  const bySize = new Map();

  for (const size of sizesDesc) {
    try {
      const bytes = await downloadBuffer(portraitUrl(tqID, size));
      if (!bytes || bytes.length < 100) {
        throw new Error("empty or tiny response");
      }
      bySize.set(size, bytes);
      lastGood = bytes;
    } catch (error) {
      errors.push({ size, error: String(error.message || error) });
    }
  }

  if (!lastGood) {
    return { ok: false, error: "all sizes failed", errors, files: [] };
  }

  for (const size of CHARACTER_PORTRAIT_SIZES) {
    const bytes = bySize.get(size) || lastGood;
    const filePath = storePortraitFiles(localID, size, bytes);
    files.push(filePath);
  }

  return {
    ok: true,
    localCharacterID: localID,
    tqCharacterID: tqID,
    files,
    errors,
  };
}

/**
 * Build mapping localCharID -> tqCharacterID from dump + live DB accounts,
 * or from character records that still carry tqImport.sourceCharacterID.
 */
function loadMappingsFromBundle(bundlePath) {
  const bundle = readJson(bundlePath, null);
  if (!bundle) return [];
  // Bundle only has original (TQ) IDs; local IDs are assigned at import.
  // Caller should pair with DB rows via characterName when possible.
  const out = [];
  for (const acct of bundle.accounts || []) {
    for (const ch of acct.characters || []) {
      out.push({
        characterName: ch.characterName,
        tqCharacterID: toPositiveInt(ch.originalCharacterID, 0),
      });
    }
  }
  return out;
}

function loadMappingsFromDump(dumpRoot) {
  const abs = path.resolve(dumpRoot);
  const account = readJson(path.join(abs, "account.json"), null);
  const mappings = [];
  const charactersRoot = path.join(abs, "characters");
  if (!fs.existsSync(charactersRoot)) {
    return { username: account && account.username, mappings };
  }
  for (const entry of fs.readdirSync(charactersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(charactersRoot, entry.name);
    const meta = readJson(path.join(dir, "_meta.json"), {});
    const pub = readJson(path.join(dir, "public.json"), {});
    const data = pub && pub.data ? pub.data : {};
    const tqID =
      toPositiveInt(meta.characterID, 0) ||
      toPositiveInt(entry.name.split("_")[0], 0);
    mappings.push({
      characterName: data.name || entry.name,
      tqCharacterID: tqID,
    });
  }
  return { username: account && account.username, mappings };
}

/**
 * Pair TQ identities with local character rows by name (case-insensitive).
 */
function pairByName(localCharacters, tqMappings) {
  const byName = new Map();
  for (const m of tqMappings) {
    if (!m.characterName || !m.tqCharacterID) continue;
    byName.set(String(m.characterName).toLowerCase(), m.tqCharacterID);
  }
  const pairs = [];
  for (const local of localCharacters) {
    const tq = byName.get(String(local.characterName || "").toLowerCase());
    if (tq) {
      pairs.push({
        localCharacterID: local.characterID,
        tqCharacterID: tq,
        characterName: local.characterName,
      });
    } else if (local.sourceCharacterID) {
      pairs.push({
        localCharacterID: local.characterID,
        tqCharacterID: local.sourceCharacterID,
        characterName: local.characterName,
      });
    }
  }
  return pairs;
}

/**
 * EVE client caches portraits under cache/Pictures/Characters/{id}_{size}.jpg.
 * If the stock hi.jpg was cached before real portraits existed, character select
 * keeps showing it until those files are replaced.
 */
function seedClientPortraitCache(localCharacterIDs, options = {}) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    return { cacheDirs: [], files: [] };
  }
  const candidates = [];
  if (options.cacheDir) {
    candidates.push(options.cacheDir);
  }
  // Wine/Proton prefixes used by this machine's evejs launchers
  const prefixRoots = [
    path.join(home, "evejs-prefix", "pfx", "drive_c", "users"),
    path.join(home, "Games"),
  ];
  for (const root of prefixRoots) {
    if (!fs.existsSync(root)) continue;
    // Walk shallow for .../cache/Pictures/Characters
    const stack = [root];
    let steps = 0;
    while (stack.length && steps < 5000) {
      steps += 1;
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const full = path.join(dir, ent.name);
        if (ent.name === "Characters" && dir.endsWith(`${path.sep}Pictures`)) {
          candidates.push(full);
        } else if (
          ent.name === "cache" ||
          ent.name === "Pictures" ||
          ent.name === "CCP" ||
          ent.name === "EVE" ||
          ent.name === "steamuser" ||
          ent.name === "AppData" ||
          ent.name === "Local" ||
          ent.name.startsWith("z_") ||
          ent.name.includes("3396210") ||
          ent.name.includes("tq")
        ) {
          stack.push(full);
        }
      }
    }
  }

  const uniqueDirs = [...new Set(candidates.filter((d) => fs.existsSync(d)))];
  const ids = (localCharacterIDs || [])
    .map((id) => toPositiveInt(id, 0))
    .filter((id) => id > 0);
  const seeded = [];
  for (const cacheDir of uniqueDirs) {
    for (const id of ids) {
      for (const size of CHARACTER_PORTRAIT_SIZES) {
        const src = path.join(CHARACTER_ROOT, `${id}_${size}.jpg`);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(cacheDir, `${id}_${size}.jpg`);
        fs.copyFileSync(src, dest);
        seeded.push(dest);
      }
    }
  }
  return { cacheDirs: uniqueDirs, files: seeded };
}

module.exports = {
  CHARACTER_PORTRAIT_SIZES,
  CHARACTER_ROOT,
  resolveRuntimeCharacterRoots,
  syncPortraitsIntoDockerVolume,
  fetchAndStoreCharacterPortraits,
  markCharacterPortraitReady,
  seedClientPortraitCache,
  loadMappingsFromBundle,
  loadMappingsFromDump,
  pairByName,
  portraitUrl,
  downloadBuffer,
};
