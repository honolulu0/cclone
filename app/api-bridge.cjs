const path = require("node:path");

const DEFAULT_HOST_SHIM_ENTRY = path.join(__dirname, "host-shim", "http-host-shim.cjs");
const HOST_SHIM_ENTRY_ENV = "CCLONE_HOST_SHIM_ENTRY";

function resolveHostShimEntry() {
  const configuredEntry = normalizeOptionalString(process.env[HOST_SHIM_ENTRY_ENV]);
  if (!configuredEntry) {
    return {
      entryPath: DEFAULT_HOST_SHIM_ENTRY,
      source: "default",
    };
  }

  const entryPath = path.isAbsolute(configuredEntry)
    ? configuredEntry
    : path.resolve(__dirname, configuredEntry);

  return {
    entryPath,
    source: "env",
  };
}

function loadHostShim() {
  const { entryPath, source } = resolveHostShimEntry();
  let loadedModule;

  try {
    loadedModule = require(entryPath);
  } catch (error) {
    if (source === "env") {
      throw new Error(
        `Failed to load host shim from ${HOST_SHIM_ENTRY_ENV}=${entryPath}: ${formatError(error)}`,
      );
    }

    throw error;
  }

  if (typeof loadedModule?.startExternalApiServer !== "function") {
    throw new Error(
      `Host shim entry must export startExternalApiServer(...): ${entryPath}`,
    );
  }

  return loadedModule;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  return String(error);
}

module.exports = loadHostShim();
