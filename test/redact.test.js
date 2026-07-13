import test from "node:test";
import assert from "node:assert/strict";

import { redactSensitiveText } from "../src/core/redact.js";

test("redactSensitiveText masks key=value style secrets", () => {
  const cases = [
    ["API_KEY=abc123secret", "API_KEY=[REDACTED]"],
    ["export STRIPE_SECRET=sk_live_notreal cmd", "export STRIPE_SECRET=[REDACTED] cmd"],
    ["DB_PASSWORD: hunter22", "DB_PASSWORD: [REDACTED]"],
    ['AWS_ACCESS_KEY_ID="AKIANOTREAL"', 'AWS_ACCESS_KEY_ID="[REDACTED]"'],
    ["MY_TOKEN=tok_value --flag", "MY_TOKEN=[REDACTED] --flag"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSensitiveText(input), expected, `input: ${input}`);
  }
});

test("redactSensitiveText masks bearer tokens, JWTs, and sk- keys", () => {
  assert.equal(
    redactSensitiveText("curl -H 'Authorization: Bearer abcdef123456789012'"),
    "curl -H 'Authorization: Bearer [REDACTED]'"
  );
  assert.equal(
    redactSensitiveText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"),
    "jwt [REDACTED]"
  );
  assert.equal(
    redactSensitiveText("key sk-abcdefghijklmnop end"),
    "key [REDACTED] end"
  );
});

test("redactSensitiveText leaves ordinary text untouched", () => {
  const cases = [
    "git commit -m 'fix: tighten token parsing'",
    "npm test -- --grep password-reset",
    "ls -la src/core",
    "",
  ];
  for (const input of cases) {
    assert.equal(redactSensitiveText(input), input);
  }
});

test("redactSensitiveText tolerates non-string input", () => {
  assert.equal(redactSensitiveText(null), "");
  assert.equal(redactSensitiveText(undefined), "");
  assert.equal(redactSensitiveText(42), "42");
});

test("redactSensitiveText masks URL credentials and HTTP auth schemes", () => {
  assert.equal(
    redactSensitiveText("DATABASE_URL is postgres://alice:hunter2@example.com/db"),
    "DATABASE_URL is postgres://alice:[REDACTED]@example.com/db",
  );
  assert.equal(
    redactSensitiveText("Authorization: Basic dXNlcjpwYXNzd29yZA=="),
    "Authorization: Basic [REDACTED]",
  );
  assert.equal(
    redactSensitiveText("proxy uses Digest abcdef1234567890"),
    "proxy uses Digest [REDACTED]",
  );
  // URLs without credentials stay untouched.
  assert.equal(
    redactSensitiveText("fetch https://example.com/path?x=1"),
    "fetch https://example.com/path?x=1",
  );
});
