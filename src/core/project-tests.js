import { spawn } from "node:child_process";
import path from "node:path";

import { exists, readJson } from "./fs.js";

const DEFAULT_PASSTHROUGH_ENV = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_PATH",
  "NVM_DIR",
  "NVM_BIN",
  "VOLTA_HOME",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
]);

export function buildTestEnv(testsConfig = {}, sourceEnv = process.env) {
  const envConfig = (testsConfig && typeof testsConfig === "object" && testsConfig.env) || {};

  if (envConfig.inherit === true) {
    const inherited = { ...sourceEnv };
    const extra = envConfig.extra && typeof envConfig.extra === "object" ? envConfig.extra : {};
    for (const [key, value] of Object.entries(extra)) {
      if (value === null || value === undefined) continue;
      inherited[key] = String(value);
    }
    return inherited;
  }

  const env = {};
  for (const key of DEFAULT_PASSTHROUGH_ENV) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  const passthrough = Array.isArray(envConfig.passthrough) ? envConfig.passthrough : [];
  for (const key of passthrough) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  const extra = envConfig.extra && typeof envConfig.extra === "object" ? envConfig.extra : {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined) continue;
    env[key] = String(value);
  }

  return env;
}

async function runChildCommand(command, args, { cwd, env } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];

  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", reject);
    child.on("close", resolve);
  });

  return {
    code: Number(code ?? 1),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

export async function detectTestCommand(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return null;
  }
  try {
    const packageJson = await readJson(packageJsonPath);
    if (packageJson?.scripts?.test) {
      const packageManager = typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.split("@")[0]
        : null;
      if (packageManager === "pnpm") {
        return { command: "pnpm", args: ["test"] };
      }
      if (packageManager === "yarn") {
        return { command: "yarn", args: ["test"] };
      }
      if (packageManager === "bun") {
        return { command: "bun", args: ["test"] };
      }
      if (await exists(path.join(root, "pnpm-lock.yaml"))) {
        return { command: "pnpm", args: ["test"] };
      }
      if (await exists(path.join(root, "yarn.lock"))) {
        return { command: "yarn", args: ["test"] };
      }
      if (await exists(path.join(root, "bun.lockb")) || await exists(path.join(root, "bun.lock"))) {
        return { command: "bun", args: ["test"] };
      }
      return { command: "npm", args: ["test"] };
    }
  } catch {
    return null;
  }
  return null;
}

export async function runProjectTests(root, reporter, options = {}) {
  const testCommand = await detectTestCommand(root);
  if (!testCommand) {
    const result = {
      status: "skipped",
      passed: false,
      command: null,
      stdout: "",
      stderr: "",
      exit_code: null,
    };
    reporter.log("tests: skipped because no package.json test script was found");
    reporter.setTests(result);
    return result;
  }

  const testsConfig = options.config?.tests || options.tests || {};
  const env = buildTestEnv(testsConfig);

  reporter.log(`tests: running ${testCommand.command} ${testCommand.args.join(" ")}`);
  if (testsConfig.env?.inherit !== true) {
    reporter.log("tests: subprocess env is sanitized; configure tests.env.passthrough or tests.env.extra to expose vars");
  }
  const outcome = await runChildCommand(testCommand.command, testCommand.args, { cwd: root, env });
  if (outcome.stdout) {
    reporter.appendSection("[tests stdout]", outcome.stdout);
  }
  if (outcome.stderr) {
    reporter.appendSection("[tests stderr]", outcome.stderr);
  }

  const result = {
    status: outcome.code === 0 ? "passed" : "failed",
    passed: outcome.code === 0,
    command: `${testCommand.command} ${testCommand.args.join(" ")}`,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: outcome.code,
  };
  reporter.log(`tests: ${result.status}`);
  reporter.setTests(result);
  return result;
}
