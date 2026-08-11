"use strict";

const path = require("path");
const fs = require("fs");

const TOOL_ROOT = path.resolve(__dirname, "..");
const CANDIDATE_ROOT = path.resolve(TOOL_ROOT, "..", "..");
const REPO_ROOT =
  fs.existsSync(path.join(CANDIDATE_ROOT, "compose.yaml")) ||
  fs.existsSync(path.join(CANDIDATE_ROOT, "server", "src", "gameStore"))
    ? CANDIDATE_ROOT
    : CANDIDATE_ROOT;

const DEFAULT_DATA_ROOT = path.join(REPO_ROOT, "_local", "evejs-character-import");
const DEFAULT_BUNDLE_ROOT = path.join(DEFAULT_DATA_ROOT, "bundles");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_DATA_ROOT, "config.json");
// Optional search paths for personal character-export folders (layout only)
const DEFAULT_DUMP_ROOT = path.join(
  REPO_ROOT,
  "_local",
  "eve-character-export",
  "exports",
);

// Jita IV - Moon 4 - Caldari Navy Assembly Plant (bundle remaps)
const JITA_44_STATION_ID = 60003760;
const JITA_SYSTEM_ID = 30000142;
const DEFAULT_NPC_CORP = 1000060;
const PLAYER_CORP_FLOOR = 2000000;
const NPC_STATION_MIN = 60000000;
const NPC_STATION_MAX = 64000000;

module.exports = {
  TOOL_ROOT,
  REPO_ROOT,
  DEFAULT_DATA_ROOT,
  DEFAULT_BUNDLE_ROOT,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DUMP_ROOT,
  JITA_44_STATION_ID,
  JITA_SYSTEM_ID,
  DEFAULT_NPC_CORP,
  PLAYER_CORP_FLOOR,
  NPC_STATION_MIN,
  NPC_STATION_MAX,
};
