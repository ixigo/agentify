import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getIndexFreshness } from "../index-freshness.js";

const execFileAsync = promisify(execFile);

export const TOOL_INVENTORY_SCHEMA_VERSION = "tool-inventory-v1";
export const RTK_GAIN_PARSER_VERSION = "rtk-gain-v1";

// Read-only capability checks. Every probe is a version/summary query with
// a short timeout; nothing here installs, mutates, scans, or executes
// anything recovered from session history.
const PROBES = [
  { name: "rtk", args: ["--version"] },
  { name: "rg", args: ["--version"] },
  { name: "git", args: ["--version"] },
  { name: "claude", args: ["--version"] },
  { name: "codex", args: ["--version"] },
];

async function probeVersion(command, args, exec) {
  try {
    const { stdout } = await exec(command, args, { timeout: 2_000 });
    const firstLine = String(stdout).split("\n")[0].trim();
    const version = firstLine.match(/\d+(?:\.\d+)+/)?.[0] || null;
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

// rtk gain exposes measured (not estimated) token savings. JSON first;
// a text fallback is parsed with a versioned regex and its coverage is
// reported so a format drift is visible instead of silent.
async function readRtkGain(exec) {
  try {
    const { stdout } = await exec("rtk", ["gain", "--format", "json"], { timeout: 4_000 });
    const parsed = JSON.parse(stdout);
    const summary = parsed?.summary;
    if (summary && Number.isFinite(Number(summary.total_saved))) {
      return {
        parser: RTK_GAIN_PARSER_VERSION,
        parse_coverage: "json",
        total_commands: Number(summary.total_commands) || 0,
        total_saved_tokens: Number(summary.total_saved) || 0,
        avg_savings_pct: Number.isFinite(Number(summary.avg_savings_pct)) ? Number(Number(summary.avg_savings_pct).toFixed(1)) : null,
      };
    }
    return { parser: RTK_GAIN_PARSER_VERSION, parse_coverage: "unrecognized-json" };
  } catch {
    return { parser: RTK_GAIN_PARSER_VERSION, parse_coverage: "unavailable" };
  }
}

export async function detectToolInventory({ root, artifactPaths = null, exec = execFileAsync } = {}) {
  const tools = {};
  await Promise.all(PROBES.map(async (probe) => {
    tools[probe.name] = await probeVersion(probe.name, probe.args, exec);
  }));

  if (tools.rtk.available) {
    tools.rtk.gain = await readRtkGain(exec);
  }

  let index = { status: "unknown" };
  if (root && artifactPaths) {
    try {
      const freshness = await getIndexFreshness(root, artifactPaths);
      index = { status: freshness?.index_status || "unknown", stale_reason: freshness?.stale_reason || null };
    } catch {
      index = { status: "unknown" };
    }
  }

  return {
    schema: TOOL_INVENTORY_SCHEMA_VERSION,
    tools,
    agentify_index: index,
    note: "Read-only capability probes (version/summary queries only). Nothing was installed, mutated, or executed from session history.",
  };
}
