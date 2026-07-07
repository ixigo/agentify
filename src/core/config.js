import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DEFAULT_MODEL_ROUTES } from "./models.js";

const DEFAULT_CONFIG = {
  provider: "local",
  strict: true,
  languages: "auto",
  moduleStrategy: "auto",
  dryRun: false,
  ghostMode: false,
  json: false,
  maxFilesPerModule: 20,
  topKeyFilesPerModule: 15,
  toolchain: {
    zoekt: false,
  },
  hooks: {
    preCommit: true,
    postMerge: true,
  },
  runtime: {
    store: "local",
    sharedStorePath: null,
  },
  models: {
    routes: DEFAULT_MODEL_ROUTES,
  },
  context: {
    injection: "relevant",
    sessionSummaries: true,
  },
  cleanup: {
    keepRuns: 20,
    maxRunAgeDays: 14,
    keepGhostRuns: 3,
    maxGhostAgeDays: 3,
    pruneInvalidSessions: true,
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

function sanitizeRepoConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }

  const sanitized = { ...config };
  const tests = sanitized.tests;
  const env = tests && typeof tests === "object" && !Array.isArray(tests) ? tests.env : null;
  if (env && typeof env === "object" && !Array.isArray(env) && env.inherit === true) {
    sanitized.tests = {
      ...tests,
      env: {
        ...env,
        inherit: false,
      },
    };
  }
  return sanitized;
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
    if (key === "semantic" && typeof value === "boolean") continue;
    const parts = key
      .split(".")
      .filter(Boolean)
      .map((part) => part.replace(/-([a-z])/g, (_, char) => char.toUpperCase()));
    setNested(result, parts, value);
  }
  return result;
}

function normalizeConfig(config) {
  const normalized = { ...config };
  if (normalized.hooks && typeof normalized.hooks === "object" && !Array.isArray(normalized.hooks)) {
    const { autoRefresh: _autoRefresh, ...hooks } = normalized.hooks;
    normalized.hooks = hooks;
  }
  return normalized;
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

  const merged = deepMerge(DEFAULT_CONFIG, sanitizeRepoConfig(fileConfig));
  return normalizeConfig(applyNestedFlags(merged, flags));
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
    maxFilesPerModule: config.maxFilesPerModule,
    topKeyFilesPerModule: config.topKeyFilesPerModule,
    toolchain: config.toolchain,
    hooks: normalizeConfig(config).hooks,
    runtime: config.runtime,
    models: config.models,
    context: config.context,
    cleanup: config.cleanup,
  };

  const yaml = stringifyYaml(output);

  if (!dryRun) {
    await fs.writeFile(configPath, yaml, "utf8");
  }
  return configPath;
}
