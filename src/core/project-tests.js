import { spawn } from "node:child_process";
import path from "node:path";

import { detectStacks } from "./detect.js";
import { exists, readJson, relative, walkFiles } from "./fs.js";

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

async function runChildCommand(command, args, { cwd, env } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];

  const code = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", (error) => {
      stderrChunks.push(`${error.message}\n`);
      resolve(127);
    });
    child.on("close", resolve);
  });

  return {
    code: Number(code ?? 1),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

function pythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

async function rootFiles(root) {
  return (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
}

async function detectNodeTestCommand(root) {
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

async function detectPythonTestCommand(root) {
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
  const hasPythonSignals = await exists(path.join(root, "pyproject.toml"))
    || await exists(path.join(root, "requirements.txt"))
    || await exists(path.join(root, "setup.py"))
    || files.some((file) => file.endsWith(".py"));
  if (!hasPythonSignals) {
    return null;
  }

  const hasTestsDir = await exists(path.join(root, "tests"));
  const hasUnittestFiles = files.some((file) => /(^|\/)test[^/]*\.py$/.test(file) || /(^|\/)[^/]+_test\.py$/.test(file));
  if (hasTestsDir || hasUnittestFiles) {
    return { command: pythonCommand(), args: ["-m", "pytest"] };
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

async function detectJvmTestCommand(root) {
  if (await exists(path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew"))) {
    return { command: process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew", args: ["test"] };
  }
  if (await exists(path.join(root, process.platform === "win32" ? "mvnw.cmd" : "mvnw"))) {
    return { command: process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw", args: ["test"] };
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

export async function detectTestCommand(root) {
  const detectors = [
    detectNodeTestCommand,
    detectPythonTestCommand,
    detectGoTestCommand,
    detectRustTestCommand,
    detectDotnetTestCommand,
    detectJvmTestCommand,
    detectSwiftTestCommand,
  ];

  for (const detector of detectors) {
    const command = await detector(root);
    if (command) {
      return command;
    }
  }

  return null;
}

async function buildNoTestCommandResult(root, options) {
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
    exit_code: null,
    reason: "no_test_command",
    detected_stacks: detectedStacks,
    message: "No runnable test command was detected",
  };
}

export async function runProjectTests(root, reporter, options = {}) {
  const testCommand = await detectTestCommand(root);
  if (!testCommand) {
    const result = await buildNoTestCommandResult(root, options);
    reporter.log(`tests: ${result.status} - ${result.message}`);
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
