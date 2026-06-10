import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RTK_COMMAND_ENV = "AGENTIFY_RTK_CMD";
export const RTK_DEFAULT_COMMAND = "rtk";
export const RTK_PROVIDER_INSTRUCTION =
  "RTK is available. Prefer `rtk <command>` for shell commands with large output; use `rtk proxy <command>` when raw output is required.";

const PROVIDER_COMMANDS = new Set(["codex", "claude", "gemini", "opencode"]);

function parseVersion(stdout, stderr = "") {
  const versionMatch = `${stdout}\n${stderr}`.match(/(\d+\.\d+\.\d+|\d+\.\d+|\d+)/);
  return versionMatch ? versionMatch[1] : "unknown";
}

async function defaultResolveCommand(command) {
  if (command.includes("/") || command.includes("\\")) {
    await fs.access(command, fsConstants.X_OK);
    return command;
  }
  const { stdout } = await execFileAsync("sh", ["-c", 'command -v -- "$1"', "sh", command]);
  return stdout.trim() || command;
}

async function defaultExec(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
    });
    return { code: 0, stdout, stderr, missing: false };
  } catch (error) {
    if (error?.code === "ENOENT") {
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

export function resolveRtkConfig(config = {}, flags = {}, env = process.env) {
  const toolConfig = config?.toolchain?.rtk && typeof config.toolchain.rtk === "object" ? config.toolchain.rtk : {};
  const explicit = flags.rtk === true || config.rtk === true;
  const enabled = explicit || toolConfig.enabled === true;
  const command =
    String(env?.[RTK_COMMAND_ENV] || toolConfig.command || RTK_DEFAULT_COMMAND).trim() || RTK_DEFAULT_COMMAND;

  return {
    enabled,
    explicit,
    command,
    providerInstruction: explicit || toolConfig.providerInstruction === true,
    wrapProjectTests: explicit || toolConfig.wrapProjectTests === true,
  };
}

export async function detectRtk(command = RTK_DEFAULT_COMMAND, runtime = {}) {
  const resolveCommand = runtime.resolveCommand || defaultResolveCommand;
  const exec = runtime.exec || defaultExec;
  let resolvedCommand;

  try {
    resolvedCommand = await resolveCommand(command);
  } catch {
    return {
      available: false,
      verified: false,
      version: null,
      path: null,
      command,
      reason: "command not found",
      install_hint: "brew install rtk / cargo install --git https://github.com/rtk-ai/rtk",
    };
  }

  const versionResult = await exec(resolvedCommand, ["--version"], runtime);
  const gainResult = await exec(resolvedCommand, ["gain"], runtime);
  const available = versionResult.code === 0 || gainResult.code === 0;
  const verified = gainResult.code === 0;
  const version = available ? parseVersion(versionResult.stdout, versionResult.stderr) : null;

  return {
    available,
    verified,
    version: version || "unknown",
    path: resolvedCommand,
    command,
    check_command: `${command} gain`,
    ...(verified
      ? {}
      : {
          check_status: "failed",
          reason: available
            ? "`rtk gain` failed; install the Rust Token Killer CLI from rtk-ai/rtk"
            : "RTK readiness checks failed",
        }),
    install_hint: "brew install rtk / cargo install --git https://github.com/rtk-ai/rtk",
  };
}

export function buildRtkWrappedCommand(argv, { kind = "command", command = RTK_DEFAULT_COMMAND } = {}) {
  const parts = Array.isArray(argv) ? argv.map(String).filter(Boolean) : [];
  if (parts.length === 0) {
    return parts;
  }
  if (PROVIDER_COMMANDS.has(parts[0])) {
    return parts;
  }
  if (kind === "test") {
    return [command, "test", ...parts];
  }
  return [command, ...parts];
}

export function buildRtkProviderInstruction(_provider, detection) {
  if (!detection?.verified) {
    return "";
  }
  return RTK_PROVIDER_INSTRUCTION;
}

export function formatRtkUnavailableMessage(detection) {
  if (!detection?.available) {
    return `RTK was requested but ${detection?.command || RTK_DEFAULT_COMMAND} was not found. Install RTK from rtk-ai/rtk or set ${RTK_COMMAND_ENV}.`;
  }
  if (!detection.verified) {
    return `RTK was requested but \`${detection.check_command || "rtk gain"}\` failed. Install the Rust Token Killer CLI from rtk-ai/rtk; another package named rtk may be on PATH.`;
  }
  return "RTK was requested but could not be verified.";
}
