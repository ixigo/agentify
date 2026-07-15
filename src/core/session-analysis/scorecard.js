import { USAGE_SCORECARD_SCHEMA_VERSION } from "./normalize.js";

// Same bar the routing policy uses (profiles.js): evidence below this
// volume or pass rate never upgrades a recommendation.
const EVIDENCE_MIN_ATTEMPTS = 5;
const EVIDENCE_QUALITY_FLOOR = 0.9;
const LOCAL_COMPARABLE_MIN = 3;

// The usage scorecard is the fun-but-honest layer on top of the metadata:
// each session gets a work-type guess, a "was this model the right weapon"
// verdict, and a 0-100 efficiency score built from token generation per
// turn, failure hygiene, cache behavior, and search discipline. Everything
// here is deterministic for fixed inputs so reports stay reproducible, and
// every playful line carries the numeric basis it was computed from.

export const WORK_TYPES = [
  "conversation",
  "research",
  "quick-fix",
  "implementation",
  "debugging",
  "mixed",
];

export const FIT_VERDICTS = ["overkill", "match", "underkill", "unknown"];

const READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "read_file", "list_dir", "grep_search"];
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"];

function countByNames(byName, names) {
  return names.reduce((sum, name) => sum + (byName[name] || 0), 0);
}

function sessionWrites(session) {
  const structured = session.file_access.filter((entry) => entry.operation === "write").length;
  return Math.max(structured, countByNames(session.tools.by_name, WRITE_TOOLS));
}

// Metadata-only heuristic, checked in strict priority order. "mixed" is the
// honest fallback, never a hidden guess.
export function classifyWorkType(session) {
  const calls = session.tools.calls;
  if (calls === 0) return "conversation";
  const writes = sessionWrites(session);
  const reads = countByNames(session.tools.by_name, READ_TOOLS);
  const testRuns = session.shell_patterns.full_test_run + session.shell_patterns.focused_test_run;
  if (session.failed_tool_calls >= 3 || (testRuns >= 2 && writes >= 1)) return "debugging";
  if (writes >= 1 && writes <= 2 && calls <= 12
    && session.active_ms !== null && session.active_ms <= 20 * 60 * 1000) return "quick-fix";
  if (writes >= 3 || (writes >= 1 && testRuns >= 1)) return "implementation";
  if (writes === 0 && reads >= 3 && reads / calls >= 0.6) return "research";
  return "mixed";
}

const MODEL_TIERS = [
  { tier: 0, label: "light", pattern: /haiku|mini|nano|flash|lite/i },
  { tier: 2, label: "heavy", pattern: /fable|mythos|opus|-pro\b|pro-|o1-pro/i },
  { tier: 1, label: "standard", pattern: /sonnet|gpt|codex|o[34]|claude/i },
];

export function modelTier(model) {
  const name = String(model || "");
  for (const entry of MODEL_TIERS) {
    if (entry.pattern.test(name)) return { tier: entry.tier, label: entry.label };
  }
  return { tier: null, label: "unknown" };
}

// The tier band a work type comfortably lives in. Above the band is
// overkill (the gun at the fist fight); below it is underkill.
const WORK_TYPE_TIER_BAND = {
  conversation: [0, 1],
  research: [0, 1],
  "quick-fix": [0, 1],
  implementation: [1, 2],
  debugging: [1, 2],
  mixed: [0, 2],
};

export function fitVerdict(workType, models) {
  const tiers = (models || []).map((model) => modelTier(model).tier).filter((tier) => tier !== null);
  if (tiers.length === 0) return "unknown";
  const heaviest = Math.max(...tiers);
  const [min, max] = WORK_TYPE_TIER_BAND[workType] || [0, 2];
  if (heaviest > max) return "overkill";
  if (heaviest < min) return "underkill";
  return "match";
}

const FIT_POINTS = { match: 30, underkill: 18, overkill: 10, unknown: 22 };

