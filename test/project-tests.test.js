import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildTestEnv, detectTestCommand, runProjectTests } from "../src/core/project-tests.js";

function createReporter() {
  const logs = [];
  const sections = [];
  let testsRecord = null;
  return {
    log: (msg) => logs.push(msg),
    appendSection: (title, body) => sections.push({ title, body }),
    setTests: (record) => {
      testsRecord = record;
    },
    get logs() {
      return logs;
    },
    get sections() {
      return sections;
    },
    get tests() {
      return testsRecord;
    },
  };
}

async function installFakeExecutable(binDir, name, script) {
  const executablePath = path.join(binDir, name);
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(executablePath, script, "utf8");
  await fs.chmod(executablePath, 0o755);
  return executablePath;
}

test("detectTestCommand prefers the declared package manager", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-command-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@9.0.0",
    scripts: {
      test: "vitest run",
    },
  }, null, 2));

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "pnpm", args: ["test"] });
});

test("detectTestCommand falls back to lockfile detection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-lockfile-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "jest",
    },
  }, null, 2));
  await fs.writeFile(path.join(root, "yarn.lock"), "");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "yarn", args: ["test"] });
});

test("detectTestCommand returns a discovery error for malformed package.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-malformed-pkg-"));
  const packageJsonPath = path.join(root, "package.json");
  await fs.writeFile(packageJsonPath, "{ invalid json\n", "utf8");

  const result = await detectTestCommand(root);

  assert.equal(result.error.type, "package_json_parse_error");
  assert.equal(result.error.path, packageJsonPath);
  assert.match(result.error.message, /JSON|Expected property name|Unexpected token/);
});

test("detectTestCommand prefers pytest for Python file-pattern test signals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-python-"));
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "tests", "test_example.py"), "def test_example():\n    assert True\n");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, {
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-m", "pytest"],
  });
});

test("detectTestCommand prefers pytest when tests directory is the only Python test signal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-python-tests-dir-"));
  await fs.mkdir(path.join(root, "tests"), { recursive: true });

  const result = await detectTestCommand(root);

  assert.deepEqual(result, {
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-m", "pytest"],
  });
});

test("detectTestCommand tolerates malformed .agentignore metacharacters during file discovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-agentignore-metachar-"));
  await fs.writeFile(path.join(root, ".agentignore"), "[abc\n", "utf8");
  await fs.writeFile(path.join(root, "example_test.py"), "def test_example():\n    assert True\n");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, {
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-m", "pytest"],
  });
});

test("detectTestCommand uses Windows Gradle wrapper only when gradlew.bat exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-gradle-win-"));
  await fs.writeFile(path.join(root, "gradlew"), "");
  await fs.writeFile(path.join(root, "build.gradle"), "plugins { id 'java' }\n");

  const result = await detectTestCommand(root, { platform: "win32" });

  assert.deepEqual(result, { command: "gradle", args: ["test"] });

  await fs.writeFile(path.join(root, "gradlew.bat"), "");

  const wrapperResult = await detectTestCommand(root, { platform: "win32" });

  assert.deepEqual(wrapperResult, { command: ".\\gradlew.bat", args: ["test"] });
});

test("detectTestCommand uses Windows Maven wrapper only when mvnw.cmd exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-maven-win-"));
  await fs.writeFile(path.join(root, "mvnw"), "");
  await fs.writeFile(path.join(root, "pom.xml"), "<project></project>\n");

  const result = await detectTestCommand(root, { platform: "win32" });

  assert.deepEqual(result, { command: "mvn", args: ["test"] });

  await fs.writeFile(path.join(root, "mvnw.cmd"), "");

  const wrapperResult = await detectTestCommand(root, { platform: "win32" });

  assert.deepEqual(wrapperResult, { command: ".\\mvnw.cmd", args: ["test"] });
});

test("detectTestCommand discovers Go repositories without package.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-go-"));
  await fs.writeFile(path.join(root, "go.mod"), "module example.test/agentify\n\ngo 1.22\n");
  await fs.writeFile(path.join(root, "main_test.go"), "package main\n");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "go", args: ["test", "./..."] });
});

