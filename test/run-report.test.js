import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunReporter } from "../src/core/run-report.js";
import { setSilent } from "../src/core/ui.js";

test("createRunReporter persists output and HTML report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-run-report-"));
  const previousSilent = false;
  setSilent(true);
  t.after(() => {
    setSilent(previousSilent);
  });

  const reporter = createRunReporter(root);
  reporter.setCommand("up");
  reporter.setScan({ wrote: [".agentify/index.db"] });
  reporter.setDoc({
    modules_processed: 2,
    docs_written: 1,
    files_with_headers: 1,
    token_usage: {
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11,
      by_module: [
        {
          module_id: "auth",
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
        },
      ],
    },
    wrote: ["AGENTIFY.md"],
  });
  reporter.setValidation({ passed: true, failures: [] });
  reporter.setTests({
    status: "passed",
    passed: true,
    command: "pnpm test",
    stdout: "<script>alert('xss')</script>",
    stderr: "",
    exit_code: 0,
  });
  reporter.setExecution({
    run_id: "test-execution",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.250Z",
    duration_ms: 1250,
    phase: "complete",
    exit_code: 0,
    skipped_refresh: false,
    provider: "codex",
    provider_command: {
      executable: "codex",
      argv: ["codex", "run"],
      argc: 2,
      display: "codex run",
    },
    capture: {
      mode: "interactive-pty",
      output_mode: "pty",
      transcript_available: true,
      transcript_bytes: 512,
      raw_log_available: true,
      raw_log_path: ".current_session/session/interactive.log",
    },
    changed_files_count: 2,
    changed_paths: ["src/core/exec.js", "src/core/run-report.js"],
    changed_files: [
      { status: "M", path: "src/core/exec.js" },
      { status: "M", path: "src/core/run-report.js" },
    ],
    head_changed: false,
  });
  reporter.log("tests: passed");

  await reporter.finalize();

  const output = await fs.readFile(path.join(root, "output.txt"), "utf8");
  const html = await fs.readFile(path.join(root, "agentify-report.html"), "utf8");
  const telemetry = JSON.parse(
    await fs.readFile(path.join(root, ".agentify", "runs", "test-execution-execution-telemetry.json"), "utf8")
  );

  assert.match(output, /\[agentify\] tests: passed/);
  assert.match(output, /execution: phase=complete exit=0 duration_ms=1250/);
  assert.match(html, /All configured test cases passed\./);
  assert.match(html, /execution telemetry/);
  assert.match(html, /src\/core\/exec\.js/);
  assert.match(html, /Copy rerun tests command/);
  assert.match(html, /Total tokens/);
  assert.match(html, /&lt;script&gt;alert\('xss'\)&lt;\/script&gt;/);
  assert.equal(telemetry.phase, "complete");
  assert.equal(telemetry.capture.transcript_available, true);
  assert.deepEqual(telemetry.changed_paths, ["src/core/exec.js", "src/core/run-report.js"]);
});

test("createRunReporter shows test output truncation metadata in HTML", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-run-report-truncated-"));
  const previousSilent = false;
  setSilent(true);
  t.after(() => {
    setSilent(previousSilent);
  });

  const reporter = createRunReporter(root);
  reporter.setCommand("up");
  reporter.setValidation({ passed: true, failures: [] });
  reporter.setTests({
    status: "failed",
    passed: false,
    command: "npm test",
    stdout: "a".repeat(16),
    stderr: "b".repeat(16),
    stdout_truncated: true,
    stderr_truncated: true,
    stdout_bytes: 1536,
    stderr_bytes: 1536,
    output_max_bytes: 1024,
    exit_code: 1,
  });

  await reporter.finalize();

  const html = await fs.readFile(path.join(root, "agentify-report.html"), "utf8");

  assert.match(html, /test output was truncated/);
  assert.match(html, /stdout captured 1024 of 1536 bytes/);
  assert.match(html, /stderr captured 1024 of 1536 bytes/);
  assert.match(html, /tests\.outputMaxKb/);
});

test("createRunReporter redacts test stdout and stderr in persisted artifacts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-run-report-redaction-"));
  const previousSilent = false;
  setSilent(true);
  t.after(() => {
    setSilent(previousSilent);
  });

  const stdoutSecret = "sk-live-secret12345";
  const stderrSecret = "eyJhbGciOiJIUzI1NiJ9.secret";
  const reporter = createRunReporter(root);
  reporter.setCommand("up");
  reporter.setValidation({ passed: true, failures: [] });
  reporter.appendSection("[tests stdout]", `stdout context OPENAI_API_KEY=${stdoutSecret}`);
  reporter.appendSection("[tests stderr]", `stderr context Authorization: Bearer ${stderrSecret}`);
  reporter.setTests({
    status: "passed",
    passed: true,
    command: "pnpm test",
    stdout: `stdout context OPENAI_API_KEY=${stdoutSecret}`,
    stderr: `stderr context Authorization: Bearer ${stderrSecret}`,
    exit_code: 0,
  });

  await reporter.finalize();

  const output = await fs.readFile(path.join(root, "output.txt"), "utf8");
  const html = await fs.readFile(path.join(root, "agentify-report.html"), "utf8");

  assert.doesNotMatch(output, new RegExp(stdoutSecret));
  assert.doesNotMatch(output, new RegExp(stderrSecret));
  assert.doesNotMatch(html, new RegExp(stdoutSecret));
  assert.doesNotMatch(html, new RegExp(stderrSecret));
  assert.match(output, /stdout context OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(output, /stderr context Authorization: Bearer \[REDACTED\]/);
  assert.match(html, /stdout context OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(html, /stderr context Authorization: Bearer \[REDACTED\]/);
});

test("createRunReporter uses live loader milestones on interactive stderr", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-run-report-loader-"));
  const chunks = [];
  const originalWrite = process.stderr.write;
  const originalTerm = process.env.TERM;
  const originalCi = process.env.CI;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  setSilent(false);
  process.env.TERM = "xterm-256color";
  delete process.env.CI;
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: true,
  });
  process.stderr.write = (chunk, encoding, callback) => {
    chunks.push(String(chunk));
    const cb = typeof encoding === "function" ? encoding : callback;
    cb?.();
    return true;
  };

  t.after(() => {
    process.stderr.write = originalWrite;
    if (ttyDescriptor) {
      Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
    } else {
      delete process.stderr.isTTY;
    }
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    setSilent(false);
  });

  const reporter = createRunReporter(root);
  reporter.setCommand("up");
  reporter.log("scan: starting deterministic repository scan");
  reporter.percent("up", 33, "scan complete");
  reporter.log("tests: running pnpm test");
  reporter.log("tests: passed");
  reporter.setValidation({ passed: true, failures: [] });
  reporter.setTests({ status: "passed", passed: true });

  await reporter.finalize();

  const stderr = chunks.join("");
  const output = await fs.readFile(path.join(root, "output.txt"), "utf8");

  assert.match(stderr, /\x1b\[2K/);
  assert.match(stderr, /scan complete/);
  assert.match(stderr, /tests passed/);
  assert.doesNotMatch(stderr, /  ~ scan: starting deterministic repository scan\n/);
  assert.match(output, /\[agentify\] scan: starting deterministic repository scan/);
  assert.match(output, /\[agentify\] tests: passed/);
});
