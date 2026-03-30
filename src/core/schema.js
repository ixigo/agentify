export const SCHEMA_VERSIONS = {
  INDEX: "1.1",
  MODULE_METADATA: "1.1",
  SESSION: "1.0",
  CACHE: "1.0",
};

export function checkSchema(artifact, expectedVersion) {
  const current = artifact?.schema_version;
  if (!current) return { compatible: false, reason: "no schema_version field" };

  const [currentMajor, currentMinor] = current.split(".").map(Number);
  const [expectedMajor, expectedMinor] = expectedVersion.split(".").map(Number);

  if (currentMajor !== expectedMajor) {
    return {
      compatible: false,
      reason: `Major version mismatch: found ${current}, need ${expectedVersion}. Run 'agentify scan' to regenerate.`,
    };
  }

  if (currentMinor < expectedMinor) {
    return { compatible: true, needsMigration: true, from: current, to: expectedVersion };
  }

  return { compatible: true, needsMigration: false };
}

export function migrateIndex(index, fromVersion, toVersion) {
  if (fromVersion === "1.0" && (toVersion === "1.1" || toVersion === "1.1")) {
    for (const mod of index.modules || []) {
      if (!mod.content_fingerprint) {
        mod.content_fingerprint = null;
      }
    }
    index.schema_version = "1.1";
  }
  return index;
}

export function migrateModuleMetadata(metadata, fromVersion, toVersion) {
  if (fromVersion === "1.0" && (toVersion === "1.1" || toVersion === "1.1")) {
    if (!metadata.freshness) {
      metadata.freshness = {};
    }
    if (!metadata.freshness.content_fingerprint) {
      metadata.freshness.content_fingerprint = null;
    }
    metadata.schema_version = "1.1";
  }
  return metadata;
}
