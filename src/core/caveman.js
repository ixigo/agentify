const CAVEMAN_LEVELS = new Set(["lite", "full", "ultra", "wenyan", "wenyan-lite", "wenyan-full", "wenyan-ultra"]);

export const CAVEMAN_PREAMBLE_MARKER = "## Caveman Output Mode";

export function normalizeCavemanLevel(value) {
  if (value === undefined || value === null || value === false) {
    return null;
  }

  const raw = String(value).trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0" || raw === "off" || raw === "normal" || raw === "none") {
    return null;
  }
  if (raw === "true" || raw === "1") {
    return "full";
  }
  if (!CAVEMAN_LEVELS.has(raw)) {
    throw new Error(
      `invalid caveman level "${value}". Supported levels: lite, full, ultra, wenyan, wenyan-lite, wenyan-full, wenyan-ultra`,
    );
  }
  return raw;
}

export function resolveCavemanLevel(args = {}, env = process.env) {
  if (Object.prototype.hasOwnProperty.call(args, "caveman")) {
    return normalizeCavemanLevel(args.caveman);
  }
  return normalizeCavemanLevel(env.AGENTIFY_CAVEMAN);
}

export function buildCavemanPreamble(level) {
  const normalized = normalizeCavemanLevel(level);
  if (!normalized) {
    return "";
  }

  return `${CAVEMAN_PREAMBLE_MARKER}
Respond in terse caveman style while preserving all technical accuracy.
Rules: drop articles, filler, pleasantries, and hedging. Fragments OK. Use short synonyms. Keep technical terms exact. Code blocks unchanged. Quote errors exactly.
Pattern: [thing] [action] [reason]. [next step].
Intensity: lite = tight full sentences; full = drop articles/fragments OK; ultra = abbreviations + arrows; wenyan-* = classical Chinese reduction.
Auto-clarity: suspend caveman for security warnings, irreversible confirmations, risky multi-step instructions, or explicit clarification requests. Resume after clear part.
Boundaries: commit messages, PR descriptions, and code content stay normal prose.
Active level: ${normalized}.`;
}

export function applyCavemanPreamble(prompt, level, options = {}) {
  const kind = String(options.promptKind || "agent").toLowerCase();
  if (kind === "commit" || kind === "commit-message" || kind === "pr" || kind === "pull-request") {
    return String(prompt || "").trim();
  }

  const preamble = buildCavemanPreamble(level);
  const body = String(prompt || "").trim();
  return [preamble, body].filter(Boolean).join("\n\n");
}
