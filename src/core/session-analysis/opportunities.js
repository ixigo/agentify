function sumPatterns(sessions) {
  const total = {};
  for (const session of sessions) {
    for (const [key, value] of Object.entries(session.tools?.patterns || {})) {
      total[key] = (total[key] || 0) + (Number(value) || 0);
    }
  }
  return total;
}

function recommendation(fields) {
  return { schema: "recommendation-v1", ...fields };
}

export function buildRecommendations(sessions, inventory = {}) {
  const patterns = sumPatterns(sessions);
  const recommendations = [];
  const suppressed = [];
  const unwrappedSupportedCalls = patterns.unwrapped_rtk_supported_calls || 0;

  if (inventory.rtk?.available && unwrappedSupportedCalls >= 3) {
    const gain = inventory.rtk.gain;
    recommendations.push(recommendation({
      id: "use-rtk-for-supported-shells",
      category: "shell",
      observed: {
        shell_calls: patterns.shell_calls || 0,
        supported_shell_calls: patterns.rtk_supported_calls || 0,
        rtk_wrapped_calls: patterns.rtk_wrapped_calls || 0,
        unwrapped_supported_calls: unwrappedSupportedCalls,
      },
      suggestion: { capability: "RTK output compression", command: "rtk <supported-command>" },
      rationale: "The analyzed sessions repeatedly ran supported shell commands without RTK, while RTK is installed locally.",
      impact: gain
        ? {
            provenance: "measured",
            summary: `Local RTK counters report ${gain.total_saved} tokens removed across ${gain.total_commands} commands (${Number(gain.avg_savings_pct).toFixed(1)}% average).`,
          }
        : { provenance: "expected", summary: "Lower tool-output volume is expected, but no local RTK gain counters were available." },
      confidence: gain ? "high" : "medium",
      verification: "Run the same workflow with RTK prefixes, then inspect `rtk gain --format json`.",
      caveat: "RTK savings are aggregate local measurements, not a counterfactual for these exact historical commands.",
    }));
  } else {
    suppressed.push({
      id: "use-rtk-for-supported-shells",
      reason: inventory.rtk?.available ? "fewer than three unwrapped supported shell calls were observed" : "RTK is not available",
    });
  }

  const legacySearchCalls = (patterns.grep_calls || 0) + (patterns.find_calls || 0) + (patterns.cat_calls || 0);
  if (inventory.rg?.available && legacySearchCalls >= 3) {
    recommendations.push(recommendation({
      id: "prefer-focused-search-tools",
      category: "search",
      observed: {
        grep_calls: patterns.grep_calls || 0,
        find_calls: patterns.find_calls || 0,
        cat_calls: patterns.cat_calls || 0,
      },
      suggestion: { capability: "focused repository search", command: "rg <pattern> <path>  # use `rg --files` for file discovery" },
      rationale: "Repeated recursive search and file-dump patterns can produce more output than a scoped ripgrep query.",
      impact: { provenance: "expected", summary: "Expected lower scan and output volume; no historical replay was performed." },
      confidence: "medium",
      verification: "Compare result coverage and output size on one repeated search using `rg` or `rg --files`.",
      caveat: "grep and cat remain appropriate for small streams and exact single-file reads.",
    }));
  } else {
    suppressed.push({
      id: "prefer-focused-search-tools",
      reason: inventory.rg?.available ? "insufficient repeated broad-search evidence" : "rg is not available",
    });
  }

  if ((patterns.broad_test_calls || 0) > 0 && inventory.agentify?.index_fresh) {
    recommendations.push(recommendation({
      id: "select-focused-tests",
      category: "tests",
      observed: { broad_test_calls: patterns.broad_test_calls || 0 },
      suggestion: { capability: "Agentify test selection", command: "agentify test --since <ref> --run" },
      rationale: "At least one full-suite test command was observed while a fresh Agentify index is available.",
      impact: { provenance: "expected", summary: "Expected fewer test files; exact savings require a before/after selection run." },
      confidence: "medium",
      verification: "Run `agentify test --since <ref> --json` and compare selected files with the full suite.",
      caveat: "Focused tests complement rather than replace required full CI coverage.",
    }));
  } else {
    suppressed.push({
      id: "select-focused-tests",
      reason: (patterns.broad_test_calls || 0) === 0
        ? "no broad test runs were observed"
        : "the Agentify index is unavailable or stale, so selection evidence cannot be established",
    });
  }

  const fileSessions = new Map();
  for (const session of sessions) {
    for (const event of session.file_access || []) {
      if (event.path === "<external>") continue;
      const key = `${session.project?.alias || "project"}:${event.path}`;
      if (!fileSessions.has(key)) fileSessions.set(key, new Set());
      fileSessions.get(key).add(session.session_id);
    }
  }
  const repeatedFiles = [...fileSessions.values()].filter((ids) => ids.size >= 2).length;
  if (repeatedFiles > 0 && inventory.agentify?.available) {
    recommendations.push(recommendation({
      id: "reuse-repository-context",
      category: "context",
      observed: { files_rediscovered_across_sessions: repeatedFiles },
      suggestion: { capability: "Agentify context", command: "agentify ctx note \"<durable fact>\"  # use ctx decision for settled choices" },
      rationale: "The same repository paths were accessed across multiple sessions, indicating repeat discovery work.",
      impact: { provenance: "expected", summary: "Expected less repeated orientation; this analyzer cannot prove future context will be acted on." },
      confidence: "medium",
      verification: "Record one durable note, start a related session, and inspect `agentify ctx match \"<task>\"`.",
      caveat: "Only durable, non-sensitive facts should be recorded; stale context must still be reviewed.",
    }));
  } else {
    suppressed.push({ id: "reuse-repository-context", reason: "no repeated cross-session file access was established" });
  }

  for (const [id, reason] of [
    ["precheck-repeated-failures", "no normalized command with repeated observed failures was established"],
    ["use-structural-queries", "equivalent repeated symbol/caller searches were not established"],
    ["delegate-cheaper-candidate", "successful comparable-task quality and price evidence were not both available"],
    ["split-research-or-review", "phase-level time and token concentration was not available"],
  ]) {
    suppressed.push({ id, reason });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.id.localeCompare(b.id));
  suppressed.sort((a, b) => a.id.localeCompare(b.id));
  return { recommendations, suppressed, patterns };
}
