import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { getIndexFreshness } from "../index-freshness.js";

const execFileAsync = promisify(execFileCallback);

async function isAvailable(name, execFile) {
  try {
    await execFile("which", [name], { timeout: 2_000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function versionOf(name, args, execFile) {
  try {
    const result = await execFile(name, args, { timeout: 3_000, maxBuffer: 64 * 1024 });
    return String(result.stdout || result.stderr || "").trim().split(/\r?\n/, 1)[0].slice(0, 160) || null;
  } catch {
    return null;
  }
}

async function rtkGain(execFile) {
  try {
    const result = await execFile("rtk", ["gain", "--format", "json"], { timeout: 5_000, maxBuffer: 256 * 1024 });
    const summary = JSON.parse(result.stdout)?.summary;
    if (!summary || typeof summary !== "object") return null;
    const totalCommands = Number(summary.total_commands);
    const totalSaved = Number(summary.total_saved);
    const average = Number(summary.avg_savings_pct);
    if (![totalCommands, totalSaved, average].every(Number.isFinite)) return null;
    return { total_commands: totalCommands, total_saved: totalSaved, avg_savings_pct: average };
  } catch {
    return null;
  }
}

export async function collectToolInventory(root, options = {}) {
  const execFile = options.execFile || execFileAsync;
  const names = ["rtk", "rg", "agentify", "git", "claude", "codex", "pnpm", "npm", "yarn", "pytest", "cargo"];
  const availablePairs = await Promise.all(names.map(async (name) => [name, await isAvailable(name, execFile)]));
  const available = Object.fromEntries(availablePairs);
  const versions = {};
  for (const [name, args] of [["rtk", ["--version"]], ["rg", ["--version"]], ["agentify", ["--version"]], ["git", ["--version"]]]) {
    versions[name] = available[name] ? await versionOf(name, args, execFile) : null;
  }

  let indexStatus = options.indexStatus || null;
  if (!indexStatus && options.artifactPaths) {
    try {
      indexStatus = (await getIndexFreshness(root, options.artifactPaths)).index_status;
    } catch {
      indexStatus = "unknown";
    }
  }

  return {
    schema_version: "tool-inventory-v1",
    rtk: {
      available: available.rtk,
      version: versions.rtk,
      gain: available.rtk ? await rtkGain(execFile) : null,
    },
    rg: { available: available.rg, version: versions.rg },
    agentify: {
      available: available.agentify,
      version: versions.agentify,
      index_status: indexStatus || "unknown",
      index_fresh: indexStatus === "warm",
    },
    git: { available: available.git, version: versions.git },
    providers: {
      claude: { available: available.claude },
      codex: { available: available.codex },
    },
    package_managers: Object.fromEntries(["pnpm", "npm", "yarn", "cargo"].map((name) => [name, { available: available[name] }])),
    test_runners: { pytest: { available: available.pytest } },
  };
}
