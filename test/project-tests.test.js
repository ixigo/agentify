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

test("detectTestCommand prefers pytest for Python file-pattern test signals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-python-"));
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"agentify-python-fixture\"\n");
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "tests", "test_example.py"), "import unittest\n");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, {
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-m", "pytest"],
  });
});

test("detectTestCommand discovers Go repositories without package.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-go-"));
  await fs.writeFile(path.join(root, "go.mod"), "module example.test/agentify\n\ngo 1.22\n");
  await fs.writeFile(path.join(root, "main_test.go"), "package main\n");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "go", args: ["test", "./..."] });
});

test("runProjectTests reports unsupported test detection for non-JS repositories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-python-unsupported-"));
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"agentify-python-fixture\"\n");
  await fs.writeFile(path.join(root, "app.py"), "def main():\n    return True\n");

  const reporter = createReporter();
  const result = await runProjectTests(root, reporter);

  assert.equal(result.status, "unsupported");
  assert.equal(result.passed, false);
  assert.equal(result.reason, "unsupported_test_detection");
  assert.equal(result.command, null);
  assert.match(result.message, /python/);
  assert.match(reporter.logs.join("\n"), /tests: unsupported/);
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