test("buildTestEnv strips arbitrary host variables by default", () => {
  const sourceEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agentify",
    CI: "true",
    SENTINEL_SECRET: "should-not-leak",
    AWS_ACCESS_KEY_ID: "AKIA-should-not-leak",
    LANG: "en_US.UTF-8",
  };

  const env = buildTestEnv({}, sourceEnv);

  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/agentify");
  assert.equal(env.CI, "true");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.SENTINEL_SECRET, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
});

test("buildTestEnv passes through configured allowlist entries", () => {
  const sourceEnv = {
    PATH: "/usr/bin",
    SENTINEL_SECRET: "should-not-leak",
    MY_TEST_VAR: "ok",
  };

  const env = buildTestEnv({ env: { passthrough: ["MY_TEST_VAR"] } }, sourceEnv);

  assert.equal(env.MY_TEST_VAR, "ok");
  assert.equal(env.SENTINEL_SECRET, undefined);
});

test("buildTestEnv injects extra key/value pairs", () => {
  const sourceEnv = { PATH: "/usr/bin" };

  const env = buildTestEnv({ env: { extra: { NODE_ENV: "test", DEBUG: 1 } } }, sourceEnv);

  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.DEBUG, "1");
});

test("buildTestEnv inherits the full env when explicitly opted in", () => {
  const sourceEnv = {
    PATH: "/usr/bin",
    SENTINEL_SECRET: "still-here",
  };

  const env = buildTestEnv({ env: { inherit: true } }, sourceEnv);

  assert.equal(env.SENTINEL_SECRET, "still-here");
});

test("runProjectTests does not leak host secrets to the test subprocess by default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-env-leak-"));
  const outputPath = path.join(root, "captured-env.txt");
  const scriptPath = path.join(root, "capture.js");
  await fs.writeFile(scriptPath, `
    const fs = require("node:fs");
    fs.writeFileSync(process.env.CAPTURE_OUT, JSON.stringify({
      sentinel: process.env.SENTINEL_SECRET ?? null,
      extra: process.env.AGENTIFY_EXTRA ?? null,
    }));
  `);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-env-repro",
    scripts: { test: "node capture.js" },
  }, null, 2));

  const previous = process.env.SENTINEL_SECRET;
  process.env.SENTINEL_SECRET = "leaked-token-xyz";
  try {
    const reporter = createReporter();
    const result = await runProjectTests(root, reporter, {
      config: { tests: { env: { extra: { AGENTIFY_EXTRA: "explicit-value", CAPTURE_OUT: outputPath } } } },
    });
    assert.equal(result.status, "passed", `expected passed, got ${result.status}: ${result.stderr}`);
    const captured = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.equal(captured.sentinel, null, "host secret leaked into the test subprocess");
    assert.equal(captured.extra, "explicit-value", "configured extra env was not forwarded");
  } finally {
    if (previous === undefined) {
      delete process.env.SENTINEL_SECRET;
    } else {
      process.env.SENTINEL_SECRET = previous;
    }
  }
});

test("runProjectTests fails when package.json test discovery fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-discovery-failure-"));
  await fs.writeFile(path.join(root, "package.json"), "{ invalid json\n", "utf8");

  const reporter = createReporter();
  const result = await runProjectTests(root, reporter);

  assert.equal(result.status, "failed");
  assert.equal(result.passed, false);
  assert.equal(result.command, null);
  assert.equal(result.exit_code, null);
  assert.equal(result.discovery_error.type, "package_json_parse_error");
  assert.match(result.stderr, /package\.json test discovery failed:/);
  assert.deepEqual(reporter.tests, result);
  assert.deepEqual(reporter.logs, ["tests: failed to discover package.json test script (package_json_parse_error)"]);
});