// 0-100, from five labeled components. Null-safe: dimensions the provider
// never reported fall back to a neutral middle instead of punishing the
// session for missing telemetry.
export function scoreSession(session, workType, fit) {
  const components = {};
  components.model_fit = FIT_POINTS[fit];

  const outputTokens = session.usage.output_tokens;
  const userTurns = session.turns?.user || 0;
  if (outputTokens !== null && userTurns > 0) {
    const perTurn = outputTokens / userTurns;
    components.turn_economy = perTurn <= 2_000 ? 25 : perTurn <= 6_000 ? 18 : perTurn <= 15_000 ? 10 : 5;
  } else {
    components.turn_economy = 15;
  }

  if (session.tools.calls > 0) {
    const failRate = session.failed_tool_calls / session.tools.calls;
    components.failure_hygiene = Math.round(20 * Math.max(0, 1 - failRate / 0.3));
  } else {
    components.failure_hygiene = 15;
  }

  const cacheRead = session.usage.cache_read_tokens;
  const freshInput = session.usage.fresh_input_tokens;
  if (cacheRead !== null && freshInput !== null && cacheRead + freshInput > 0) {
    const ratio = cacheRead / (cacheRead + freshInput);
    components.cache_efficiency = ratio >= 0.9 ? 15 : ratio >= 0.5 ? 10 : 6;
  } else {
    components.cache_efficiency = 8;
  }

  const broadSearches = session.shell_patterns.grep_like
    + session.shell_patterns.find_like
    + session.shell_patterns.cat_search_like;
  components.search_discipline = broadSearches === 0 ? 10 : broadSearches <= 4 ? 7 : broadSearches <= 9 ? 4 : 1;

  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score, components };
}

const GRADES = [
  { min: 90, grade: "S", quip: "Black-belt token economics. Sensei has nothing left to teach." },
  { min: 75, grade: "A", quip: "Sharp. The occasional flex, but the ammo bill is defensible." },
  { min: 60, grade: "B", quip: "Solid, with moments of “why is the flamethrower out for a spider”." },
  { min: 45, grade: "C", quip: "You fight fine, you just rent a tank to do it." },
  { min: 0, grade: "D", quip: "Every fist fight got an airstrike. The fist fights were winning anyway." },
];

function matchupQuip(fitCounts, heaviestModel, scored) {
  if (scored === 0) return { text: "No sessions to referee in this window.", signal: "none" };
  const { overkill, underkill, match, unknown } = fitCounts;
  if (overkill > 0 && overkill >= underkill && overkill / scored >= 0.3) {
    return {
      text: `You brought ${heaviestModel || "a heavyweight model"} to ${overkill} light-work session(s). That's not a gun at a fist fight — that's an orbital laser at a thumb war. \`agentify delegate quick\` holds the coats.`,
      signal: "overkill",
    };
  }
  if (underkill > 0 && underkill / scored >= 0.3) {
    return {
      text: `${underkill} session(s) sent a butter knife to a sword fight — a light model grinding through heavy work. \`agentify delegate heavy\` exists for exactly those.`,
      signal: "underkill",
    };
  }
  if (match >= unknown) {
    return {
      text: "Mostly fair fights: the model weight matched the work. The referee is pleasantly bored.",
      signal: "match",
    };
  }
  return {
    text: "The fighters wore masks — model metadata was too thin to call most matchups.",
    signal: "unknown",
  };
}

// Evidence ladder for "this could have run on a cheaper model" (#308):
// high = an eval-run model at a cheaper tier clears the routing quality
// floor with sufficient attempts; medium = this same analysis window
// contains repeated completed sessions of the same work type that ran on
// cheaper tiers; low = tier heuristic only, and it says so.
function delegationEvidence({ workType, routeEvidence, localComparable }) {
  for (const [key, stats] of Object.entries(routeEvidence?.models || {})) {
    const { tier } = modelTier(key.split(":")[1] || key);
    if (tier === null || tier >= 2) continue;
    if (stats.sufficient && stats.pass_rate !== null && stats.pass_rate >= EVIDENCE_QUALITY_FLOOR && stats.attempts >= EVIDENCE_MIN_ATTEMPTS) {
      return {
        confidence: "high",
        basis: `eval evidence: ${key} passed ${stats.passes}/${stats.attempts} attempt(s) (pass rate ${stats.pass_rate}) on a cheaper tier, above the ${EVIDENCE_QUALITY_FLOOR} quality floor`,
      };
    }
  }
  const comparable = localComparable[workType] || 0;
  if (comparable >= LOCAL_COMPARABLE_MIN) {
    return {
      confidence: "medium",
      basis: `local history: ${comparable} completed ${workType} session(s) in this window already ran on cheaper tiers`,
    };
  }
  return {
    confidence: "low",
    basis: "tier heuristic only — no eval or comparable local-history evidence was found for a cheaper route",
  };
}

