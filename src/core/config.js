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
  headers: false,
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
  cleanup: {
    keepRuns: 20,
    maxRunAgeDays: 14,
    keepGhostRuns: 3,
    maxGhostAgeDays: 3,
    pruneInvalidSessions: true,
    pruneCache: true,
  },
  session: {
    bootstrapMaxKb: 4,
    contextMaxKb: 16,
    memoryPromptMaxKb: 4,
    memoryTurns: 6,
    memoryResults: 3,
    captureMaxKb: 48,
  },
  planner: {
    maxModules: 6,
    maxFiles: 12,
    maxSymbols: 24,
    maxTests: 6,
    maxSourceBytes: 24000,
    maxInstructionBytes: 6000,
  },
  semantic: {
    tsjs: {
      enabled: false,
      workerConcurrency: 1,
      timeoutMs: 45000,
      memoryMb: 1536,
      analyzerVersion: "semantic-tsjs-v1",
    },
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

  function setNested(target, parts, value) {
    if (parts.length === 0) {
      return;
    }

    if (parts.length === 1) {
      target[parts[0]] = value;
      return;
    }

    const [head, ...rest] = parts;
    if (!target[head] || typeof target[head] !== "object" || Array.isArray(target[head])) {
      target[head] = {};
    }
    setNested(target[head], rest, value);
  }

  for (const [key, value] of Object.entries(flags)) {
    if (key === "_") continue;
    const parts = key
      .split(".")
      .filter(Boolean)
      .map((part) => part.replace(/-([a-z])/g, (_, char) => char.toUpperCase()));
    setNested(result, parts, value);
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
    headers: config.headers,
    headerWindow: config.headerWindow,
    topKeyFilesPerModule: config.topKeyFilesPerModule,
    budgets: config.budgets,
    toolchain: config.toolchain,
    hooks: config.hooks,
    cache: config.cache,
    cleanup: config.cleanup,
    session: config.session,
    planner: config.planner,
    semantic: config.semantic,
  };

  const yaml = stringifyYaml(output);

  if (!dryRun) {
    await fs.writeFile(configPath, yaml, "utf8");
  }
  return configPath;
}

export async function syncConfigFile(root, config, { dryRun = false } = {}) {
  const configPath = path.join(root, ".agentify.yaml");
  let existing = null;
  let fileConfig = {};

  try {
    existing = await fs.readFile(configPath, "utf8");
    fileConfig = parseConfigFile(existing);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, fileConfig);
  if (!existing && config?.provider) {
    merged.provider = config.provider;
  }

  const yaml = stringifyYaml(merged);
  const changed = !existing || JSON.stringify(fileConfig) !== JSON.stringify(merged);

  if (changed && !dryRun) {
    await fs.writeFile(configPath, yaml, "utf8");
  }

  return {
    path: configPath,
    existed: Boolean(existing),
    changed,
    status: !existing
      ? dryRun ? "would_create" : "created"
      : changed
        ? dryRun ? "would_update" : "updated"
        : "unchanged",
  };
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
