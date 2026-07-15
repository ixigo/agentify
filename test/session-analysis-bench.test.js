import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSessionAnalysis } from "../src/core/session-analysis/index.js";

// Bounded-memory benchmark (#308): the analyzer must stream, so peak RSS
// growth must stay far below the input size no matter how large the
// history is. Opt-in because it generates hundreds of MB of fixtures:
//
//   pnpm bench:analyze                    # default 200 MB synthetic history
//   AGENTIFY_BENCH_MB=1024 pnpm bench:analyze   # full 1 GB run
//
// The ceiling is RSS GROWTH over the pre-scan baseline, not absolute RSS:
// a wholesale readText() regression would blow past it immediately, while
// the line-streaming parser stays comfortably under.
const BENCH_ENABLED = process.env.AGENTIFY_BENCH === "1";
const TARGET_MB = Number(process.env.AGENTIFY_BENCH_MB || 200);
const RSS_GROWTH_CEILING_MB = Number(process.env.AGENTIFY_BENCH_RSS_MB || 256);

function claudeRecord(repoRoot, index) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(Date.now() - (index % 1000) * 60_000).toISOString(),
    requestId: `req_${index}`,
    cwd: repoRoot,
    gitBranch: "main",
    sessionId: "bench",
    message: {
      id: `msg_${index}`,
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 200, output_tokens: 350 },
      content: [
        { type: "tool_use", id: `t_${index}`, name: "Bash", input: { command: `echo padding-${"x".repeat(1_500)}` } },
        { type: "text", text: `filler ${"y".repeat(2_000)}` },
      ],
    },
  });
}

test("analyze streams large histories with bounded RSS growth", { skip: !BENCH_ENABLED && "set AGENTIFY_BENCH=1 to run the memory benchmark" }, async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analyze-bench-"));
  const claudeRoot = path.join(repoRoot, "history", "claude");
  const projectDir = path.join(claudeRoot, "-bench-project");
  await fs.mkdir(projectDir, { recursive: true });

  // ~4 KB per record; ~5 MB per file.
  const recordsPerFile = 1_250;
  const targetBytes = TARGET_MB * 1_000_000;
  let written = 0;
  let fileIndex = 0;
  while (written < targetBytes) {
    const lines = [];
    for (let recordIndex = 0; recordIndex < recordsPerFile; recordIndex += 1) {
      lines.push(claudeRecord(repoRoot, fileIndex * recordsPerFile + recordIndex));
    }
    const body = `${lines.join("\n")}\n`;
    await fs.writeFile(path.join(projectDir, `bench-${fileIndex}.jsonl`), body);
    written += body.length;
    fileIndex += 1;
  }

  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);

  const startedAt = Date.now();
  let report;
  try {
    report = await buildSessionAnalysis(repoRoot, { claudeRoot, codexRoot: path.join(repoRoot, "none"), days: 30, cache: false });
  } finally {
    clearInterval(sampler);
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const elapsedMs = Date.now() - startedAt;
  const growthMb = (peakRss - baselineRss) / 1_000_000;

  console.log(`bench: ${(written / 1_000_000).toFixed(0)} MB across ${fileIndex} file(s) -> ${report.totals.sessions} session(s) in ${(elapsedMs / 1000).toFixed(1)}s; RSS growth ${growthMb.toFixed(0)} MB (ceiling ${RSS_GROWTH_CEILING_MB} MB)`);

  assert.equal(report.totals.sessions, fileIndex, "every generated file parses to one session");
  assert.ok(
    growthMb < RSS_GROWTH_CEILING_MB,
    `RSS grew ${growthMb.toFixed(0)} MB over baseline while scanning ${TARGET_MB} MB — streaming ceiling is ${RSS_GROWTH_CEILING_MB} MB`,
  );

  await fs.rm(repoRoot, { recursive: true, force: true });
});
