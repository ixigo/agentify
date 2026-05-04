import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { listSemanticProjects } from "./db/semantic-store.js";
import { exists } from "./fs.js";
import {
  computeSemanticProjectFingerprint,
  discoverSemanticProjectParseFailures,
  discoverSemanticProjects,
} from "./semantic.js";
import * as ui from "./ui.js";

const execFileAsync = promisify(execFile);
const AGENTIFY_EXIT_SEMANTIC_STALE = 80;

const TOOLS = {
  rg: { minVersion: "13.0.0", tier: 1, purpose: "fast text search" },
  fd: { minVersion: "8.0.0", tier: 1, purpose: "fast file enumeration" },
  "ast-grep": { minVersion: "0.20.0", tier: 2, purpose: "structural pattern queries" },
  "tree-sitter": { minVersion: "0.22.0", tier: 2, purpose: "parser-backed symbol extraction" },
  mempalace: {
    minVersion: null,
    tier: "optional",
    purpose: "session memory recall",
    detectMode: "command-exists",
    commandEnv: "AGENTIFY_MEMPALACE_CMD",
  },
  zoekt: { minVersion: null, tier: "optional", purpose: "indexed code search at scale" },
};

function getConfiguredToolCommand(name, spec = {}) {
  if (!spec.commandEnv) {
    return name;
  }

  const configured = String(process.env[spec.commandEnv] || "").trim();
  return configured || name;
}

async function resolveToolCommand(command) {
  if (command.includes("/") || command.includes("\\")) {
    await fs.access(command, fsConstants.X_OK);
    return command;
  }
  const { stdout } = await execFileAsync("sh", ["-lc", 'command -v -- "$0"', command]);
  return stdout.trim() || command;
}

async function detectTool(name, spec = {}) {
  const command = getConfiguredToolCommand(name, spec);

  if (spec.detectMode === "command-exists") {
    try {
      const resolvedCommand = await resolveToolCommand(command);
      return {
        available: true,
        version: "unknown",
        path: resolvedCommand,
      };
    } catch {
      return { available: false, version: null, path: null };
    }
  }

  try {
    const { stdout } = await execFileAsync(command, ["--version"]);
    const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
    return {
      available: true,
      version: versionMatch ? versionMatch[1] : "unknown",
      path: command,
    };
  } catch {
    return { available: false, version: null, path: null };
  }
}

export async function detectCapabilities(config = {}) {
  const results = {};
  for (const [name, spec] of Object.entries(TOOLS)) {
    if (name === "zoekt" && !config.toolchain?.zoekt) {
      results[name] = { ...spec, available: false, version: null, reason: "opt-in disabled" };
      continue;
    }
    const detection = await detectTool(name, spec);
    results[name] = { ...spec, ...detection };
  }

  const tier1Ready = results.rg.available && results.fd.available;
  const tier2Ready = tier1Ready && results["ast-grep"].available && results["tree-sitter"].available;

  return {
    tools: results,
    tier: tier2Ready ? 2 : tier1Ready ? 1 : 0,
    zoekt: results.zoekt.available,
  };
}

export function getAdapter(capabilities) {
  return {
    fileSearch: capabilities.tools.fd.available ? "fd" : "native",
    textSearch: capabilities.tools.rg.available ? "rg" : "native",
    structural: capabilities.tools["ast-grep"].available ? "ast-grep" : null,
    symbols: capabilities.tools["tree-sitter"].available ? "tree-sitter" : null,
    indexed: capabilities.zoekt ? "zoekt" : null,
  };
}

function getInstallHint(name) {
  const hints = {
    rg: "brew install ripgrep / cargo install ripgrep",
    fd: "brew install fd / cargo install fd-find",
    "ast-grep": "cargo install ast-grep / npm i -g @ast-grep/cli",
    "tree-sitter": "cargo install tree-sitter-cli / npm i -g tree-sitter-cli",
    mempalace: "install MemPalace and keep `mempalace` on PATH, or set AGENTIFY_MEMPALACE_CMD",
    zoekt: "go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest",
  };
  return hints[name] || `install ${name}`;
}

function projectLabel(project) {
  return project.config_path || project.configPath || "inferred";
}

function buildSemanticTrendHints(project, stale) {
  const hints = [];
  if (!project.indexed) {
    hints.push("Run `agentify semantic refresh` to create the first semantic snapshot.");
    return hints;
  }
  if (project.status !== "ready") {
    hints.push("Last semantic analysis did not finish cleanly; rerun refresh after fixing the reported error.");
  }
  if (Number(project.coverage_ratio || 0) < 1) {
    hints.push("Coverage is partial; inspect excluded, unreadable, or unsupported files.");
  }
  if (stale) {
    hints.push("Content fingerprint changed since the last refresh; counts may be outdated.");
  }
  if (project.status === "ready" && Number(project.coverage_ratio || 0) >= 1 && !stale) {
    hints.push("Semantic snapshot is current.");
  }
  return hints;
}

