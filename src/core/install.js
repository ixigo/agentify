import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBaselineArtifacts, runScan } from "./commands.js";
import { writeDefaultConfig } from "./config.js";
import { exists } from "./fs.js";
import { loadContextSnapshot, renderContextDigest } from "./ctx.js";
import {
  MCP_REGISTRABLE_PROVIDERS,
  MCP_SERVER_ALIAS,
  installIntegration,
  registerMcpServer,
} from "./integrations.js";
import { detectCapabilities } from "./toolchain.js";
import { buildConfigAudit } from "./session-analysis/config-audit.js";

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// A no-op reporter so a best-effort index build never prints into the install
// receipt or breaks the single-payload JSON contract. runScan is invoked the
// same way `agentify check` invokes it internally (skipOutput + skipFinalize).
function silentReporter() {
  const noop = () => {};
  return {
    log: noop,
    setCommand: noop,
    setScan: noop,
    setDoc: noop,
    setValidation: noop,
    setTests: noop,
    setExecution: noop,
    percent: noop,
    json: noop,
    finalize: async () => {},
  };
}

// The first-run win. Prefer real signal from prior local sessions (recent
// activity, hot files, unresolved failures); when the repo has no Agentify
// history at all, fall back to the setup audit so the very first run still
// pays for itself. claudeHome/codexHome are derived from homeDir so the audit
// reads the same home the rest of the install targets.
export async function buildFirstRunWin(root, options = {}) {
  const snapshot = await loadContextSnapshot(root, { maxNotes: 10, verifyNotes: false });
  const digest = renderContextDigest(snapshot);
  if (digest && digest.trim()) {
    const summary = snapshot.summary || {};
    return {
      source: "history",
      headline: "Recent activity from your local sessions",
      digest,
      hot_files: summary.hotFiles || [],
      unresolved_failures: summary.unresolvedFailures || [],
      read: ["local Agentify session history"],
    };
  }

  const claudeHome = options.claudeHome || path.join(options.homeDir || os.homedir(), ".claude");
  const codexHome = options.codexHome || path.join(options.homeDir || os.homedir(), ".codex");
  const audit = await buildConfigAudit({ claudeHome, codexHome });
  return {
    source: "config-audit",
    headline: "Setup audit (no prior Agentify sessions yet)",
    findings: audit.findings,
    homes: audit.homes,
    always_loaded_token_estimate: {
      claude: audit.claude?.always_loaded_token_estimate || 0,
      codex: audit.codex?.always_loaded_token_estimate || 0,
    },
    read: [claudeHome, codexHome],
  };
}

function normalizeProviderInfo(provider, capabilities) {
  const info = capabilities?.providers?.[provider] || {};
  return {
    provider,
    installed: Boolean(info.available),
    version: info.available ? info.version || null : null,
    auth: {
      state: info.auth?.state || "unknown",
      detail: info.auth?.detail || null,
      next_step: info.auth?.next_step || null,
    },
  };
}

