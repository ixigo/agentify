import { RECOMMENDATION_SCHEMA_VERSION } from "./normalize.js";

// Every rule answers the same five questions: what was observed, why the
// alternative is better here, what to run, what impact provenance is, and
// how to verify. Rules that do not fire are reported with the reason so the
// report never looks like it silently covered everything.

function recommendation({ id, category, observed, suggestion, rationale, confidence, verification, caveat }) {
  return {
    schema: RECOMMENDATION_SCHEMA_VERSION,
    id,
    category,
    observed,
    suggestion,
    rationale,
    impact: "unavailable",
    confidence,
    verification,
    caveat,
  };
}

const RULES = [
  {
    id: "failed-command-repeats",
    category: "shell",
    evaluate(patterns, windowDays) {
      const repeats = patterns.repeated_failed_commands;
      if (repeats.fingerprints < 1) {
        return { suppressed: `no command failed more than once in the last ${windowDays} day(s)` };
      }
      return recommendation({
        id: "failed-command-repeats",
        category: "shell",
        observed: {
          commands_failing_repeatedly: repeats.fingerprints,
          max_repeats_of_one_command: repeats.max_repeats,
          failed_tool_calls: patterns.failed_tool_calls,
        },
        suggestion: {
          capability: "failed-command precheck",
          command: "agentify ctx precheck (installed automatically by `agentify install` hooks)",
        },
        rationale: "The same command (matched by irreversible fingerprint) failed more than once. Agentify's precheck hook surfaces the earlier failure before the agent re-runs it.",
        confidence: "high",
        verification: "After installing hooks, re-run `agentify analyze` for the next window and compare commands_failing_repeatedly.",
        caveat: "Fingerprints match exact normalized commands only; a slightly reworded failing command is not counted.",
      });
    },
  },
  {
    id: "broad-text-search",
    category: "search",
    evaluate(patterns, windowDays, inventory) {
      const broad = patterns.grep_like + patterns.find_like + patterns.cat_search_like;
      if (broad < 10) {
        return { suppressed: `only ${broad} broad grep/find/cat search command(s) observed in ${windowDays} day(s); threshold is 10` };
      }
      const rgMissing = inventory && inventory.tools?.rg?.available === false;
      const indexMissing = inventory && ["missing", "unknown"].includes(inventory.agentify_index?.status);
      return recommendation({
        id: "broad-text-search",
        category: "search",
        observed: {
          grep_like_commands: patterns.grep_like,
          find_like_commands: patterns.find_like,
          cat_then_search_commands: patterns.cat_search_like,
        },
        suggestion: {
          capability: "indexed structural queries",
          command: `agentify query search|def|refs|callers${indexMissing ? " (run `agentify scan` first — no fresh index found)" : " (after `agentify scan`)"}, or rg for plain text${rgMissing ? " (rg not detected: `brew install ripgrep`)" : ""}`,
        },
        rationale: "Repeated whole-tree text scans re-read the same files every session. An index answers symbol and reference questions once, and rg is measurably faster than grep -r on large trees.",
        confidence: "medium",
        verification: "Run `agentify scan`, then time `agentify query refs --symbol <name>` against your usual grep pipeline.",
        caveat: "Command classification is heuristic and counts invocations, not wall-clock time; small greps over streams are fine.",
      });
    },
  },
  {
    id: "rtk-token-compression",
    category: "shell",
    evaluate(patterns, windowDays, inventory) {
      if (!inventory) {
        return { suppressed: "tool inventory unavailable (library call without CLI probes)" };
      }
      const rtk = inventory.tools?.rtk;
      // "Installed" means VERIFIED working: a binary answering --version is
      // not enough (an unrelated tool also ships as `rtk`, and a present
      // binary with an uninitialized hook saves nothing).
      const gainWorks = rtk?.available && rtk.gain?.parse_coverage === "json";
      if (gainWorks) {
        const saved = rtk.gain.total_saved_tokens;
        return { suppressed: `rtk is already installed${Number.isFinite(saved) && saved > 0 ? ` and has measured ${saved.toLocaleString("en-US")} tokens saved (rtk gain)` : " and responding to rtk gain"}` };
      }
      if (patterns.opaque_shell_calls < 100) {
        return { suppressed: `only ${patterns.opaque_shell_calls} shell call(s) observed in ${windowDays} day(s); threshold for suggesting rtk is 100` };
      }
      return recommendation({
        id: "rtk-token-compression",
        category: "shell",
        observed: { shell_calls: patterns.opaque_shell_calls },
        suggestion: {
          capability: "command-output token compression",
          command: "install RTK Token Killer (github.com/rtk-ai/rtk) and let its hook wrap high-volume commands",
        },
        rationale: "A large share of agent context is command output. RTK compresses supported command output before the model reads it and measures the savings per command (`rtk gain`).",
        confidence: "low",
        verification: "After installing, run `rtk gain` for a week and compare total_saved against zero.",
        caveat: rtk?.available
          ? "A binary named rtk was detected but `rtk gain` did not respond as expected — it may be an unrelated tool or an incomplete install; verify against the RTK install guide. No savings are claimed in advance."
          : "No savings are claimed in advance: whether your specific commands are RTK-supported is only measurable after installation.",
      });
    },
  },
  {
    id: "full-test-suite-after-narrow-changes",
    category: "tests",
    evaluate(patterns, windowDays) {
      if (patterns.full_test_runs < 3) {
        return { suppressed: `only ${patterns.full_test_runs} full-suite test run(s) observed in ${windowDays} day(s); threshold is 3` };
      }
      return recommendation({
        id: "full-test-suite-after-narrow-changes",
        category: "tests",
        observed: {
          full_suite_runs: patterns.full_test_runs,
          focused_runs: patterns.focused_test_runs,
          files_edited: patterns.files_written,
        },
        suggestion: {
          capability: "impact-aware test selection",
          command: "agentify test --since <ref> --run",
        },
        rationale: "Full suites were run repeatedly while sessions edited a bounded set of files. Impact-aware selection runs only the tests the change can reach.",
        confidence: "medium",
        verification: "Run `agentify test --since origin/main` next time and compare the selected file count with the full suite.",
        caveat: "Selection depends on a fresh index (`agentify scan`); intentionally broad regression runs are still sometimes right.",
      });
    },
  },
  {
    id: "repeated-file-rereads",
    category: "context",
    evaluate(patterns, windowDays) {
      const rereads = patterns.files_reread_across_sessions;
      if (rereads.count < 2) {
        return { suppressed: `fewer than 2 files were re-read across 3+ sessions in ${windowDays} day(s)` };
      }
      return recommendation({
        id: "repeated-file-rereads",
        category: "context",
        observed: {
          files_reread_in_3plus_sessions: rereads.count,
          top_files: rereads.top,
        },
        suggestion: {
          capability: "durable notes and decisions",
          command: 'agentify ctx note "<gotcha>" / agentify ctx decision "chose X over Y because Z"',
        },
        rationale: "The same files were re-discovered session after session. A recorded note or decision is injected into later tasks instead of being re-read from scratch.",
        confidence: "medium",
        verification: "Record the recurring facts, then check `agentify value` for decisions-reused in the next window.",
        caveat: "Re-reading a hot file is sometimes necessary; injection proves availability, not that the agent acted on it.",
      });
    },
  },
  {
    id: "research-heavy-sessions",
    category: "delegation",
    evaluate(patterns, windowDays) {
      if (patterns.research_heavy_sessions < 2) {
        return { suppressed: `fewer than 2 read/search-dominated sessions with no edits in ${windowDays} day(s)` };
      }
      return recommendation({
        id: "research-heavy-sessions",
        category: "delegation",
        observed: {
          read_search_dominated_sessions: patterns.research_heavy_sessions,
          total_sessions: patterns.sessions,
        },
        suggestion: {
          capability: "budgeted research delegation",
          command: 'agentify delegate research "<question>"',
        },
        rationale: "Sessions dominated by reading and searching with no edits are lookups, not implementation. Routing them through `delegate research` runs them on a faster, cheaper route with a hard budget.",
        confidence: "low",
        verification: 'Try `agentify route explain "<the question>"` to preview the route and cap before delegating.',
        caveat: "Task content was not analyzed; the pattern is inferred from tool mix only and may include legitimate deep reviews.",
      });
    },
  },
  {
    id: "mechanical-sessions-on-default-route",
    category: "routing",
    evaluate(patterns, windowDays) {
      if (patterns.mechanical_candidate_sessions < 2) {
        return { suppressed: `fewer than 2 short low-tool-count edit sessions in ${windowDays} day(s)` };
      }
      return recommendation({
        id: "mechanical-sessions-on-default-route",
        category: "routing",
        observed: {
          short_edit_sessions: patterns.mechanical_candidate_sessions,
          total_sessions: patterns.sessions,
        },
        suggestion: {
          capability: "cost-aware routing for small edits",
          command: 'agentify delegate quick "<task>" --write, or delegate auto with --profile cost',
        },
        rationale: "Short sessions with a handful of edits and few tool calls are candidates for a cheaper route. This is a candidate, not a claim: no quality evidence from your evals was checked here.",
        confidence: "low",
        verification: "Run `agentify eval` paired benchmarks (or check existing runs) before shifting real work to a cheaper route.",
        caveat: "No savings are claimed: session outcome, model pricing, and quality evidence were not established from metadata alone.",
      });
    },
  },
];

