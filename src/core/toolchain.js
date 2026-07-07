import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { EXECUTABLE_PROVIDER_NAMES, getProviderDefinition } from "./provider-registry.js";
import * as ui from "./ui.js";

const execFileAsync = promisify(execFile);

const TOOLS = {
  rg: { minVersion: "13.0.0", tier: 1, purpose: "fast text search" },
  fd: { minVersion: "8.0.0", tier: 1, purpose: "fast file enumeration" },
  "ast-grep": { minVersion: "0.20.0", tier: 2, purpose: "structural pattern queries" },
  "tree-sitter": { minVersion: "0.22.0", tier: 2, purpose: "parser-backed symbol extraction" },
  zoekt: { minVersion: null, tier: "optional", purpose: "indexed code search at scale" },
};

const PACKAGE_MANAGER = {
  name: "pnpm",
  command: "pnpm",
  checkArgs: ["--version"],
  purpose: "package manager for Agentify install and test workflows",
  installHint: "npm i -g pnpm",
};

const AUTH_SKIPPED_BINARY_MISSING = {
  state: "skipped",
  detail: "binary missing",
  nextStep: null,
};

async function resolveToolCommand(command) {
  if (command.includes("/") || command.includes("\\")) {
    await fs.access(command, fsConstants.X_OK);
    return command;
  }
  const { stdout } = await execFileAsync("sh", ["-c", 'command -v -- "$1"', "sh", command]);
  return stdout.trim() || command;
}

async function runCommandCapture(argv, options = {}) {
  const [command, ...args] = argv;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
    });
    return { code: 0, stdout, stderr, missing: false };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { code: 127, stdout: "", stderr: `${command}: command not found`, missing: true };
    }
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || ""),
      missing: false,
    };
  }
}

function parseVersion(stdout, stderr = "") {
  const versionMatch = `${stdout}\n${stderr}`.match(/(\d+\.\d+\.\d+|\d+\.\d+|\d+)/);
  return versionMatch ? versionMatch[1] : "unknown";
}

async function detectTool(name) {
  try {
    const { stdout } = await execFileAsync(name, ["--version"]);
    return {
      available: true,
      version: parseVersion(stdout),
      path: name,
    };
  } catch {
    return { available: false, version: null, path: null };
  }
}

async function detectBinary(command, options = {}) {
  let resolvedCommand = null;
  try {
    resolvedCommand = await resolveToolCommand(command);
  } catch {
    return {
      available: false,
      version: null,
      path: null,
      reason: "command not found",
    };
  }

  const result = await runCommandCapture([resolvedCommand, ...(options.checkArgs || ["--version"])], {
    cwd: options.cwd,
    env: options.env,
  });

  return {
    available: result.code === 0,
    version: result.code === 0 ? parseVersion(result.stdout, result.stderr) : "unknown",
    path: resolvedCommand,
    ...(result.code === 0 ? {} : { check_status: "failed" }),
  };
}

async function detectPackageManagerReadiness() {
  const detection = await detectBinary(PACKAGE_MANAGER.command, { checkArgs: PACKAGE_MANAGER.checkArgs });
  return {
    name: PACKAGE_MANAGER.name,
    command: PACKAGE_MANAGER.command,
    purpose: PACKAGE_MANAGER.purpose,
    install_hint: PACKAGE_MANAGER.installHint,
    ...detection,
  };
}

async function detectProviderReadiness(provider, root) {
  const definition = getProviderDefinition(provider);
  const bootstrap = definition?.bootstrap || {};
  const binary = bootstrap.bin || provider;
  const detection = await detectBinary(binary, {
    checkArgs: bootstrap.checkArgs || ["--version"],
    cwd: root,
  });

  let auth = AUTH_SKIPPED_BINARY_MISSING;
  if (detection.available && definition?.probeAuth) {
    try {
      auth = await definition.probeAuth({
        cwd: root,
        env: process.env,
        homeDir: process.env.HOME,
        exec: runCommandCapture,
      });
    } catch (error) {
      auth = {
        state: "unknown",
        detail: error?.message || "auth not verified",
        nextStep: bootstrap.loginCommand || null,
      };
    }
  }

  return {
    name: provider,
    binary,
    available: detection.available,
    version: detection.version,
    path: detection.path,
    ...(detection.reason ? { reason: detection.reason } : {}),
    ...(detection.check_status ? { check_status: detection.check_status } : {}),
    install_hint: bootstrap.install ? bootstrap.install.join(" ") : `install ${binary}`,
    auth: {
      state: auth?.state || "unknown",
      detail: auth?.detail || "auth not verified",
      next_step: auth?.nextStep || null,
    },
  };
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
  const providerEntries = await Promise.all(
    EXECUTABLE_PROVIDER_NAMES.map(async (provider) => [provider, await detectProviderReadiness(provider, config.root)])
  );

  return {
    tools: results,
    tier: tier2Ready ? 2 : tier1Ready ? 1 : 0,
    zoekt: results.zoekt.available,
    package_manager: await detectPackageManagerReadiness(),
    providers: Object.fromEntries(providerEntries),
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

function renderProviderAuth(info) {
  const state = info.auth?.state || "unknown";
  if (state === "ready") {
    return ui.green("ready");
  }
  if (state === "missing") {
    return ui.red("login required");
  }
  if (state === "skipped") {
    return ui.dim("not checked");
  }
  return ui.yellow("unknown");
}

export async function runDoctor(root, config, options = {}) {
  const caps = await detectCapabilities({ ...config, root });

  if (config.json) {
    const result = {
      command: "doctor",
      ...caps,
    };
    console.log(JSON.stringify(result, null, 2));
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
    const status = info.available ? ui.green("OK") : ui.red("MISSING");
    const version = info.available ? info.version : ui.dim(getInstallHint(name));
    rows.push([name, String(info.tier), status, version]);
  }

  const tbl = ui.table(["Tool", "Tier", "Status", "Version / Install"], rows);
  process.stderr.write(tbl + "\n");
  ui.newline();

  const packageManagerStatus = caps.package_manager.available
    ? ui.green("OK")
    : ui.red("MISSING");
  const packageManagerVersion = caps.package_manager.available
    ? caps.package_manager.version
    : ui.dim(caps.package_manager.install_hint);
  ui.log(ui.bold("Package Manager"));
  process.stderr.write(ui.table(
    ["Tool", "Status", "Version / Install"],
    [[caps.package_manager.name, packageManagerStatus, packageManagerVersion]]
  ) + "\n");
  ui.newline();

  ui.log(ui.bold("Provider CLIs"));
  const providerRows = Object.entries(caps.providers).map(([provider, info]) => {
    const status = info.available ? ui.green("OK") : ui.red("MISSING");
    const version = info.available ? info.version : ui.dim(info.install_hint);
    return [provider, info.binary, status, renderProviderAuth(info), version];
  });
  process.stderr.write(ui.table(["Provider", "Command", "Status", "Auth", "Version / Install"], providerRows) + "\n");
  ui.newline();

  ui.log(ui.label("Node.js", process.version));
  ui.log(ui.label("Platform", `${process.platform} ${process.arch}`));

  if (caps.tier < 2) {
    ui.newline();
    ui.warn("Install missing tier tools to unlock full capabilities.");
  }

  ui.newline();
  return caps;
}
