"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_CONFIG_PATH, DEFAULT_DATA_ROOT } = require("./paths");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadSsoConfig(configPath = DEFAULT_CONFIG_PATH) {
  const envClientId = process.env.EVE_SSO_CLIENT_ID || process.env.ESI_CLIENT_ID;
  const envSecret = process.env.EVE_SSO_CLIENT_SECRET || process.env.ESI_CLIENT_SECRET;
  const envCallback =
    process.env.EVE_SSO_CALLBACK_URL ||
    process.env.ESI_CALLBACK_URL ||
    null;

  const file = readJson(configPath, {}) || {};
  const clientId = envClientId || file.clientId || file.client_id || null;
  const clientSecret = envSecret || file.clientSecret || file.client_secret || null;
  const callbackUrl =
    envCallback ||
    file.callbackUrl ||
    file.callback_url ||
    "http://127.0.0.1:8731/callback";
  const callbackPort = Number(file.callbackPort || 8731) || 8731;

  return {
    configPath,
    clientId,
    clientSecret,
    callbackUrl,
    callbackPort,
    usePkce: file.usePkce !== false && !clientSecret,
  };
}

function saveSsoConfig(partial, configPath = DEFAULT_CONFIG_PATH) {
  const existing = readJson(configPath, {}) || {};
  const next = {
    ...existing,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  writeJson(configPath, next);
  return next;
}

function ensureDataRoot() {
  return ensureDir(DEFAULT_DATA_ROOT);
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  loadSsoConfig,
  saveSsoConfig,
  ensureDataRoot,
};
