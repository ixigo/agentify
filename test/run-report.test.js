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
  reporter.log("tests: passed");

  await reporter.finalize();

  const output = await fs.readFile(path.join(root, "output.txt"), "utf8");
  const html = await fs.readFile(path.join(root, "agentify-report.html"), "utf8");

  assert.match(output, /\[agentify\] tests: passed/);
  assert.match(html, /All configured test cases passed\./);
  assert.match(html, /Copy rerun tests command/);
  assert.match(html, /Total tokens/);
  assert.match(html, /&lt;script&gt;alert\('xss'\)&lt;\/script&gt;/);
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
