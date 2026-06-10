export const CONTEXT_MODE_DEFAULT = "compact";
export const CONTEXT_MODE_PRIMARY_VALUES = Object.freeze(["compact", "routed"]);
export const CONTEXT_MODE_ALIASES = Object.freeze({
  direct: "compact",
});
export const CONTEXT_MODE_HELP_LABEL = `<${CONTEXT_MODE_PRIMARY_VALUES.join("|")}>`;
export const CONTEXT_MODE_DESCRIPTION = "Use compact prompts or routed bounded retrieval prompts";

function readContextMode(value, fallback) {
  const raw = value === undefined || value === null || value === false ? fallback : value;
  return {
    raw,
    mode: String(raw).trim().toLowerCase(),
  };
}

export function normalizeContextMode(value, { fallback = CONTEXT_MODE_DEFAULT } = {}) {
  const { raw, mode } = readContextMode(value, fallback);
  const normalized = CONTEXT_MODE_ALIASES[mode] || mode;
  if (CONTEXT_MODE_PRIMARY_VALUES.includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `--context-mode must be "compact" or "routed" ("direct" is accepted as an alias for "compact"), received "${raw}".`,
  );
}

export function toPlannerContextMode(value, { fallback = CONTEXT_MODE_DEFAULT } = {}) {
  const { mode } = readContextMode(value, fallback);
  if (mode === "selected") {
    return "selected";
  }
  return normalizeContextMode(mode, { fallback }) === "routed" ? "routed" : "selected";
}
