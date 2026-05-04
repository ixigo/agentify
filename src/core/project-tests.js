import { spawn } from "node:child_process";
import path from "node:path";

import { createBoundedCaptureBuffer, DEFAULT_CAPTURE_MAX_KB, normalizeCaptureMaxBytes } from "./capture-buffer.js";
import { exists, readJson } from "./fs.js";

const DEFAULT_PASSTHROUGH_ENV = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "CI",
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

function getTestOutputMaxBytes(testsConfig = {}) {
  return normalizeCaptureMaxBytes(testsConfig.outputMaxKb, DEFAULT_CAPTURE_MAX_KB);
}

async function runChildCommand(command, args, { cwd, env, outputMaxBytes } = {}) {
  const stdoutCapture = createBoundedCaptureBuffer(outputMaxBytes);
  const stderrCapture = createBoundedCaptureBuffer(outputMaxBytes);

  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    child.stdout.on("data", (chunk) => {
      stdoutCapture.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrCapture.append(chunk);
    });
    child.on("error", reject);
    child.on("close", resolve);
  });

  return {
    code: Number(code ?? 1),
    stdout: stdoutCapture.toString(),
    stderr: stderrCapture.toString(),
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    stdoutBytes: stdoutCapture.seenBytes,
    stderrBytes: stderrCapture.seenBytes,
    outputMaxBytes,
  };
}

function formatPackageJsonDiscoveryError(packageJsonPath, error) {
  const type = error instanceof SyntaxError
    ? "package_json_parse_error"
    : "package_json_read_error";
  return {
    type,
    path: packageJsonPath,
    message: error.message,
  };
}

export async function detectTestCommand(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return null;
  }

  let packageJson;
  try {
    packageJson = await readJson(packageJsonPath);
  } catch (error) {
    return { error: formatPackageJsonDiscoveryError(packageJsonPath, error) };
  }

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
  return null;
}

export async function runProjectTests(root, reporter, options = {}) {
  const testsConfig = options.config?.tests || options.tests || {};
  const outputMaxBytes = getTestOutputMaxBytes(testsConfig);
  const testCommand = await detectTestCommand(root);
  if (testCommand?.error) {
    const result = {
      status: "failed",
      passed: false,
      command: null,
      stdout: "",
      stderr: `package.json test discovery failed: ${testCommand.error.message}`,
      exit_code: null,
      discovery_error: testCommand.error,
    };
    reporter.log(`tests: failed to discover package.json test script (${testCommand.error.type})`);
    reporter.setTests(result);
    return result;
  }

  if (!testCommand) {
    const result = {
      status: "skipped",
      passed: false,
      command: null,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_bytes: 0,
      stderr_bytes: 0,
      output_max_bytes: outputMaxBytes,
      exit_code: null,
    };
    reporter.log("tests: skipped because no package.json test script was found");
    reporter.setTests(result);
    return result;
  }

  const env = buildTestEnv(testsConfig);

  reporter.log(`tests: running ${testCommand.command} ${testCommand.args.join(" ")}`);
  if (testsConfig.env?.inherit !== true) {
    reporter.log("tests: subprocess env is sanitized; configure tests.env.passthrough or tests.env.extra to expose vars");
  }
  const outcome = await runChildCommand(testCommand.command, testCommand.args, { cwd: root, env, outputMaxBytes });
  if (outcome.stdoutTruncated) {
    reporter.log(`tests: stdout truncated to ${outcome.outputMaxBytes} bytes from ${outcome.stdoutBytes} bytes; configure tests.outputMaxKb to adjust`);
  }
  if (outcome.stderrTruncated) {
    reporter.log(`tests: stderr truncated to ${outcome.outputMaxBytes} bytes from ${outcome.stderrBytes} bytes; configure tests.outputMaxKb to adjust`);
  }
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
    stdout_truncated: outcome.stdoutTruncated,
    stderr_truncated: outcome.stderrTruncated,
    stdout_bytes: outcome.stdoutBytes,
    stderr_bytes: outcome.stderrBytes,
    output_max_bytes: outcome.outputMaxBytes,
    exit_code: outcome.code,
  };
  reporter.log(`tests: ${result.status}`);
  reporter.setTests(result);
  return result;
}
