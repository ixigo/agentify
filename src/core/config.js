import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const DEFAULT_CONFIG = {
  provider: "local",
  strict: true,
  languages: "auto",
  moduleStrategy: "auto",
  dryRun: false,
  ghostMode: false,
  json: false,
  maxFilesPerModule: 20,
  moduleConcurrency: 4,
  tokenReport: true,
  headerWindow: 80,
  topKeyFilesPerModule: 15,
  budgets: {
    repo: 128000,
    perModule: 32000,
    perFile: 8000,
    truncation: "ranked",
  },
  toolchain: {
    zoekt: false,
    preferNative: false,
  },
  hooks: {
    preCommit: true,
    postMerge: true,
    autoRefresh: false,
  },
  cache: {
    enabled: true,
    maxAgeDays: 7,
    maxSizeMb: 100,
  },
  session: {
    bootstrapMaxKb: 4,
    contextMaxKb: 16,
  },
};

function parseConfigFile(text) {
  const result = parseYaml(text);
  return result && typeof result === "object" ? result : {};
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function applyNestedFlags(config, flags) {
  const result = { ...config };
  for (const [key, value] of Object.entries(flags)) {
    if (key === "_") continue;
    const parts = key.split(/[-.]/).reduce((acc, part, i) => {
      if (i === 0) return [part];
      return [...acc.slice(0, -1), acc[acc.length - 1] + part.charAt(0).toUpperCase() + part.slice(1)];
    }, []);
    if (parts.length === 1) {
      result[parts[0]] = value;
    }
  }
  return result;
}

export async function loadConfig(root, flags = {}) {
  let fileConfig = {};
  const configPath = path.join(root, ".agentify.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = parseConfigFile(raw);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, fileConfig);
  return applyNestedFlags(merged, flags);
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

  const output = {
    provider: config.provider,
    strict: config.strict,
    languages: config.languages,
    moduleStrategy: config.moduleStrategy,
    dryRun: config.dryRun,
    maxFilesPerModule: config.maxFilesPerModule,
    moduleConcurrency: config.moduleConcurrency,
    tokenReport: config.tokenReport,
    headerWindow: config.headerWindow,
    topKeyFilesPerModule: config.topKeyFilesPerModule,
    budgets: config.budgets,
    toolchain: config.toolchain,
    hooks: config.hooks,
    cache: config.cache,
    session: config.session,
  };

  const yaml = stringifyYaml(output);

  if (!dryRun) {
    await fs.writeFile(configPath, yaml, "utf8");
  }
  return configPath;
}

export async function persistProviderPreference(root, provider, { dryRun = false } = {}) {
  const configPath = path.join(root, ".agentify.yaml");
  let fileConfig = {};

  try {
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = parseConfigFile(raw);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  const yaml = stringifyYaml({
    ...fileConfig,
    provider,
  });

  if (!dryRun) {
    await fs.writeFile(configPath, yaml, "utf8");
  }

  return configPath;
}
