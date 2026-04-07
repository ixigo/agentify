import test from "node:test";
import assert from "node:assert/strict";

import { parseCodexJsonl, runChild } from "../src/core/provider.js";

test("parseCodexJsonl extracts token usage from turn.completed", () => {
  const usage = parseCodexJsonl([
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":30,"output_tokens":45}}'
  ].join("\n"));

  assert.deepEqual(usage, {
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165
  });
});

test("runChild times out stalled provider subprocesses", async () => {
  await assert.rejects(
    () => runChild("node", ["-e", "setInterval(() => {}, 1000);"], {
      timeoutMs: 50,
    }),
    /timed out after 50ms/,
  );
});
