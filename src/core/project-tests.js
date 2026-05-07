import { spawn } from "node:child_process";
import path from "node:path";

import { createBoundedCaptureBuffer, DEFAULT_CAPTURE_MAX_KB, normalizeCaptureMaxBytes } from "./capture-buffer.js";
import { detectStacks } from "./detect.js";
import { exists, readJson, relative, walkFiles } from "./fs.js";
import { redactSensitiveText } from "./session-memory.js";

const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_KILL_TIMEOUT_MS = 1000;

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

function getTestTimeoutMs(testsConfig = {}) {
  const timeoutMs = Number(testsConfig.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TEST_TIMEOUT_MS;
}

function killChildProcess(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between timeout scheduling and signal delivery.
  }
}

async function runChildCommand(command, args, { cwd, env, outputMaxBytes, timeoutMs } = {}) {
  const stdoutCapture = createBoundedCaptureBuffer(outputMaxBytes);
  const stderrCapture = createBoundedCaptureBuffer(outputMaxBytes);

  const outcome = await new Promise((resolve, reject) => {
    let timedOut = false;
    let timeout = null;
    let killTimer = null;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    function clearTimers() {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    }

    timeout = setTimeout(() => {
      timedOut = true;
      killChildProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killChildProcess(child, "SIGKILL");
      }, FORCE_KILL_TIMEOUT_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutCapture.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrCapture.append(chunk);
    });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      resolve({ code, signal, timedOut });
    });
  });

  return {
    code: outcome.timedOut ? null : Number(outcome.code ?? 1),
    signal: outcome.signal || null,
    timedOut: outcome.timedOut,
    timeoutMs,
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

async function rootFiles(root) {
  return (await walkFiles(root, { respectIgnore: true }))
    .map((filePath) => relative(root, filePath));
}

function pythonCommand(platform = process.platform) {
  return platform === "win32" ? "python" : "python3";
}

async function detectPythonTestCommand(root, { platform = process.platform } = {}) {
  if (await exists(path.join(root, "tox.ini"))) {
    return { command: "tox", args: [] };
  }
  if (await exists(path.join(root, "noxfile.py"))) {
    return { command: "nox", args: [] };
  }
  if (
    await exists(path.join(root, "pytest.ini"))
    || await exists(path.join(root, "conftest.py"))
  ) {
    return { command: pythonCommand(), args: ["-m", "pytest"] };
  }

  const files = await rootFiles(root);
  const hasTestsDir = await exists(path.join(root, "tests"));
  const hasPythonTestFiles = files.some((file) => /(^|\/)test[^/]*\.py$/.test(file) || /(^|\/)[^/]+_test\.py$/.test(file));
  if (hasTestsDir || hasPythonTestFiles) {
    return { command: pythonCommand(platform), args: ["-m", "pytest"] };
  }

  const hasPythonSignals = await exists(path.join(root, "pyproject.toml"))
    || await exists(path.join(root, "requirements.txt"))
    || await exists(path.join(root, "setup.py"))
    || files.some((file) => file.endsWith(".py"));
  if (!hasPythonSignals) {
    return null;
  }
  return null;
}

async function detectGoTestCommand(root) {
  const files = await rootFiles(root);
  if (await exists(path.join(root, "go.mod")) || files.some((file) => file.endsWith("_test.go"))) {
    return { command: "go", args: ["test", "./..."] };
  }
  return null;
}

async function detectRustTestCommand(root) {
  if (await exists(path.join(root, "Cargo.toml"))) {
    return { command: "cargo", args: ["test"] };
  }
  return null;
}

async function detectDotnetTestCommand(root) {
  const files = await rootFiles(root);
  if (files.some((file) => file.endsWith(".sln") || file.endsWith(".csproj"))) {
    return { command: "dotnet", args: ["test"] };
  }
  return null;
}

async function detectJvmTestCommand(root, { platform = process.platform } = {}) {
  if (platform === "win32") {
    if (await exists(path.join(root, "gradlew.bat"))) {
      return { command: ".\\gradlew.bat", args: ["test"] };
    }
    if (await exists(path.join(root, "mvnw.cmd"))) {
      return { command: ".\\mvnw.cmd", args: ["test"] };
    }
  } else {
    if (await exists(path.join(root, "gradlew"))) {
      return { command: "./gradlew", args: ["test"] };
    }
    if (await exists(path.join(root, "mvnw"))) {
      return { command: "./mvnw", args: ["test"] };
    }
  }
  if (await exists(path.join(root, "build.gradle")) || await exists(path.join(root, "build.gradle.kts"))) {
    return { command: "gradle", args: ["test"] };
  }
  if (await exists(path.join(root, "pom.xml"))) {
    return { command: "mvn", args: ["test"] };
  }
  return null;
}

async function detectSwiftTestCommand(root) {
  if (await exists(path.join(root, "Package.swift"))) {
    return { command: "swift", args: ["test"] };
  }
  return null;
}

async function detectNonNodeTestCommand(root, options = {}) {
  const detectors = [
    detectPythonTestCommand,
    detectGoTestCommand,
    detectRustTestCommand,
    detectDotnetTestCommand,
    detectJvmTestCommand,
    detectSwiftTestCommand,
  ];

  for (const detector of detectors) {
    const command = await detector(root, options);
    if (command) {
      return command;
    }
  }

  return null;
}

export async function detectTestCommand(root, options = {}) {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return detectNonNodeTestCommand(root, options);
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
  return detectNonNodeTestCommand(root);
}

async function buildNoTestCommandResult(root, options, outputMaxBytes) {
  const detectedStacks = await detectStacks(root, options.config || {});
  const nonNodeStacks = detectedStacks
    .map((stack) => stack.name)
    .filter((name) => name !== "ts");

  if (nonNodeStacks.length > 0) {
    return {
      status: "unsupported",
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
      reason: "unsupported_test_detection",
      detected_stacks: detectedStacks,
      message: `No runnable test command was detected for supported non-JS stack(s): ${nonNodeStacks.join(", ")}`,
    };
  }

  return {
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
    reason: "no_test_command",
    detected_stacks: detectedStacks,
    message: "No runnable test command was detected",
  };
}

export async function runProjectTests(root, reporter, options = {}) {
  const testsConfig = options.config?.tests || options.tests || {};
  const outputMaxBytes = getTestOutputMaxBytes(testsConfig);
  const timeoutMs = getTestTimeoutMs(testsConfig);
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
    const result = await buildNoTestCommandResult(root, options, outputMaxBytes);
    reporter.log(`tests: ${result.status === "unsupported" ? "unsupported" : "skipped"} - ${result.message}`);
    reporter.setTests(result);
    return result;
  }

  const env = buildTestEnv(testsConfig);

  reporter.log(`tests: running ${testCommand.command} ${testCommand.args.join(" ")}`);
  if (testsConfig.env?.inherit !== true) {
    reporter.log("tests: subprocess env is sanitized; configure tests.env.passthrough or tests.env.extra to expose vars");
  }
  const outcome = await runChildCommand(testCommand.command, testCommand.args, { cwd: root, env, outputMaxBytes, timeoutMs });
  if (outcome.stdoutTruncated) {
    reporter.log(`tests: stdout truncated to ${outcome.outputMaxBytes} bytes from ${outcome.stdoutBytes} bytes; configure tests.outputMaxKb to adjust`);
  }
  if (outcome.stderrTruncated) {
    reporter.log(`tests: stderr truncated to ${outcome.outputMaxBytes} bytes from ${outcome.stderrBytes} bytes; configure tests.outputMaxKb to adjust`);
  }
  const stdout = redactSensitiveText(outcome.stdout);
  const stderr = redactSensitiveText(outcome.stderr);
  if (stdout) {
    reporter.appendSection("[tests stdout]", stdout);
  }
  if (stderr) {
    reporter.appendSection("[tests stderr]", stderr);
  }
  if (outcome.timedOut) {
    reporter.log(`tests: timed out after ${outcome.timeoutMs}ms; terminated subprocess`);
  }

  const result = {
    status: outcome.code === 0 && !outcome.timedOut ? "passed" : "failed",
    passed: outcome.code === 0 && !outcome.timedOut,
    command: `${testCommand.command} ${testCommand.args.join(" ")}`,
    stdout,
    stderr,
    stdout_truncated: outcome.stdoutTruncated,
    stderr_truncated: outcome.stderrTruncated,
    stdout_bytes: outcome.stdoutBytes,
    stderr_bytes: outcome.stderrBytes,
    output_max_bytes: outcome.outputMaxBytes,
    exit_code: outcome.code,
    signal: outcome.signal,
    timed_out: outcome.timedOut,
    timeout_ms: outcome.timeoutMs,
  };
  if (outcome.timedOut) {
    result.reason = "timeout";
  }
  reporter.log(`tests: ${result.status}`);
  reporter.setTests(result);
  return result;
}
