"use strict";

const fs = require("fs");
const path = require("path");
const { REPO_ROOT } = require("./paths");

const TYPE_TABLE_RELATIVE = path.join("itemTypes", "data.json");

/**
 * Resolve the EveJS SDE-built item type table, most specific source first:
 *   1. explicit path from the caller (--type-data)
 *   2. $EVEJS_GAMESTORE_DATA_DIR/itemTypes/data.json
 *   3. <REPO_ROOT>/_local/gameStore/data/itemTypes/data.json
 *   4. <REPO_ROOT>/server/src/gameStore/data/itemTypes/data.json
 */
function candidateTypeDataPaths(explicitPath) {
  const candidates = [];
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    // Allow either the data.json itself or the gameStore data dir.
    // An explicit path never falls back: a wrong --type-data must fail loudly.
    return [abs, path.join(abs, TYPE_TABLE_RELATIVE)];
  }
  const envDir = process.env.EVEJS_GAMESTORE_DATA_DIR;
  if (envDir) {
    candidates.push(path.join(path.resolve(envDir), TYPE_TABLE_RELATIVE));
  }
  candidates.push(
    path.join(REPO_ROOT, "_local", "gameStore", "data", TYPE_TABLE_RELATIVE),
  );
  candidates.push(
    path.join(REPO_ROOT, "server", "src", "gameStore", "data", TYPE_TABLE_RELATIVE),
  );
  return candidates;
}

function resolveTypeDataPath(explicitPath) {
  const tried = candidateTypeDataPaths(explicitPath);
  for (const candidate of tried) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(
    "Cannot find the EveJS item type table (itemTypes/data.json). Tried:\n" +
      tried.map((p) => `  ${p}`).join("\n") +
      "\nPass --type-data <path-to-itemTypes/data.json> or set " +
      "EVEJS_GAMESTORE_DATA_DIR to the gameStore data directory.",
  );
}

// 23 MB file — parse once per process, keyed by resolved path.
const cache = new Map();

/**
 * Load the item type table and index it by typeID.
 * The file is {source, count, types} where types is an ARRAY of records,
 * so it must be indexed on each record's typeID, not by array position.
 */
function loadTypeMetadata(explicitPath) {
  const filePath = resolveTypeDataPath(explicitPath);
  if (cache.has(filePath)) {
    return cache.get(filePath);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse the EveJS item type table ${filePath}: ${error.message}`,
    );
  }

  const types = parsed && Array.isArray(parsed.types) ? parsed.types : null;
  if (!types || types.length === 0) {
    throw new Error(
      `Unexpected item type table shape in ${filePath}: expected ` +
        '{ types: [ { typeID, categoryID, ... } ] }. Pass --type-data with a ' +
        "valid EveJS itemTypes/data.json.",
    );
  }

  const byTypeID = new Map();
  for (const row of types) {
    const typeID = Number(row && row.typeID);
    if (Number.isFinite(typeID) && typeID > 0) {
      byTypeID.set(typeID, row);
    }
  }
  if (byTypeID.size === 0) {
    throw new Error(
      `No usable typeID rows in the EveJS item type table ${filePath}.`,
    );
  }

  const table = {
    path: filePath,
    size: byTypeID.size,
    get(typeID) {
      return byTypeID.get(Number(typeID)) || null;
    },
    categoryIdOf(typeID) {
      const row = byTypeID.get(Number(typeID));
      const categoryID = row ? Number(row.categoryID) : NaN;
      return Number.isFinite(categoryID) ? categoryID : 0;
    },
  };
  cache.set(filePath, table);
  return table;
}

module.exports = {
  loadTypeMetadata,
  resolveTypeDataPath,
};