test("runProjectTests forwards a configured passthrough variable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-env-pass-"));
  const outputPath = path.join(root, "captured-env.txt");
  const scriptPath = path.join(root, "capture.js");
  await fs.writeFile(scriptPath, `
    const fs = require("node:fs");
    fs.writeFileSync(process.env.CAPTURE_OUT, process.env.AGENTIFY_ALLOWED ?? "");
  `);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-env-pass",
    scripts: { test: "node capture.js" },
  }, null, 2));

  const previous = process.env.AGENTIFY_ALLOWED;
  process.env.AGENTIFY_ALLOWED = "from-host-shell";
  try {
    const reporter = createReporter();
    const result = await runProjectTests(root, reporter, {
      config: { tests: { env: { passthrough: ["AGENTIFY_ALLOWED"], extra: { CAPTURE_OUT: outputPath } } } },
    });
    assert.equal(result.status, "passed", `expected passed, got ${result.status}: ${result.stderr}`);
    const captured = await fs.readFile(outputPath, "utf8");
    assert.equal(captured, "from-host-shell");
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTIFY_ALLOWED;
    } else {
      process.env.AGENTIFY_ALLOWED = previous;
    }
  }
});

test("runProjectTests bounds captured stdout and stderr and reports truncation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-output-bound-"));
  const scriptPath = path.join(root, "emit-output.js");
  const stdoutPayload = "a".repeat(1536);
  const stderrPayload = "b".repeat(1536);

  await fs.writeFile(scriptPath, `
    process.stdout.write(${JSON.stringify(stdoutPayload)});
    process.stderr.write(${JSON.stringify(stderrPayload)});
  `);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-output-bound",
    scripts: { test: "node emit-output.js" },
  }, null, 2));

  const reporter = createReporter();
  const result = await runProjectTests(root, reporter, {
    config: { tests: { outputMaxKb: 1 } },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr_truncated, true);
  assert.equal(result.output_max_bytes, 1024);
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), 1024);
  assert.equal(Buffer.byteLength(result.stderr, "utf8"), 1024);
  assert.equal(reporter.tests.stdout_truncated, true);
  assert.equal(reporter.tests.stderr_truncated, true);
  assert.match(reporter.logs.join("\n"), /stdout truncated to 1024 bytes/);
  assert.match(reporter.logs.join("\n"), /stderr truncated to 1024 bytes/);
  assert.equal(Buffer.byteLength(reporter.sections.find((section) => section.title === "[tests stdout]").body, "utf8"), 1024);
  assert.equal(Buffer.byteLength(reporter.sections.find((section) => section.title === "[tests stderr]").body, "utf8"), 1024);
});

test("runProjectTests redacts secrets from captured stdout and stderr before reporting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-output-redaction-"));
  const scriptPath = path.join(root, "emit-secret-output.js");
  const stdoutSecret = "sk-live-secret12345";
  const stderrSecret = "eyJhbGciOiJIUzI1NiJ9.secret";

  await fs.writeFile(scriptPath, `
    process.stdout.write("stdout context OPENAI_API_KEY=${stdoutSecret}\\n");
    process.stderr.write("stderr context Authorization: Bearer ${stderrSecret}\\n");
  `);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-output-redaction",
    scripts: { test: "node emit-secret-output.js" },
  }, null, 2));

  const reporter = createReporter();
  const result = await runProjectTests(root, reporter);
  const sections = reporter.sections.map((section) => section.body).join("\n");

  assert.equal(result.status, "passed");
  assert.doesNotMatch(result.stdout, new RegExp(stdoutSecret));
  assert.doesNotMatch(result.stderr, new RegExp(stderrSecret));
  assert.doesNotMatch(sections, new RegExp(stdoutSecret));
  assert.doesNotMatch(sections, new RegExp(stderrSecret));
  assert.match(result.stdout, /stdout context OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(result.stderr, /stderr context Authorization: Bearer \[REDACTED\]/);
  assert.match(sections, /\[REDACTED\]/);
  assert.deepEqual(reporter.tests, result);
});

test("runProjectTests leaves the command unchanged when RTK is disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-rtk-disabled-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-rtk-disabled",
    scripts: { test: "node -e \"console.log('plain test')\"" },
  }, null, 2));

  const reporter = createReporter();
  const result = await runProjectTests(root, reporter);

  assert.equal(result.status, "passed");
  assert.equal(result.command, "npm test");
  assert.equal(result.rtk, undefined);
  assert.doesNotMatch(reporter.logs.join("\n"), /RTK wrapping enabled/);
});

