import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  provider: "local",
  mode: "branch",
  strict: true,
  languages: "auto",
  moduleStrategy: "auto",
  dryRun: false,
  maxFilesPerModule: 20,
  moduleConcurrency: 4,
  tokenReport: true,
  headerWindow: 80,
  topKeyFilesPerModule: 15
};

function parseSimpleYaml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const splitIndex = line.indexOf(":");
    if (splitIndex === -1) {
      continue;
    }
    const key = line.slice(0, splitIndex).trim();
    const value = line.slice(splitIndex + 1).trim();
    if (!value) {
      result[key] = "";
      continue;
    }
    if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (/^\d+$/.test(value)) {
      result[key] = Number(value);
    } else {
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

export async function loadConfig(root, flags = {}) {
  let fileConfig = {};
  const configPath = path.join(root, ".agentify.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = parseSimpleYaml(raw);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...Object.fromEntries(Object.entries(flags).filter(([key]) => key !== "_"))
  };
}

export async function writeDefaultConfig(root, config, { dryRun = false } = {}) {
  const configPath = path.join(root, ".agentify.yaml");
  try {
    await fs.access(configPath);
    return configPath;
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  const yaml = `provider: ${config.provider}
mode: ${config.mode}
strict: ${String(config.strict)}
languages: ${config.languages}
moduleStrategy: ${config.moduleStrategy}
dryRun: ${String(config.dryRun)}
maxFilesPerModule: ${config.maxFilesPerModule}
moduleConcurrency: ${config.moduleConcurrency}
tokenReport: ${String(config.tokenReport)}
headerWindow: ${config.headerWindow}
topKeyFilesPerModule: ${config.topKeyFilesPerModule}
`;

  if (!dryRun) {
    await fs.writeFile(configPath, yaml, "utf8");
  }
  return configPath;
}
