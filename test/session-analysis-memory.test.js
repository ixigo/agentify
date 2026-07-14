import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeSessionHistory } from "../src/core/session-analysis/index.js";

const ONE_GIB = 1024 ** 3;
const OVERSIZED_RECORD_BYTES = 128 * 1024 ** 2;
const RSS_CEILING = 256 * 1024 ** 2;

test("one-GiB provider history stays below the 256-MiB incremental RSS ceiling", {
  skip: process.env.AGENTIFY_RUN_MEMORY_BENCHMARK !== "1",
  timeout: 10 * 60_000,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-analysis-memory-"));
  const projectRoot = path.join(tempRoot, "repo");
  const sourceRoot = path.join(tempRoot, "claude");
  const filePath = path.join(sourceRoot, "large-session.jsonl");
  const oversizedPath = path.join(sourceRoot, "single-oversized-record.jsonl");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sourceRoot, { recursive: true });

  const record = `${JSON.stringify({
    type: "assistant",
    sessionId: "memory-benchmark",
    timestamp: "2026-07-14T08:00:00.000Z",
    cwd: projectRoot,
    message: { model: "benchmark", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  })}\n`;
  const repetitions = Math.ceil(ONE_GIB / Buffer.byteLength(record));
  const chunk = record.repeat(Math.min(repetitions, 10_000));
  const handle = await fs.open(filePath, "w");
  try {
    let written = 0;
    while (written < ONE_GIB) {
      const slice = chunk.slice(0, Math.min(chunk.length, ONE_GIB - written));
      await handle.write(slice);
      written += Buffer.byteLength(slice);
    }
  } finally {
    await handle.close();
  }

  const oversizedHandle = await fs.open(oversizedPath, "w");
  try {
    const prefix = `{"cwd":${JSON.stringify(projectRoot)},"payload":"`;
    await oversizedHandle.write(prefix);
    const payloadChunk = "x".repeat(64 * 1024);
    let written = Buffer.byteLength(prefix);
    while (written < OVERSIZED_RECORD_BYTES) {
      const slice = payloadChunk.slice(0, Math.min(payloadChunk.length, OVERSIZED_RECORD_BYTES - written));
      await oversizedHandle.write(slice);
      written += Buffer.byteLength(slice);
    }
    await oversizedHandle.write(`"}\n`);
  } finally {
    await oversizedHandle.close();
  }

  const before = process.memoryUsage().rss;
  const report = await analyzeSessionHistory(projectRoot, {
    provider: "claude",
    scope: "current-repo",
    sourceRoots: [sourceRoot],
    yes: true,
    noCache: true,
    toolInventory: {},
    now: new Date("2026-07-14T12:00:00.000Z"),
  });
  const delta = Math.max(0, process.memoryUsage().rss - before);

  assert.equal(report.totals.sessions, 1);
  assert.equal(report.providers[0].oversized_records, 1);
  assert.ok(delta < RSS_CEILING, `RSS grew by ${delta} bytes; ceiling is ${RSS_CEILING}`);
});
