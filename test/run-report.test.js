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
  reporter.setScan({ wrote: [".agents/index.db"] });
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
    await fs.readFile(path.join(root, ".agents", "runs", "test-execution-execution-telemetry.json"), "utf8")
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