async function buildSemanticDoctorReport(root, config) {
  const discoveredProjects = await discoverSemanticProjects(root);
  const parseFailures = await discoverSemanticProjectParseFailures(root);
  const discoveredById = new Map(discoveredProjects.map((project) => [project.id, project]));
  const discoveredIds = new Set(discoveredById.keys());
  const dbPath = `${root}/.agents/index.db`;
  const indexPresent = await exists(dbPath);
  const failures = [];
  const staleFingerprints = [];
  let indexedProjects = [];

  if (indexPresent) {
    const db = openIndexDatabase(root, { readOnly: true });
    try {
      indexedProjects = listSemanticProjects(db);
    } finally {
      closeIndexDatabase(db);
    }
  } else if (discoveredProjects.length > 0) {
    failures.push({
      category: "missing-index",
      project_id: null,
      message: "missing .agents/index.db; run `agentify scan` and `agentify semantic refresh`",
    });
  }
  for (const failure of parseFailures) {
    failures.push({
      category: "parse-failed",
      project_id: `config:${failure.config_path}`,
      message: failure.message,
    });
  }

  const indexedById = new Map(indexedProjects.map((project) => [project.project_id, project]));
  const projects = [];

  for (const discovered of discoveredProjects) {
    const indexed = indexedById.get(discovered.id);
    const currentFingerprint = await computeSemanticProjectFingerprint(root, discovered.filePaths);
    const stale = Boolean(indexed && indexed.content_fingerprint !== currentFingerprint);
    if (stale) {
      staleFingerprints.push({
        project_id: discovered.id,
        stored_content_fingerprint: indexed.content_fingerprint,
        current_content_fingerprint: currentFingerprint,
      });
    }
    if (!indexed) {
      failures.push({
        category: "missing-snapshot",
        project_id: discovered.id,
        message: "semantic project has no indexed snapshot; run `agentify semantic refresh`",
      });
    } else {
      if (indexed.status !== "ready") {
        failures.push({
          category: "analysis-failed",
          project_id: indexed.project_id,
          message: indexed.last_error || `semantic project status is ${indexed.status}`,
        });
      }
      if (Number(indexed.coverage_ratio || 0) < 1) {
        failures.push({
          category: "partial-coverage",
          project_id: indexed.project_id,
          message: `semantic coverage is ${indexed.coverage_ratio}`,
        });
      }
    }

    projects.push({
      project_id: discovered.id,
      config_path: discovered.configPath,
      project_root: discovered.projectRoot,
      inferred: Boolean(discovered.inferred),
      indexed: Boolean(indexed),
      status: indexed?.status || "missing",
      coverage_ratio: indexed?.coverage_ratio ?? 0,
      file_count: indexed?.file_count ?? discovered.filePaths.length,
      discovered_file_count: discovered.filePaths.length,
      symbol_count: indexed?.symbol_count ?? 0,
      surface_count: indexed?.surface_count ?? 0,
      edge_count: indexed?.edge_count ?? 0,
      content_fingerprint: indexed?.content_fingerprint || null,
      current_content_fingerprint: currentFingerprint,
      public_fingerprint: indexed?.public_fingerprint || null,
      stale,
      last_error: indexed?.last_error || null,
      trend_hints: buildSemanticTrendHints(indexed ? { ...indexed, indexed: true } : { indexed: false }, stale),
    });
  }

  for (const indexed of indexedProjects) {
    if (discoveredIds.has(indexed.project_id)) {
      continue;
    }
    failures.push({
      category: "orphaned-snapshot",
      project_id: indexed.project_id,
      message: "semantic snapshot no longer matches a discovered TS/JS project; run `agentify semantic refresh`",
    });
    projects.push({
      project_id: indexed.project_id,
      config_path: indexed.config_path,
      project_root: indexed.project_root,
      inferred: Boolean(indexed.inferred),
      indexed: true,
      status: indexed.status,
      coverage_ratio: indexed.coverage_ratio,
      file_count: indexed.file_count,
      discovered_file_count: 0,
      symbol_count: indexed.symbol_count,
      surface_count: indexed.surface_count,
      edge_count: indexed.edge_count,
      content_fingerprint: indexed.content_fingerprint,
      current_content_fingerprint: null,
      public_fingerprint: indexed.public_fingerprint,
      stale: true,
      last_error: indexed.last_error || null,
      trend_hints: ["Project is no longer discovered; refresh to remove stale semantic rows."],
    });
  }

  const healthyProjects = projects.filter((project) => (
    project.indexed
    && project.status === "ready"
    && Number(project.coverage_ratio || 0) >= 1
    && !project.stale
  )).length;

  return {
    schema_version: "semantic-doctor-v1",
    enabled: Boolean(config.semantic?.tsjs?.enabled),
    index_present: indexPresent,
    discovered_project_count: discoveredProjects.length,
    indexed_project_count: indexedProjects.length,
    healthy_project_count: healthyProjects,
    stale_project_count: projects.filter((project) => project.stale).length,
    failing_project_count: failures.filter((failure) => ["analysis-failed", "parse-failed", "partial-coverage", "missing-snapshot"].includes(failure.category)).length,
    discovered_projects: discoveredProjects.map((project) => ({
      project_id: project.id,
      config_path: project.configPath,
      project_root: project.projectRoot,
      inferred: Boolean(project.inferred),
      file_count: project.filePaths.length,
    })),
    stale_fingerprints: staleFingerprints,
    failures,
    projects,
  };
}