export function buildScorecard(sessions, enriched, { routeEvidence = null } = {}) {
  const workTypes = Object.fromEntries(WORK_TYPES.map((type) => [type, 0]));
  const fitCounts = Object.fromEntries(FIT_VERDICTS.map((verdict) => [verdict, 0]));
  const workTypeSources = { metadata: 0, "content-hint": 0 };
  const componentTotals = {};
  let weightedScore = 0;
  let weightTotal = 0;
  let heaviestModel = null;
  let heaviestTier = -1;
  const delegationCandidates = [];
  let delegationWithheld = 0;

  // Completed sessions of each work type that already ran on cheaper
  // tiers — the "medium" rung of the delegation evidence ladder.
  const localComparable = {};
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (session.outcome?.status !== "completed") continue;
    const tiers = session.models.map((model) => modelTier(model).tier).filter((tier) => tier !== null);
    if (tiers.length === 0 || Math.max(...tiers) >= 2) continue;
    const type = enriched[index].work_type;
    localComparable[type] = (localComparable[type] || 0) + 1;
  }

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const extra = enriched[index];
    workTypes[extra.work_type] += 1;
    workTypeSources[extra.work_type_source === "content-hint" ? "content-hint" : "metadata"] += 1;
    fitCounts[extra.fit] += 1;
    const weight = session.tools.calls + (session.turns?.user || 0) + 1;
    weightedScore += extra.score * weight;
    weightTotal += weight;
    for (const [key, value] of Object.entries(extra.components)) {
      componentTotals[key] = (componentTotals[key] || 0) + value;
    }
    for (const model of session.models) {
      const { tier } = modelTier(model);
      if (tier !== null && tier > heaviestTier) {
        heaviestTier = tier;
        heaviestModel = model;
      }
    }
    if (extra.fit === "overkill") {
      // A cheaper-route candidate requires an outcome we can point at: a
      // session that failed (or whose ending is unknowable) must not be
      // pitched as if a lighter model would have succeeded.
      if (session.outcome?.status === "completed") {
        const evidence = delegationEvidence({ workType: extra.work_type, routeEvidence, localComparable });
        delegationCandidates.push({
          session_id: session.session_id,
          work_type: extra.work_type,
          models: session.models,
          outcome: session.outcome.status,
          confidence: evidence.confidence,
          evidence_basis: evidence.basis,
          suggestion: extra.work_type === "research"
            ? 'agentify delegate research "<question>"'
            : 'agentify delegate quick "<task>" --write',
        });
      } else {
        delegationWithheld += 1;
      }
    }
  }

  const scored = sessions.length;
  const overall = weightTotal > 0 ? Math.round(weightedScore / weightTotal) : null;
  const gradeEntry = overall === null ? null : GRADES.find((entry) => overall >= entry.min);
  const matchup = matchupQuip(fitCounts, heaviestModel, scored);

  return {
    schema: USAGE_SCORECARD_SCHEMA_VERSION,
    sessions_scored: scored,
    overall_score: overall,
    grade: gradeEntry ? gradeEntry.grade : null,
    grade_quip: gradeEntry ? gradeEntry.quip : "Nothing to grade in this window.",
    matchup: {
      text: matchup.text,
      signal: matchup.signal,
      basis: `fit: ${fitCounts.match} match / ${fitCounts.overkill} overkill / ${fitCounts.underkill} underkill / ${fitCounts.unknown} unknown across ${scored} session(s)`,
    },
    components_avg: Object.fromEntries(
      Object.entries(componentTotals).map(([key, total]) => [key, scored > 0 ? Math.round((total / scored) * 10) / 10 : null]),
    ),
    work_types: workTypes,
    work_type_sources: workTypeSources,
    fit: fitCounts,
    delegation_candidates: delegationCandidates.slice(0, 5),
    delegation_candidates_withheld: delegationWithheld,
    delegation_withheld_reason: delegationWithheld > 0
      ? "overkill session(s) without a completed outcome are not pitched for a cheaper route — success on a lighter model cannot be assumed for work that did not verifiably finish"
      : null,
    note: workTypeSources["content-hint"] > 0
      ? `Scores and verdicts are deterministic heuristics for orientation and entertainment. Work types come from tool mix, with ${workTypeSources["content-hint"]} session(s) refined by opt-in in-memory prompt classification; an “overkill” verdict is a delegation candidate, never proof a cheaper model would have succeeded.`
      : "Scores and verdicts are metadata-only heuristics for orientation and entertainment. Work types come from tool mix, not task content; an “overkill” verdict is a delegation candidate, never proof a cheaper model would have succeeded.",
  };
}
