"use strict";

const fs = require("fs");
const path = require("path");
const { readJson, writeJson, ensureDir } = require("./config");
const { flagIdFromLocationFlag } = require("./locationFlags");
const {
  DEFAULT_BUNDLE_ROOT,
  JITA_44_STATION_ID,
  JITA_SYSTEM_ID,
  DEFAULT_NPC_CORP,
  PLAYER_CORP_FLOOR,
  NPC_STATION_MIN,
  NPC_STATION_MAX,
  REPO_ROOT,
} = require("./paths");

// Mirror playerTransferShared skill item id scheme.
function buildSkillItemID(characterID, typeID) {
  return Number(characterID) * 100000 + Number(typeID);
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function isoToFileTime(iso) {
  if (!iso) {
    return (BigInt(Date.now()) * 10000n + 116444736000000000n).toString();
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return (BigInt(Date.now()) * 10000n + 116444736000000000n).toString();
  }
  return (BigInt(ms) * 10000n + 116444736000000000n).toString();
}

function isNpcStationId(locationID) {
  const id = toPositiveInt(locationID, 0);
  return id >= NPC_STATION_MIN && id <= NPC_STATION_MAX;
}

function isPlayerCorp(corporationID) {
  return toPositiveInt(corporationID, 0) >= PLAYER_CORP_FLOOR;
}

const BLOODLINE_CHARACTER_TYPE_ID = {
  1: 1373,
  2: 1374,
  3: 1375,
  4: 1376,
  5: 1377,
  6: 1378,
  7: 1379,
  8: 1380,
  11: 1383,
  12: 1384,
  13: 1385,
  14: 1386,
};

function loadEndpoint(characterDir, name) {
  return readJson(path.join(characterDir, `${name}.json`), null);
}

function dataOf(endpointFile) {
  if (!endpointFile) return null;
  if (endpointFile.ok === false) return null;
  return endpointFile.data != null ? endpointFile.data : null;
}

/**
 * Resolve a hangar/station location for import.
 * Nested item locations keep their parent item_id.
 */
function createLocationResolver(fallbackStationID, remapReport) {
  const cache = new Map();

  function remapOuter(locationID, locationType, reason) {
    const id = toPositiveInt(locationID, 0);
    if (id <= 0) {
      return fallbackStationID;
    }
    if (cache.has(id)) {
      return cache.get(id);
    }

    let resolved = id;
    let remapped = false;
    let why = null;

    if (locationType === "item") {
      resolved = id; // parent item — keep
    } else if (locationType === "station" && isNpcStationId(id)) {
      resolved = id;
    } else if (locationType === "station" && !isNpcStationId(id)) {
      // Some citadels mis-typed; treat non-NPC station ids as structures.
      resolved = fallbackStationID;
      remapped = true;
      why = reason || "non_npc_station_id";
    } else if (locationType === "structure" || locationType === "other") {
      resolved = fallbackStationID;
      remapped = true;
      why = reason || `location_type_${locationType}`;
    } else if (locationType === "solar_system") {
      resolved = fallbackStationID;
      remapped = true;
      why = reason || "solar_system_asset";
    } else if (!isNpcStationId(id) && id > NPC_STATION_MAX) {
      resolved = fallbackStationID;
      remapped = true;
      why = reason || "structure_id_range";
    }

    cache.set(id, resolved);
    if (remapped) {
      remapReport.push({
        originalLocationID: id,
        locationType: locationType || null,
        resolvedLocationID: resolved,
        reason: why,
      });
    }
    return resolved;
  }

  return { remapOuter };
}

function genderToId(gender) {
  if (gender === "female" || gender === 0 || gender === "0") return 0;
  if (gender === "male" || gender === 1 || gender === "1") return 1;
  return 1;
}

function convertAssetsToItems(assets, characterID, namesByItemId, resolver, fallbackStationID) {
  const items = [];
  const list = Array.isArray(assets) ? assets : [];
  const itemIdSet = new Set(list.map((a) => toPositiveInt(a.item_id, 0)));

  for (const asset of list) {
    const itemID = toPositiveInt(asset.item_id, 0);
    if (itemID <= 0) continue;

    const typeID = toPositiveInt(asset.type_id, 0);
    const flagID = flagIdFromLocationFlag(asset.location_flag, 4);
    const quantity = Math.max(1, toPositiveInt(asset.quantity, 1));
    // ESI is_singleton covers ships, modules, containers, blueprints, etc.
    const singleton = asset.is_singleton ? 1 : 0;

    let locationID = toPositiveInt(asset.location_id, 0);
    const locationType = asset.location_type || "station";

    if (locationType === "item" && itemIdSet.has(locationID)) {
      // Nested inside another personal item (ship, container) — keep parent item id.
    } else {
      locationID = resolver.remapOuter(
        locationID,
        locationType === "item" ? "other" : locationType,
        "asset_outer_location",
      );
      // If it was location_type item but parent is not in the asset list
      // (e.g. corporate container), fall through to hangar.
      if (locationType === "item" && !itemIdSet.has(toPositiveInt(asset.location_id, 0))) {
        locationID = fallbackStationID;
      }
    }

    const itemName =
      (namesByItemId && namesByItemId.get(itemID)) ||
      null;

    items.push({
      itemID,
      typeID,
      ownerID: characterID,
      locationID,
      flagID,
      quantity: singleton ? -1 : quantity,
      stacksize: singleton ? 1 : quantity,
      singleton,
      customInfo: "",
      itemName: itemName || undefined,
      // Preserve TQ identity for debugging / re-import.
      tq: {
        location_flag: asset.location_flag,
        location_type: asset.location_type,
        original_location_id: asset.location_id,
        is_blueprint_copy: asset.is_blueprint_copy || false,
      },
    });
  }

  return items;
}

function applyBlueprintDetails(items, blueprints) {
  const byId = new Map(
    (Array.isArray(blueprints) ? blueprints : []).map((bp) => [
      toPositiveInt(bp.item_id, 0),
      bp,
    ]),
  );
  for (const item of items) {
    const bp = byId.get(item.itemID);
    if (!bp) continue;
    // singleton 2 = BPC in some code paths; keep runs/ME/TE in customInfo JSON
    item.blueprint = {
      materialEfficiency: bp.material_efficiency,
      timeEfficiency: bp.time_efficiency,
      runs: bp.runs,
      quantity: bp.quantity,
    };
    if (bp.quantity === -2) {
      item.singleton = 2;
      item.quantity = -2;
    } else if (bp.quantity === -1) {
      item.singleton = 1;
      item.quantity = -1;
    }
  }
}

function convertSkills(skillsPayload, characterID) {
  const map = {};
  const skills = skillsPayload && Array.isArray(skillsPayload.skills)
    ? skillsPayload.skills
    : [];
  for (const skill of skills) {
    const typeID = toPositiveInt(skill.skill_id, 0);
    if (typeID <= 0) continue;
    const level = Math.max(
      0,
      Math.min(5, toPositiveInt(skill.trained_skill_level, 0)),
    );
    const activeLevel = Math.max(
      0,
      Math.min(5, toPositiveInt(skill.active_skill_level, level)),
    );
    const sp = toPositiveInt(skill.skillpoints_in_skill, 0);
    map[String(typeID)] = {
      itemID: buildSkillItemID(characterID, typeID),
      typeID,
      ownerID: characterID,
      locationID: characterID,
      flagID: 7,
      categoryID: 16,
      skillLevel: level,
      trainedSkillLevel: level,
      effectiveSkillLevel: activeLevel,
      virtualSkillLevel: null,
      skillPoints: sp,
      trainedSkillPoints: sp,
      inTraining: false,
      trainingStartSP: sp,
      trainingDestinationSP: sp,
      trainingStartTime: null,
      trainingEndTime: null,
    };
  }
  return map;
}

function convertSkillQueue(queuePayload, characterID) {
  const queue = Array.isArray(queuePayload) ? queuePayload : [];
  return {
    characterID,
    queue: queue.map((entry) => ({
      skillID: entry.skill_id,
      typeID: entry.skill_id,
      level: entry.finished_level,
      startDate: entry.start_date || null,
      finishDate: entry.finish_date || null,
      queuePosition: entry.queue_position,
      trainingStartSP: entry.training_start_sp,
      levelStartSP: entry.level_start_sp,
      levelEndSP: entry.level_end_sp,
    })),
  };
}

function convertFittings(fittingsPayload, characterID) {
  const fittings = Array.isArray(fittingsPayload) ? fittingsPayload : [];
  // savedFittings table shape is owned by fitting store; keep a portable form.
  return {
    characterID,
    fittings: fittings.map((fit) => ({
      fittingID: fit.fitting_id,
      name: fit.name,
      description: fit.description || "",
      shipTypeID: fit.ship_type_id,
      items: (Array.isArray(fit.items) ? fit.items : []).map((it) => ({
        typeID: it.type_id,
        flag: it.flag,
        quantity: it.quantity,
      })),
    })),
  };
}

function convertLpWallet(lpPayload, characterID) {
  const rows = Array.isArray(lpPayload) ? lpPayload : [];
  const byCorp = {};
  for (const row of rows) {
    const corp = toPositiveInt(row.corporation_id, 0);
    if (corp <= 0) continue;
    byCorp[String(corp)] = toPositiveInt(row.loyalty_points, 0);
  }
  return {
    characterID,
    wallets: byCorp,
  };
}

function convertStandings(standingsPayload) {
  const rows = Array.isArray(standingsPayload) ? standingsPayload : [];
  const standingData = { char: [], corp: [], npc: [] };
  for (const row of rows) {
    const fromID = toPositiveInt(row.from_id, 0);
    const standing = Number(row.standing) || 0;
    const fromType = row.from_type; // agent | faction | npc_corp
    const entry = { fromID, toID: 0, standing };
    if (fromType === "faction" || fromType === "npc_corp" || fromType === "agent") {
      standingData.npc.push(entry);
    } else {
      standingData.corp.push(entry);
    }
  }
  return standingData;
}

function convertJumpClones(clonesPayload, resolver, fallbackStationID) {
  const clones = clonesPayload || {};
  const jumpClones = [];
  for (const jc of Array.isArray(clones.jump_clones) ? clones.jump_clones : []) {
    const locType = jc.location_type || "station";
    const original = toPositiveInt(jc.location_id, 0);
    const locationID =
      locType === "station" && isNpcStationId(original)
        ? original
        : resolver.remapOuter(original, locType === "station" ? "station" : "structure", "jump_clone");
    jumpClones.push({
      jumpCloneID: jc.jump_clone_id,
      locationID,
      originalLocationID: original,
      locationType: locType,
      implants: Array.isArray(jc.implants) ? jc.implants.slice() : [],
      name: jc.name || "",
    });
  }

  let homeStationID = fallbackStationID;
  if (clones.home_location) {
    const home = clones.home_location;
    const original = toPositiveInt(home.location_id, 0);
    if (home.location_type === "station" && isNpcStationId(original)) {
      homeStationID = original;
    } else {
      homeStationID = resolver.remapOuter(
        original,
        home.location_type || "structure",
        "home_location",
      );
    }
  }

  return {
    jumpClones,
    homeStationID,
    lastCloneJumpDate: clones.last_clone_jump_date || null,
    lastStationChangeDate: clones.last_station_change_date || null,
  };
}

function convertCharacter(characterDir, options = {}) {
  const fallbackStationID =
    toPositiveInt(options.fallbackStationID, 0) || JITA_44_STATION_ID;
  const remapReport = [];
  const resolver = createLocationResolver(fallbackStationID, remapReport);

  const pub = dataOf(loadEndpoint(characterDir, "public")) || {};
  const skillsPayload = dataOf(loadEndpoint(characterDir, "skills")) || {};
  const skillQueue = dataOf(loadEndpoint(characterDir, "skillqueue"));
  const attributes = dataOf(loadEndpoint(characterDir, "attributes")) || {};
  const wallet = dataOf(loadEndpoint(characterDir, "wallet"));
  const location = dataOf(loadEndpoint(characterDir, "location")) || {};
  const ship = dataOf(loadEndpoint(characterDir, "ship")) || {};
  const implants = dataOf(loadEndpoint(characterDir, "implants")) || [];
  const clones = dataOf(loadEndpoint(characterDir, "clones")) || {};
  const assets = dataOf(loadEndpoint(characterDir, "assets")) || [];
  const blueprints = dataOf(loadEndpoint(characterDir, "blueprints")) || [];
  const fittings = dataOf(loadEndpoint(characterDir, "fittings")) || [];
  const standings = dataOf(loadEndpoint(characterDir, "standings")) || [];
  const lp = dataOf(loadEndpoint(characterDir, "loyalty_points")) || [];
  const corpHistory = dataOf(loadEndpoint(characterDir, "corporation_history")) || [];
  const assetNames = dataOf(loadEndpoint(characterDir, "asset_names")) || [];
  const fatigue = dataOf(loadEndpoint(characterDir, "fatigue")) || {};

  const meta = readJson(path.join(characterDir, "_meta.json"), {});
  const characterID = toPositiveInt(
    meta.characterID || options.characterID,
    0,
  );
  if (characterID <= 0) {
    throw new Error(`Cannot resolve characterID for ${characterDir}`);
  }

  const characterName = pub.name || options.characterName || String(characterID);
  const bloodlineID = toPositiveInt(pub.bloodline_id, 1);
  const raceID = toPositiveInt(pub.race_id, 1);
  const typeID = BLOODLINE_CHARACTER_TYPE_ID[bloodlineID] || 1373;

  // Corp strip: player corps → NPC fallback (same policy as exportPlayers).
  let corporationID = toPositiveInt(pub.corporation_id, DEFAULT_NPC_CORP);
  let allianceID = toPositiveInt(pub.alliance_id, 0);
  let hadPlayerCorp = false;
  if (isPlayerCorp(corporationID)) {
    hadPlayerCorp = true;
    // Prefer last NPC corp from history if any
    const history = Array.isArray(corpHistory) ? corpHistory : [];
    const npcFromHistory = history
      .map((h) => toPositiveInt(h.corporation_id, 0))
      .find((id) => id > 0 && !isPlayerCorp(id));
    corporationID = npcFromHistory || DEFAULT_NPC_CORP;
    allianceID = 0;
  }

  const cloneInfo = convertJumpClones(clones, resolver, fallbackStationID);

  // Active location
  let stationID = fallbackStationID;
  let solarSystemID = JITA_SYSTEM_ID;
  if (location.station_id && isNpcStationId(location.station_id)) {
    stationID = toPositiveInt(location.station_id, fallbackStationID);
  } else if (location.structure_id) {
    stationID = resolver.remapOuter(
      location.structure_id,
      "structure",
      "active_location_structure",
    );
  } else if (location.solar_system_id) {
    solarSystemID = toPositiveInt(location.solar_system_id, JITA_SYSTEM_ID);
    stationID = fallbackStationID;
  }

  const namesByItemId = new Map(
    (Array.isArray(assetNames) ? assetNames : []).map((n) => [
      toPositiveInt(n.item_id, 0),
      n.name,
    ]),
  );

  const items = convertAssetsToItems(
    assets,
    characterID,
    namesByItemId,
    resolver,
    fallbackStationID,
  );
  applyBlueprintDetails(items, blueprints);

  // Active ship: prefer ESI ship endpoint item_id if present in assets
  const activeShipItemID = toPositiveInt(ship.ship_item_id, 0);
  const activeShipTypeID = toPositiveInt(ship.ship_type_id, 0);
  let shipID = activeShipItemID;
  if (shipID && !items.some((it) => it.itemID === shipID)) {
    // Ship not in asset list (e.g. undocked elsewhere) — synthesize capsule/ship in hangar
    shipID = characterID + 100;
    items.push({
      itemID: shipID,
      typeID: activeShipTypeID || 670,
      ownerID: characterID,
      locationID: stationID,
      flagID: 4,
      quantity: -1,
      stacksize: 1,
      singleton: 1,
      itemName: ship.ship_name || "Imported Ship",
      tq: { synthesized: true, reason: "active_ship_not_in_assets" },
    });
  }
  if (!shipID) {
    // Pick any ship-like item in hangar, else leave 0 (server may bootstrap)
    const hangarShip = items.find(
      (it) => it.flagID === 4 && it.singleton === 1 && it.locationID === stationID,
    );
    shipID = hangarShip ? hangarShip.itemID : characterID + 100;
  }

  // Ensure active ship is in the hangar at the character station
  const activeShip = items.find((it) => it.itemID === shipID);
  if (activeShip && !isNpcStationId(activeShip.locationID) && activeShip.flagID === 4) {
    activeShip.locationID = stationID;
  }

  const balance = Number(wallet);
  const isk = Number.isFinite(balance) ? balance : 0;

  const nowFileTime = isoToFileTime(new Date().toISOString());
  const createDateTime = isoToFileTime(pub.birthday);

  const employmentHistory = (Array.isArray(corpHistory) ? corpHistory : [])
    .map((h) => ({
      corporationID: isPlayerCorp(h.corporation_id)
        ? corporationID
        : toPositiveInt(h.corporation_id, corporationID),
      startDate: isoToFileTime(h.start_date),
      deleted: 0,
    }))
    .reverse();
  if (employmentHistory.length === 0) {
    employmentHistory.push({
      corporationID,
      startDate: createDateTime,
      deleted: 0,
    });
  }

  const record = {
    // accountId filled by importPlayers
    characterName,
    gender: genderToId(pub.gender),
    bloodlineID,
    ancestryID: 0,
    raceID,
    typeID,
    corporationID,
    schoolID: 11,
    allianceID,
    factionID: toPositiveInt(pub.faction_id, 0),
    stationID,
    homeStationID: cloneInfo.homeStationID || stationID,
    cloneStationID: cloneInfo.homeStationID || stationID,
    solarSystemID: toPositiveInt(location.solar_system_id, solarSystemID),
    constellationID: 0,
    regionID: 0,
    createDateTime,
    startDateTime: createDateTime,
    logoffDate: nowFileTime,
    deletePrepareDateTime: null,
    lockTypeID: null,
    securityRating: Number(pub.security_status) || 0,
    title: hadPlayerCorp ? "" : pub.title || "",
    description: pub.description || `Imported from Tranquility ESI (${characterName})`,
    balance: isk,
    aurBalance: 0,
    plexBalance: 0,
    balanceChange: 0,
    walletJournal: [
      {
        transactionID: 1,
        transactionDate: nowFileTime,
        referenceID: characterID,
        entryTypeID: 1,
        ownerID1: characterID,
        ownerID2: characterID,
        accountKey: 1000,
        amount: isk,
        balance: isk,
        description: "Imported ISK balance from Tranquility",
        currency: 0,
        sortValue: 1,
      },
    ],
    plexVaultTransactions: [],
    skillPoints: toPositiveInt(skillsPayload.total_sp, 0),
    freeSkillPoints: toPositiveInt(skillsPayload.unallocated_sp, 0),
    shipTypeID: activeShipTypeID || (activeShip && activeShip.typeID) || 670,
    shipName: ship.ship_name || "Ship",
    bounty: 0,
    skillQueueEndTime: 0,
    daysLeft: 365,
    userType: 30,
    petitionMessage: "",
    worldSpaceID: 0,
    unreadMailCount: 0,
    upcomingEventCount: 0,
    unprocessedNotifications: 0,
    shipID,
    shortName: "none",
    employmentHistory,
    standingData: convertStandings(standings),
    characterAttributes: {
      charisma: toPositiveInt(attributes.charisma, 20),
      intelligence: toPositiveInt(attributes.intelligence, 20),
      memory: toPositiveInt(attributes.memory, 20),
      perception: toPositiveInt(attributes.perception, 20),
      willpower: toPositiveInt(attributes.willpower, 20),
    },
    respecInfo: {
      freeRespecs: toPositiveInt(attributes.bonus_remaps, 0),
      lastRespecDate: attributes.last_remap_date || null,
      nextTimedRespec: attributes.accrued_remap_cooldown_date || null,
    },
    skillHistory: [],
    boosters: [],
    implants: Array.isArray(implants) ? implants.map((typeID) => ({ typeID })) : [],
    jumpClones: cloneInfo.jumpClones,
    timeLastCloneJump: cloneInfo.lastCloneJumpDate
      ? isoToFileTime(cloneInfo.lastCloneJumpDate)
      : "0",
    allianceMemberStartDate: 0,
    skillTypeID: null,
    toLevel: null,
    trainingStartTime: null,
    trainingEndTime: null,
    queueEndTime: null,
    finishSP: null,
    trainedSP: null,
    finishedSkills: [],
    appearanceInfo: null,
    // paperDollState 0 = NoRecustomization. State 2 (NoExistingCustomization)
    // makes character select skip the image-server portrait and show the stock
    // bloodline/hi icon even when JPEGs exist on disk.
    portraitInfo: {
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
    },
    paperDollState: 0,
    portraitUploadedAt: new Date().toISOString(),
    portraitSizes: [32, 64, 128, 256, 512, 1024],
    // Prevent starter-skill bootstrap from clobbering imported skills.
    suppressSkillBootstrap: true,
    tqImport: {
      sourceCharacterID: characterID,
      sourceCorporationID: pub.corporation_id || null,
      sourceAllianceID: pub.alliance_id || null,
      hadPlayerCorp,
      assignedCorporationID: corporationID,
      importedAt: new Date().toISOString(),
      fallbackStationID,
      activeLocation: location,
      fatigue,
    },
  };

  const skills = convertSkills(skillsPayload, characterID);
  const simple = {
    skillQueues: convertSkillQueue(skillQueue, characterID),
    savedFittings: convertFittings(fittings, characterID),
    lpWallets: convertLpWallet(lp, characterID),
  };

  return {
    originalCharacterID: characterID,
    characterName,
    strip: {
      originalCorporationID: pub.corporation_id || null,
      assignedCorporationID: corporationID,
      hadPlayerCorp,
    },
    record,
    skills,
    items,
    simple,
    mail: { mailbox: null, messages: [] },
    notifications: { box: null },
    remapReport,
    stats: {
      skillCount: Object.keys(skills).length,
      totalSP: record.skillPoints,
      itemCount: items.length,
      isk,
      remapCount: remapReport.length,
    },
  };
}

function listCharacterDirs(dumpRoot) {
  const charactersRoot = path.join(dumpRoot, "characters");
  if (!fs.existsSync(charactersRoot)) {
    return [];
  }
  return fs
    .readdirSync(charactersRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(charactersRoot, d.name));
}

/**
 * Convert a dump folder into an EVE.js player bundle (exportPlayers format).
 */
function convertDump(dumpRoot, options = {}) {
  const absDump = path.resolve(dumpRoot);
  const account = readJson(path.join(absDump, "account.json"), null);
  if (!account) {
    throw new Error(`No account.json in dump: ${absDump}`);
  }

  const username = options.username || account.username;
  const fallbackStationID =
    toPositiveInt(options.fallbackStationID, 0) ||
    toPositiveInt(account.fallbackStationID, 0) ||
    JITA_44_STATION_ID;

  const characterDirs = listCharacterDirs(absDump);
  if (characterDirs.length === 0) {
    throw new Error(`No character dumps under ${absDump}/characters`);
  }

  const characters = [];
  const allRemaps = [];
  for (const dir of characterDirs) {
    console.log(`  Converting ${path.basename(dir)} ...`);
    const entry = convertCharacter(dir, { fallbackStationID });
    characters.push(entry);
    for (const row of entry.remapReport) {
      allRemaps.push({
        characterID: entry.originalCharacterID,
        characterName: entry.characterName,
        ...row,
      });
    }
    console.log(
      `    ${entry.characterName}: ${entry.stats.skillCount} skills, ` +
        `${entry.stats.itemCount} items, ${entry.stats.isk.toLocaleString()} ISK, ` +
        `${entry.stats.remapCount} location remaps`,
    );
  }

  const bundle = {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    source: {
      kind: "tranquility-esi-dump",
      dumpRoot: absDump,
      username,
      fallbackStationID,
    },
    accounts: [
      {
        username,
        account: {
          // id allocated on import
          passwordhash: "",
          isGM: true,
          banned: false,
          tqImport: {
            source: "tranquility",
            dumpRoot: absDump,
            importedAt: new Date().toISOString(),
          },
        },
        characters: characters.map((c) => ({
          originalCharacterID: c.originalCharacterID,
          characterName: c.characterName,
          strip: c.strip,
          record: c.record,
          skills: c.skills,
          items: c.items,
          simple: c.simple,
          mail: c.mail,
          notifications: c.notifications,
        })),
      },
    ],
  };

  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(DEFAULT_BUNDLE_ROOT, path.basename(absDump));
  ensureDir(outDir);

  const bundlePath = options.out
    ? path.resolve(options.out)
    : path.join(outDir, "players-bundle.json");
  writeJson(bundlePath, bundle);

  const reportPath = path.join(path.dirname(bundlePath), "remap-report.json");
  writeJson(reportPath, {
    fallbackStationID,
    remappedLocations: allRemaps,
    characters: characters.map((c) => ({
      characterID: c.originalCharacterID,
      characterName: c.characterName,
      stats: c.stats,
      strip: c.strip,
    })),
  });

  console.log(`\nBundle written: ${bundlePath}`);
  console.log(`Remap report:   ${reportPath}`);
  return { bundlePath, reportPath, bundle };
}

module.exports = {
  convertDump,
  convertCharacter,
  JITA_44_STATION_ID,
  REPO_ROOT,
};