function renderSemanticDoctorReport(report) {
  ui.newline();
  ui.log(ui.bold("Semantic TS/JS Health"));
  ui.log(ui.label("Semantic mode", report.enabled ? "enabled" : "disabled"));
  ui.log(ui.label("Index", report.index_present ? "present" : "missing"));
  ui.log(ui.label("Projects", `${report.healthy_project_count}/${report.projects.length} healthy`));

  if (report.projects.length === 0) {
    ui.log(ui.dim("No TS/JS semantic projects discovered."));
  } else {
    const rows = report.projects.map((project) => [
      projectLabel(project),
      project.status,
      project.stale ? "stale" : "current",
      String(project.file_count),
      `${project.symbol_count}/${project.surface_count}/${project.edge_count}`,
      project.trend_hints[0] || "",
    ]);
    process.stderr.write(ui.table(["Project", "Status", "Freshness", "Files", "Symbols/Surfaces/Edges", "Hint"], rows) + "\n");
  }

  if (report.failures.length > 0) {
    ui.newline();
    ui.warn("Semantic issues:");
    for (const failure of report.failures) {
      ui.log(`${failure.category}${failure.project_id ? ` ${failure.project_id}` : ""}: ${failure.message}`);
    }
  }
}

export async function runDoctor(root, config, options = {}) {
  const caps = await detectCapabilities(config);
  const semanticReport = options.semantic ? await buildSemanticDoctorReport(root, config) : null;

  if (config.json) {
    const result = {
      command: "doctor",
      ...caps,
      ...(semanticReport ? { semantic: semanticReport } : {}),
    };
    console.log(JSON.stringify(result, null, 2));
    if (options.failOnStale && semanticReport && (semanticReport.stale_project_count > 0 || semanticReport.failures.length > 0)) {
      process.exitCode = AGENTIFY_EXIT_SEMANTIC_STALE;
    }
    return result;
  }

  const tierBadge =
    caps.tier === 2 ? ui.green(`Tier ${caps.tier}`)
    : caps.tier === 1 ? ui.yellow(`Tier ${caps.tier}`)
    : ui.red(`Tier ${caps.tier}`);

  ui.log(`Capability tier: ${ui.bold(tierBadge)}`);
  ui.newline();

  const rows = [];
  for (const [name, info] of Object.entries(caps.tools)) {
    const status = info.available
      ? ui.green("OK")
      : ui.red("MISSING");
    const version = info.available
      ? info.version
      : ui.dim(getInstallHint(name));
    rows.push([name, String(info.tier), status, version]);
  }

  const tbl = ui.table(["Tool", "Tier", "Status", "Version / Install"], rows);
  process.stderr.write(tbl + "\n");
  ui.newline();

  ui.log(ui.label("Node.js", process.version));
  ui.log(ui.label("Platform", `${process.platform} ${process.arch}`));

  if (semanticReport) {
    renderSemanticDoctorReport(semanticReport);
  } else if (config.semantic?.tsjs?.enabled && root) {
    const dbPath = `${root}/.agents/index.db`;
    if (await exists(dbPath)) {
      const db = openIndexDatabase(root, { readOnly: true });
      try {
        const semanticProjects = listSemanticProjects(db);
        ui.newline();
        ui.log(ui.bold("Semantic TS/JS"));
        if (semanticProjects.length === 0) {
          ui.log(ui.dim("No semantic projects indexed yet. Run `agentify semantic refresh`."));
        } else {
          const semanticRows = semanticProjects.map((project) => [
            project.config_path || "inferred",
            project.status,
            String(project.file_count),
            `${project.surface_count}/${project.edge_count}`,
          ]);
          const semanticTable = ui.table(["Project", "Status", "Files", "Surfaces / Edges"], semanticRows);
          process.stderr.write(semanticTable + "\n");
        }
      } finally {
        closeIndexDatabase(db);
      }
    }
  }

  if (caps.tier < 2) {
    ui.newline();
    ui.warn("Install missing tier tools to unlock full capabilities.");
  }

  ui.newline();
  if (options.failOnStale && semanticReport && (semanticReport.stale_project_count > 0 || semanticReport.failures.length > 0)) {
    process.exitCode = AGENTIFY_EXIT_SEMANTIC_STALE;
  }
  return caps;
}
