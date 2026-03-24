import test from "node:test";
import assert from "node:assert/strict";

import { parseClaudeJson, parseGeminiJson, parseOpenCodeJsonl } from "../src/core/provider.js";

test("parseClaudeJson extracts structured output and usage", () => {
  const result = parseClaudeJson(JSON.stringify({
    structured_output: { ok: true },
    usage: {
      input_tokens: 10,
      output_tokens: 5
    }
  }));

  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15
  });
});

test("parseGeminiJson extracts embedded response JSON and token stats", () => {
  const result = parseGeminiJson(JSON.stringify({
    response: "{\"ok\":true}",
    stats: {
      models: {
        a: { tokens: { input: 100, candidates: 20, total: 120 } },
        b: { tokens: { input: 50, candidates: 10, total: 60 } }
      }
    }
  }));

  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, {
    input_tokens: 150,
    output_tokens: 30,
    total_tokens: 180
  });
});

test("parseOpenCodeJsonl extracts final JSON payload and token stats", () => {
  const result = parseOpenCodeJsonl([
    "{\"type\":\"text\",\"part\":{\"text\":\"{\\\"ok\\\":true}\"}}",
    "{\"type\":\"step_finish\",\"part\":{\"tokens\":{\"input\":80,\"output\":12,\"total\":92}}}"
  ].join("\n"));

  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, {
    input_tokens: 80,
    output_tokens: 12,
    total_tokens: 92
  });
});