test("runProjectTests wraps project tests with RTK when explicitly enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-rtk-enabled-"));
  const binDir = path.join(root, "bin");
  const capturePath = path.join(root, "rtk-argv.json");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-rtk-enabled",
    scripts: { test: "node -e \"console.log('wrapped test')\"" },
  }, null, 2));
  await installFakeExecutable(binDir, "rtk", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("rtk 0.39.0");
  process.exit(0);
}
if (args[0] === "gain") {
  console.log("token gain ok");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args));
console.log("compressed test output");
process.exit(0);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    const reporter = createReporter();
    const result = await runProjectTests(root, reporter, {
      config: { rtk: true },
    });

    assert.equal(result.status, "passed");
    assert.equal(result.command, "rtk test npm test");
    assert.equal(result.rtk.verified, true);
    assert.deepEqual(JSON.parse(await fs.readFile(capturePath, "utf8")), ["test", "npm", "test"]);
    assert.match(reporter.logs.join("\n"), /RTK wrapping enabled/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("runProjectTests preserves non-zero RTK-wrapped test exits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-rtk-fail-"));
  const binDir = path.join(root, "bin");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-rtk-fail",
    scripts: { test: "node -e \"process.exit(7)\"" },
  }, null, 2));
  await installFakeExecutable(binDir, "rtk", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("rtk 0.39.0");
  process.exit(0);
}
if (args[0] === "gain") {
  console.log("token gain ok");
  process.exit(0);
}
process.exit(7);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    const reporter = createReporter();
    const result = await runProjectTests(root, reporter, {
      config: { rtk: true },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.passed, false);
    assert.equal(result.exit_code, 7);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("runProjectTests still enforces timeout with RTK wrapping", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-rtk-timeout-"));
  const binDir = path.join(root, "bin");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-rtk-timeout",
    scripts: { test: "node -e \"setInterval(() => {}, 1000)\"" },
  }, null, 2));
  await installFakeExecutable(binDir, "rtk", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("rtk 0.39.0");
  process.exit(0);
}
if (args[0] === "gain") {
  console.log("token gain ok");
  process.exit(0);
}
setInterval(() => {}, 1000);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    const reporter = createReporter();
    const result = await runProjectTests(root, reporter, {
      config: { rtk: true, tests: { timeoutMs: 75 } },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.timed_out, true);
    assert.equal(result.reason, "timeout");
    assert.equal(result.timeout_ms, 75);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("runProjectTests keeps output capture limits with RTK wrapping", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-rtk-output-bound-"));
  const binDir = path.join(root, "bin");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-rtk-output-bound",
    scripts: { test: "node -e \"console.log('unused')\"" },
  }, null, 2));
  await installFakeExecutable(binDir, "rtk", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("rtk 0.39.0");
  process.exit(0);
}
if (args[0] === "gain") {
  console.log("token gain ok");
  process.exit(0);
}
process.stdout.write("x".repeat(1536));
process.stderr.write("y".repeat(1536));
`);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  try {
    const reporter = createReporter();
    const result = await runProjectTests(root, reporter, {
      config: { rtk: true, tests: { outputMaxKb: 1 } },
    });

    assert.equal(result.status, "passed");
    assert.equal(result.stdout_truncated, true);
    assert.equal(result.stderr_truncated, true);
    assert.equal(result.output_max_bytes, 1024);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("runProjectTests times out a hanging test command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-timeout-"));
  const scriptPath = path.join(root, "hang.js");

  await fs.writeFile(scriptPath, `
    process.stdout.write("started");
    setInterval(() => {}, 1000);
  `);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "agentify-timeout",
    scripts: { test: "node hang.js" },
  }, null, 2));

  const reporter = createReporter();
  const started = Date.now();
  const result = await runProjectTests(root, reporter, {
    config: { tests: { timeoutMs: 75 } },
  });
  const durationMs = Date.now() - started;

  assert.equal(result.status, "failed");
  assert.equal(result.passed, false);
  assert.equal(result.exit_code, null);
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_ms, 75);
  assert.equal(result.reason, "timeout");
  assert.equal(reporter.tests, result);
  assert.match(reporter.logs.join("\n"), /tests: timed out after 75ms; terminated subprocess/);
  assert.ok(durationMs < 3000, `timeout test took ${durationMs}ms`);
});
