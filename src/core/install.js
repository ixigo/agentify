import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBaselineArtifacts, runScan } from "./commands.js";
import { writeDefaultConfig } from "./config.js";
import { exists } from "./fs.js";
import { ensureAgentifyGitignore } from "./gitignore.js";
import { loadContextSnapshot, renderContextDigest } from "./ctx.js";
import {
  MCP_REGISTRABLE_PROVIDERS,
  MCP_SERVER_ALIAS,
  installIntegration,
  registerMcpServer,
} from "./integrations.js";
import { detectCapabilities } from "./toolchain.js";
import { buildConfigAudit } from "./session-analysis/config-audit.js";

function createInstallProgress(onProgress, now = Date.now) {
  const emit = typeof onProgress === "function" ? onProgress : () => {};
  const installStartedAt = now();
  const phaseStartedAt = new Map();
  const phases = {};

  function dispatch(event) {
    try {
      const pending = emit(event);
      if (pending && typeof pending.then === "function") {
        void Promise.resolve(pending).catch(() => {});
      }
    } catch {
      // Progress is presentation-only and must never make installation fail.
    }
  }

  return {
    start(id, message) {
      phaseStartedAt.set(id, now());
      dispatch({ id, status: "start", message });
    },
    finish(id, status, message) {
      const startedAt = phaseStartedAt.get(id) ?? now();
      const durationMs = Math.max(0, now() - startedAt);
      phases[id] = durationMs;
      phaseStartedAt.delete(id);
      dispatch({ id, status, message, duration_ms: durationMs });
    },
    summary() {
      return {
        total_ms: Math.max(0, now() - installStartedAt),
        phases: { ...phases },
      };
    },
  };
}

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
  const progress = createInstallProgress(options.onProgress, options.now);

  const detect = options.detect || (() => detectCapabilities({ ...config, root, homeDir }));
  progress.start("detect", "Checking tools and AI providers");
  let capabilities;
  try {
    capabilities = await detect();
  } catch (error) {
    progress.finish("detect", "error", "Could not inspect tools and AI providers");
    throw error;
  }
  const providerInfos = MCP_REGISTRABLE_PROVIDERS.map((provider) => normalizeProviderInfo(provider, capabilities));
  const installedProviders = providerInfos.filter((info) => info.installed);
  progress.finish(
    "detect",
    "complete",
    installedProviders.length === 1
      ? `Detected ${installedProviders[0].provider}`
      : `Detected ${installedProviders.length} installed AI providers`,
  );

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
  const generatedIgnorePatterns = [];
  const pushWrote = (file) => {
    if (file && !wrote.includes(file)) {
      wrote.push(file);
    }
  };
  progress.start(
    "workspace",
    dryRun
      ? isGlobal ? "Previewing global configuration" : "Previewing project files"
      : isGlobal ? "Preparing global configuration" : "Preparing project files",
  );
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
      if (file !== ".gitignore" && before.get(file) === null && after !== null) {
        generatedIgnorePatterns.push(`/${file}`);
      }
    }
    if (!agentifyDirBefore && await exists(path.join(root, ".agentify"))) {
      pushWrote(".agentify");
    }
  }
  progress.finish(
    "workspace",
    "complete",
    dryRun
      ? isGlobal ? "Global configuration previewed" : "Project files previewed"
      : isGlobal ? "Global configuration ready" : "Project files ready",
  );

  const integrations = [];
  progress.start("integrations", dryRun ? "Previewing guidance and hooks" : "Wiring guidance and hooks");
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
      if (!isGlobal
        && integration.settings?.path
        && integration.settings.existed === false
        && integration.settings.changed) {
        const relative = path.relative(root, integration.settings.path);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          generatedIgnorePatterns.push(`/${relative.split(path.sep).join("/")}`);
        }
      }
      if (!isGlobal
        && integration.settings?.renderer?.path
        && integration.settings.renderer.existed === false
        && integration.settings.renderer.changed) {
        const relative = path.relative(root, integration.settings.renderer.path);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          generatedIgnorePatterns.push(`/${relative.split(path.sep).join("/")}`);
        }
      }
    }
  }

  if (!isGlobal && generatedIgnorePatterns.length > 0) {
    const gitignore = await ensureAgentifyGitignore(root, {
      dryRun,
      additionalPatterns: generatedIgnorePatterns,
    });
    if (!dryRun && gitignore.changed) {
      pushWrote(".gitignore");
    }
  }
  progress.finish(
    "integrations",
    "complete",
    `Guidance and hooks ${dryRun ? "previewed" : "ready"} for ${integrationProviders.join(", ")}`,
  );

  const registrations = [];
  progress.start(
    "mcp",
    skipMcp ? "Skipping MCP registration" : dryRun ? "Previewing MCP registration" : "Registering the MCP server",
  );
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
  const registrationIssues = registrations.filter((registration) => registration.error);
  progress.finish(
    "mcp",
    registrationIssues.length > 0 ? "warning" : "complete",
    skipMcp
      ? "MCP registration skipped"
      : registrationIssues.length > 0
        ? "MCP registration finished with issues"
        : registrations.length === 0
          ? "No installed provider needed MCP registration"
          : `MCP registration ${dryRun ? "previewed" : "ready"} for ${registrations.map((item) => item.provider).join(", ")}`,
  );

  let index = { built: false, status: "skipped" };
  progress.start("index", buildIndex && !isGlobal && !dryRun ? "Building repository index" : "Checking repository index");
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
  progress.finish(
    "index",
    index.status === "error" || index.status === "blocked" ? "warning" : "complete",
    index.built
      ? `Repository index ${index.status}`
      : index.status === "error"
        ? "Repository index could not be built"
        : index.status === "blocked"
          ? "Repository index is busy in another process"
          : "Repository index skipped",
  );

  progress.start("summary", "Preparing first-run summary");
  let firstRun;
  try {
    firstRun = await buildFirstRunWin(root, { homeDir });
  } catch (error) {
    progress.finish("summary", "error", "Could not prepare the first-run summary");
    throw error;
  }
  progress.finish("summary", "complete", "First-run summary ready");

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
  const registrationErrors = registrationIssues;
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
    timings: progress.summary(),
  };
}
