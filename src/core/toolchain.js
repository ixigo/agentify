import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { closeIndexDatabase, listSemanticProjects, openIndexDatabase } from "./db.js";
import { exists } from "./fs.js";
import * as ui from "./ui.js";

const execFileAsync = promisify(execFile);

const TOOLS = {
  rg: { minVersion: "13.0.0", tier: 1, purpose: "fast text search" },
  fd: { minVersion: "8.0.0", tier: 1, purpose: "fast file enumeration" },
  "ast-grep": { minVersion: "0.20.0", tier: 2, purpose: "structural pattern queries" },
  "tree-sitter": { minVersion: "0.22.0", tier: 2, purpose: "parser-backed symbol extraction" },
  zoekt: { minVersion: null, tier: "optional", purpose: "indexed code search at scale" },
};

async function detectTool(name) {
  try {
    const { stdout } = await execFileAsync(name, ["--version"]);
    const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
    return {
      available: true,
      version: versionMatch ? versionMatch[1] : "unknown",
      path: name,
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
    const detection = await detectTool(name);
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
    zoekt: "go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest",
  };
  return hints[name] || `install ${name}`;
}

export async function runDoctor(root, config) {
  const caps = await detectCapabilities(config);

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

  if (config.semantic?.tsjs?.enabled && root) {
    const dbPath = `${root}/.agents/index.db`;
    if (await exists(dbPath)) {
      const db = openIndexDatabase(root);
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
  return caps;
}
