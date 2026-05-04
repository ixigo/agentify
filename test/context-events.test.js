import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendContextEvent,
  checkContextEventSchema,
  createContextEventRecord,
  getContextEventLogPath,
  readContextEvents,
} from "../src/core/context-events.js";
import { SCHEMA_VERSIONS } from "../src/core/schema.js";

test("createContextEventRecord normalizes the context event schema", () => {
  const record = createContextEventRecord({
    runId: "run_1",
    path: "src/core/config.js",
    eventType: "fetch",
    source: "local-index",
    hash: "sha256:abc123",
    summary: "Config defaults were loaded.",
    confidence: 0.91,
  }, { now: "2026-05-04T00:00:00.000Z" });

  assert.deepEqual(record, {
    schema_version: SCHEMA_VERSIONS.CONTEXT_EVENT,
    run_id: "run_1",
    path: "src/core/config.js",
    event_type: "fetch",
    source: "local-index",
    hash: "sha256:abc123",
    summary: "Config defaults were loaded.",
    confidence: 0.91,
    created_at: "2026-05-04T00:00:00.000Z",
  });
  assert.deepEqual(checkContextEventSchema(record), { compatible: true, needsMigration: false });
});

test("context event schema rejects incompatible major versions", () => {
  const result = checkContextEventSchema({ schema_version: "2.0" });

  assert.equal(result.compatible, false);
  assert.match(result.reason, /Major version mismatch/);
});

test("appendContextEvent persists session events under ignored session artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-context-events-session-"));

  const result = await appendContextEvent(root, {
    run_id: "run_2",
    path: "src/core/session.js",
    event_type: "compact",
    source: "provider-summary",
    hash: "sha256:def456",
    summary: "Session context was compacted.",
    confidence: 0.8,
  }, {
    sessionId: "sess_context",
    now: "2026-05-04T01:00:00.000Z",
  });

  assert.equal(result.path, path.join(root, ".agents", "session", "sess_context", "context-events.jsonl"));
  const raw = await fs.readFile(result.path, "utf8");
  assert.equal(raw.trim().split(/\r?\n/).length, 1);

  const events = await readContextEvents(root, { sessionId: "sess_context" });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "compact");
  assert.equal(events[0].run_id, "run_2");
});

test("appendContextEvent persists run events under ignored Agentify work artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-context-events-run-"));

  const result = await appendContextEvent(root, {
    run_id: "run_3",
    path: "docs/repo-map.md",
    event_type: "search",
    source: "local-search",
    hash: "sha256:ghi789",
    summary: "",
    confidence: 1,
  });

  assert.equal(result.path, getContextEventLogPath(root, { runId: "run_3" }));
  assert.equal(path.relative(root, result.path).split(path.sep).join("/"), ".agentify/work/context-events/run_3.jsonl");
});