export function buildOpportunities(patterns, { windowDays, inventory = null }) {
  const opportunities = [];
  const suppressed = [];
  for (const rule of RULES) {
    const result = rule.evaluate(patterns, windowDays, inventory);
    if (result.suppressed) {
      suppressed.push({ id: rule.id, category: rule.category, reason: result.suppressed });
    } else {
      opportunities.push(result);
    }
  }
  const confidenceRank = { high: 0, medium: 1, low: 2 };
  opportunities.sort((a, b) => confidenceRank[a.confidence] - confidenceRank[b.confidence]);
  return { opportunities, suppressed };
}

function formatTokensShort(value) {
  const count = Number(value) || 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

// Exactly one roast, chosen deterministically by the loudest signal, so the
// report stays reproducible for fixed fixtures. Tone: witty, never guilty.
export function buildRoast(patterns, totals, { windowDays }) {
  const repeats = patterns.repeated_failed_commands;
  if (repeats.fingerprints >= 1 && repeats.max_repeats >= 2) {
    return {
      text: `You re-ran a command that had already failed ${repeats.max_repeats} time(s). Einstein called that insanity; \`agentify ctx precheck\` calls it a Tuesday and stops you at the prompt.`,
      basis: `repeated_failed_commands: ${repeats.fingerprints} command fingerprint(s), max ${repeats.max_repeats} repeat(s)`,
    };
  }
  const broadSearches = patterns.grep_like + patterns.find_like + patterns.cat_search_like;
  if (broadSearches >= 15) {
    return {
      text: `${broadSearches} raw grep/find expeditions in ${windowDays} day(s). That's not searching, that's archaeology — \`agentify scan\` builds an index so you can stop carbon-dating your own code.`,
      basis: `broad_text_search_commands: ${broadSearches}`,
    };
  }
  const cacheRead = totals.usage.cache_read_tokens ?? 0;
  const freshInput = totals.usage.fresh_input_tokens ?? 0;
  if (freshInput > 0 && cacheRead / freshInput >= 20) {
    return {
      text: `Your sessions read ${formatTokensShort(cacheRead)} cached tokens against ${formatTokensShort(freshInput)} fresh ones — the model has your repo memorized. Pity the memory resets every session; \`agentify ctx\` is the part that doesn't.`,
      basis: `cache_read_to_fresh_ratio: ${(cacheRead / freshInput).toFixed(1)}x`,
    };
  }
  if ((patterns.longest_session_ms ?? 0) >= 4 * 60 * 60 * 1000) {
    const hours = (patterns.longest_session_ms / 3_600_000).toFixed(1);
    return {
      text: `Longest session: ${hours}h straight. Even the prompt cache expired and came back twice. Delegation exists (\`agentify delegate\`) — so does dinner.`,
      basis: `longest_session_ms: ${patterns.longest_session_ms}`,
    };
  }
  if (patterns.full_test_runs >= 3) {
    return {
      text: `${patterns.full_test_runs} full test-suite runs for changes that touched a handful of files. The suite appreciates the attention; \`agentify test --since\` would like to see other people.`,
      basis: `full_test_runs: ${patterns.full_test_runs}`,
    };
  }
  return {
    text: `Honestly? Hard to roast. ${patterns.sessions} session(s), ${totals.tool_calls} tool call(s), no obvious sins. The robots aren't taking your job — they're doing your chores.`,
    basis: "no dominant negative signal in this window",
  };
}