// One-command install orchestrator (#338). Detects providers, registers the
// Agentify MCP server with each, wires guidance + hooks, builds the index, and
// assembles a first-run win — returning a receipt of what was detected,
// registered, written, and read. It never prints (the CLI renders the receipt)
// and never throws on a present-but-unauthenticated provider: that is a
// warning-and-continue, not a hard failure. `detect` is injectable so tests
// and callers can supply provider state without shelling out to real CLIs.
export async function runOneCommandInstall(root, config = {}, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const dryRun = config.dryRun === true;
  const isGlobal = options.global === true;
  const skipMcp = options.skipMcp === true;
  const buildIndex = options.buildIndex !== false;

  const detect = options.detect || (() => detectCapabilities({ ...config, root, homeDir }));
  const capabilities = await detect();
  const providerInfos = MCP_REGISTRABLE_PROVIDERS.map((provider) => normalizeProviderInfo(provider, capabilities));
  const installedProviders = providerInfos.filter((info) => info.installed);

  // Explicit --provider wins; otherwise configure whatever is installed, and
  // fall back to Claude when nothing is detected so a bare CLI environment
  // still gets a working default (matches prior install behaviour).
  const requested = Array.isArray(options.providers) && options.providers.length ? options.providers : null;
  const integrationProviders = requested
    || (installedProviders.length ? installedProviders.map((info) => info.provider) : ["claude"]);
  const mcpProviders = (requested
    ? requested.filter((provider) => MCP_REGISTRABLE_PROVIDERS.includes(provider))
    : installedProviders.map((info) => info.provider));

  // Auth warnings are phrased against what this run actually registers: only a
  // provider that is in the MCP set (and not skipped) gets the "still
  // registered" reassurance; others just get a heads-up to log in.
  const willRegister = new Set(skipMcp ? [] : mcpProviders);
  const warnings = [];
  for (const info of providerInfos) {
    if (info.installed && info.auth.state === "missing") {
      const step = info.auth.next_step || `${info.provider} login`;
      const suffix = willRegister.has(info.provider)
        ? "Agentify was still registered (auth is separate) — "
        : "";
      warnings.push(`${info.provider} is installed but not authenticated (${info.auth.detail || "login required"}). ${suffix}run \`${step}\` when ready.`);
    }
  }

  // `wrote` records only paths that actually changed on disk, so the receipt
  // is an accurate record rather than an aspirational list.
  const wrote = [];
  const pushWrote = (file) => {
    if (file && !wrote.includes(file)) {
      wrote.push(file);
    }
  };
  if (!isGlobal && !dryRun) {
    // Baseline scaffolding is written-if-missing and, for .gitignore, updated
    // in place. Snapshot each file's content beforehand and report it only when
    // it was created or actually changed, so the receipt stays accurate on a
    // partially-initialized repo.
    const baselineFiles = [".agentify.yaml", ".gitignore", ".agentignore", ".guardrails"];
    const before = new Map();
    for (const file of baselineFiles) {
      before.set(file, await readFileOrNull(path.join(root, file)));
    }
    const agentifyDirBefore = await exists(path.join(root, ".agentify"));

    await writeDefaultConfig(root, config, { dryRun });
    await ensureBaselineArtifacts(root, config);

    for (const file of baselineFiles) {
      const after = await readFileOrNull(path.join(root, file));
      if (after !== null && after !== before.get(file)) {
        pushWrote(file);
      }
    }
    if (!agentifyDirBefore && await exists(path.join(root, ".agentify"))) {
      pushWrote(".agentify");
    }
  }

  const integrations = [];
  for (const provider of integrationProviders) {
    const integration = await installIntegration(root, { provider, global: isGlobal, homeDir, dryRun });
    integrations.push(integration);
    if (!dryRun) {
      if (integration.memory?.changed) {
        pushWrote(integration.memory.path);
      }
      if (integration.settings?.changed && integration.settings.path) {
        pushWrote(integration.settings.path);
      }
      // The plan-renderer script is written separately from settings.json.
      if (integration.settings?.renderer?.changed && integration.settings.renderer.path) {
        pushWrote(integration.settings.renderer.path);
      }
    }
  }

  const registrations = [];
  if (!skipMcp) {
    for (const provider of mcpProviders) {
      const registration = await registerMcpServer({ provider, root, homeDir, dryRun });
      registrations.push(registration);
      if (!dryRun && registration.changed && registration.path) {
        pushWrote(registration.path);
      }
      if (registration.backup) {
        pushWrote(registration.backup);
      }
    }
  }

  let index = { built: false, status: "skipped" };
  if (buildIndex && !isGlobal && !dryRun) {
    // The index build is best-effort. runScan's lock-contention path sets
    // process.exitCode = 1 without throwing; capture and restore the exit code
    // so a transient lock never fails the whole install, and report the block
    // honestly in the receipt instead of a green result.
    const priorExitCode = process.exitCode;
    try {
      const scan = await runScan(root, config, {
        reporter: silentReporter(),
        skipOutput: true,
        skipFinalize: true,
      });
      const blocked = scan.status === "blocked";
      index = {
        built: !blocked,
        status: blocked ? "blocked" : (scan.index_status || scan.status || "built"),
        wrote: scan.wrote || [],
      };
      if (blocked) {
        process.exitCode = priorExitCode;
      } else {
        for (const file of scan.wrote || []) {
          pushWrote(file);
        }
      }
    } catch (error) {
      process.exitCode = priorExitCode;
      index = { built: false, status: "error", error: error?.message || String(error) };
    }
  } else if (isGlobal) {
    index = { built: false, status: "skipped_global" };
  } else if (dryRun) {
    index = { built: false, status: "skipped_dry_run" };
  }

  const firstRun = await buildFirstRunWin(root, { homeDir });

  // ACP client registration depends on #335. Detect its capability rather than
  // assume it: skip cleanly and say so in the receipt if it is not on this build.
  const acp = {
    supported: false,
    clients: [],
    note: "ACP client registration is not available on this build (depends on #335). No ACP client config was read or written.",
  };

  const read = [];
  for (const info of providerInfos) {
    read.push(`${info.provider} CLI (${info.installed ? `v${info.version}` : "not installed"})`);
  }
  for (const registration of registrations) {
    if (registration.path) {
      read.push(`${registration.path}${registration.existed ? "" : " (absent)"}`);
    }
  }
  for (const source of firstRun.read || []) {
    read.push(source);
  }

  // A registration that did not take (unparseable config, a conflicting Codex
  // table) is a real failure of the command's primary job — surface it as a
  // warning and let the caller reflect it in the exit code.
  const registrationErrors = registrations.filter((registration) => registration.error);
  for (const registration of registrationErrors) {
    warnings.push(`MCP registration for ${registration.provider} did not complete: ${registration.error}`);
  }
  const ok = registrationErrors.length === 0;

  return {
    command: "install",
    root,
    scope: isGlobal ? "global" : "project",
    dry_run: dryRun,
    ok,
    detected: { providers: providerInfos, acp },
    integrations,
    mcp: {
      alias: MCP_SERVER_ALIAS,
      home_dir: homeDir,
      skipped: skipMcp,
      registrations,
    },
    index,
    first_run: firstRun,
    warnings,
    acp,
    wrote,
    read,
  };
}
