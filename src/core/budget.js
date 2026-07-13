// Budget policy for delegated model runs: per-route ceilings (dollars, turns,
// wall-clock) validated before any provider process starts, plus rolling
// daily/monthly caps computed from locally recorded spend. Budgets are the
// safety envelope — routing profiles (#295) choose how to operate inside it,
// they never widen it.

import { readDelegationRecords } from "./stats.js";

export const BUDGET_ON_LIMIT_MODES = ["block", "warn"];

const ROLLING_WINDOWS = [
  { name: "daily", configKey: "dailyUsd", days: 1 },
  { name: "monthly", configKey: "monthlyUsd", days: 30 },
];

function normalizePositiveNumber(value, label, { integer = false } = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  // A valueless CLI flag parses to boolean true, and Number(true) is 1 —
  // reject it instead of silently granting a $1 ceiling.
  if (typeof value === "boolean") {
    throw new Error(`${label} requires an explicit value`);
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) {
    throw new Error(`${label} must be a positive ${integer ? "integer" : "number"}, got "${value}"`);
  }
  return num;
}

export function resolveBudgetPolicy(config = {}) {
  const raw = config.models?.budget && typeof config.models.budget === "object" && !Array.isArray(config.models.budget)
    ? config.models.budget
    : {};
  const onLimit = raw.onLimit === null || raw.onLimit === undefined ? "block" : String(raw.onLimit).trim().toLowerCase();
  if (!BUDGET_ON_LIMIT_MODES.includes(onLimit)) {
    throw new Error(`models.budget.onLimit must be one of ${BUDGET_ON_LIMIT_MODES.join(", ")}, got "${raw.onLimit}"`);
  }
  return {
    dailyUsd: normalizePositiveNumber(raw.dailyUsd, "models.budget.dailyUsd"),
    monthlyUsd: normalizePositiveNumber(raw.monthlyUsd, "models.budget.monthlyUsd"),
    onLimit,
  };
}

// Merge per-route limits with CLI overrides (CLI wins) and validate the
// result. Throws before any provider process starts, so an invalid budget can
// never turn into an uncapped run.
export function resolveRouteLimits(route = {}, overrides = {}) {
  const pick = (overrideValue, routeValue) => (overrideValue === undefined ? routeValue : overrideValue);
  const effortRaw = pick(overrides.effort, route.effort);
  const effort = effortRaw === null || effortRaw === undefined || effortRaw === "" ? null : String(effortRaw).trim().toLowerCase();
  if (effort !== null && !/^[a-z]+$/.test(effort)) {
    throw new Error(`effort must be a simple level name (e.g. low, medium, high), got "${effortRaw}"`);
  }
  return {
    maxBudgetUsd: normalizePositiveNumber(pick(overrides.maxBudgetUsd, route.maxBudgetUsd), "maxBudgetUsd"),
    maxTurns: normalizePositiveNumber(pick(overrides.maxTurns, route.maxTurns), "maxTurns", { integer: true }),
    timeoutSeconds: normalizePositiveNumber(pick(overrides.timeoutSeconds, route.timeoutSeconds), "timeoutSeconds"),
    effort,
  };
}

export function describeBudgetSource(kind, config = {}, overrides = {}) {
  if (overrides.maxBudgetUsd !== undefined || overrides.maxTurns !== undefined || overrides.effort !== undefined) {
    return "cli";
  }
  const configured = config.models?.routes?.[kind];
  if (configured && typeof configured === "object"
    && (configured.maxBudgetUsd !== undefined || configured.maxTurns !== undefined || configured.timeoutSeconds !== undefined)) {
    return "config";
  }
  return "route-default";
}

function recordCost(record) {
  const value = record?.cost && typeof record.cost === "object" ? record.cost.total_usd : record?.cost_usd;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Rolling caps only count provider-reported dollars recorded locally by
// Agentify; estimated token counts never fabricate spend.
export async function checkRollingBudget(root, policy, { now = Date.now(), records = null } = {}) {
  const activeWindows = ROLLING_WINDOWS.filter((window) => policy[window.configKey] !== null && policy[window.configKey] !== undefined);
  if (activeWindows.length === 0) {
    return { exceeded: false, windows: [], remaining_usd: null };
  }
  const all = records ?? await readDelegationRecords(root);
  const windows = activeWindows.map((window) => {
    const limit = policy[window.configKey];
    const cutoff = new Date(now - window.days * 24 * 60 * 60 * 1000).toISOString();
    let spent = 0;
    for (const record of all) {
      if (String(record.ts || "") >= cutoff) {
        spent += recordCost(record);
      }
    }
    return {
      window: window.name,
      limit_usd: limit,
      spent_usd: spent,
      remaining_usd: Math.max(0, limit - spent),
      exceeded: spent >= limit,
    };
  });
  const exceededWindow = windows.find((window) => window.exceeded) || null;
  return {
    exceeded: Boolean(exceededWindow),
    exceeded_window: exceededWindow,
    windows,
    remaining_usd: Math.min(...windows.map((window) => window.remaining_usd)),
  };
}
