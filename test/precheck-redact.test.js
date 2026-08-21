import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeCommandSignature,
  precheckCommand,
  renderPrecheckWarning,
  trackEvent,
} from "../src/core/ctx.js";
import { redactSensitiveText } from "../src/core/redact.js";

// ---------------------------------------------------------------------------
// Part A — normalizeCommandSignature
// ---------------------------------------------------------------------------

test("normalizeCommandSignature strips env prefixes and sudo wrappers", () => {
  assert.equal(normalizeCommandSignature("terraform apply"), "terraform apply");
  assert.equal(normalizeCommandSignature("FOO=bar terraform apply"), "terraform apply");
  assert.equal(normalizeCommandSignature("FOO=bar BAZ=qux sudo terraform apply"), "terraform apply");
  assert.equal(normalizeCommandSignature("sudo terraform apply"), "terraform apply");
});

test("normalizeCommandSignature uses binary basename", () => {
  assert.equal(normalizeCommandSignature("/usr/local/bin/terraform apply"), "terraform apply");
  assert.equal(normalizeCommandSignature("./node_modules/.bin/eslint --fix"), "eslint --fix");
});

test("normalizeCommandSignature strips flag values and sorts flag names", () => {
  // A changed flag VALUE produces the same signature.
  assert.equal(
    normalizeCommandSignature("terraform apply -lock=false"),
    normalizeCommandSignature("terraform apply -lock=true"),
  );
  // Flag names are sorted and de-duplicated; positional args are dropped.
  assert.equal(
    normalizeCommandSignature("npm run build --prefix /a --silent"),
    "npm run --prefix --silent",
  );
  assert.equal(
    normalizeCommandSignature("npm run build --silent --prefix /b"),
    "npm run --prefix --silent",
  );
  // `--out file` records only the flag name (`--out`); `file`-position handling
  // follows the first-non-flag-token rule.
  assert.equal(normalizeCommandSignature("git commit --amend -m x"), "git commit --amend -m");
});

test("normalizeCommandSignature only looks at the first pipeline segment", () => {
  assert.equal(
    normalizeCommandSignature("grep foo file | sort | uniq -c"),
    normalizeCommandSignature("grep foo other"),
  );
  assert.equal(normalizeCommandSignature("make build && make test"), "make build");
  assert.equal(normalizeCommandSignature("ls; rm -rf x"), "ls");
});

test("normalizeCommandSignature distinguishes bare-binary from subcommand invocations", () => {
  // A bare binary (no subcommand) has no subcommand slot.
  assert.equal(normalizeCommandSignature("eslint --fix"), "eslint --fix");
  assert.equal(normalizeCommandSignature("eslint"), "eslint");
  // Differs from a real subcommand.
  assert.notEqual(
    normalizeCommandSignature("eslint --fix"),
    normalizeCommandSignature("eslint src --fix"),
  );
});

// ---------------------------------------------------------------------------
// Part A — precheckCommand tiers
// ---------------------------------------------------------------------------

async function withRepo(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-precheck-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const failed = (session, command, stderr = "boom") => ({
  session_id: session,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { exit_code: 1, stderr },
});

const precheckPayload = (session, command) => ({
  session_id: session,
  tool_name: "Bash",
  tool_input: { command },
});

test("precheck exact-match wording is unchanged (strongest warning)", async () => {
  await withRepo(async (dir) => {
    await trackEvent(dir, failed("old", "terraform apply", "state lock held"));
    const warning = await precheckCommand(dir, precheckPayload("new", "terraform apply"));
    assert.ok(warning);
    assert.equal(warning.match, undefined);
    const text = renderPrecheckWarning(warning);
    assert.match(text, /this exact command failed in a previous session/);
    assert.match(text, /state lock held/);
  });
});

test("precheck signature-match warns softer on a changed flag value", async () => {
  await withRepo(async (dir) => {
    await trackEvent(dir, failed("old", "terraform apply -lock=false", "state lock held"));
    // Different flag VALUE — exact match would miss it, signature catches it.
    const warning = await precheckCommand(dir, precheckPayload("new", "terraform apply -lock=true"));
    assert.ok(warning, "expected a signature-tier warning");
    assert.equal(warning.match, "signature");
    const text = renderPrecheckWarning(warning);
    assert.match(text, /a similar command failed in a previous session/);
    assert.match(text, /differs only in arguments\/flags/);
    // Includes the failed command text and its error.
    assert.match(text, /terraform apply -lock=false/);
    assert.match(text, /state lock held/);
  });
});

test("precheck signature-match survives commands longer than the 200-char clip", async () => {
  await withRepo(async (dir) => {
    const longTail = "x".repeat(300);
    await trackEvent(dir, failed("old", `deploy release --target ${longTail}`, "nope"));
    const warning = await precheckCommand(
      dir,
      precheckPayload("new", `deploy release --target ${"y".repeat(300)}`),
    );
    assert.ok(warning, "signature should match beyond the clip boundary");
    assert.equal(warning.match, "signature");
  });
});

test("precheck does NOT signature-warn when the binary differs", async () => {
  await withRepo(async (dir) => {
    await trackEvent(dir, failed("old", "terraform apply -x"));
    assert.equal(await precheckCommand(dir, precheckPayload("new", "terragrunt apply -y")), null);
  });
});

test("precheck does NOT signature-warn when the subcommand differs", async () => {
  await withRepo(async (dir) => {
    await trackEvent(dir, failed("old", "terraform apply -x"));
    assert.equal(await precheckCommand(dir, precheckPayload("new", "terraform destroy -y")), null);
  });
});

test("precheck does NOT signature-warn a bare-binary invocation against a subcommand", async () => {
  await withRepo(async (dir) => {
    await trackEvent(dir, failed("old", "eslint src --fix"));
    assert.equal(await precheckCommand(dir, precheckPayload("new", "eslint --fix")), null);
  });
});

test("precheck signature-match dedupes once per session", async () => {
  await withRepo(async (dir) => {
    // Same binary + subcommand (`npm test`), only a flag VALUE varies.
    await trackEvent(dir, failed("old", "npm test --reporter=a --bail"));
    const first = await precheckCommand(dir, precheckPayload("new", "npm test --reporter=b --bail"));
    assert.ok(first);
    assert.equal(first.match, "signature");
    // Same session, same signature again (flags reordered): suppressed.
    assert.equal(await precheckCommand(dir, precheckPayload("new", "npm test --bail --reporter=c")), null);
    // A fresh session warns again.
    const other = await precheckCommand(dir, precheckPayload("third", "npm test --reporter=d --bail"));
    assert.ok(other);
    assert.equal(other.match, "signature");
  });
});

test("precheck signature-match respects same-session and resolved guarantees", async () => {
  await withRepo(async (dir) => {
    await trackEvent(dir, failed("old", "vault write secret/x foo=1"));
    // Same session that saw the failure: no warning.
    assert.equal(await precheckCommand(dir, precheckPayload("old", "vault write secret/x foo=2")), null);
    // Later the signature succeeds -> no more warnings for anyone.
    await trackEvent(dir, {
      session_id: "old",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "vault write secret/x foo=3" },
      tool_response: { exit_code: 0 },
    });
    assert.equal(await precheckCommand(dir, precheckPayload("new", "vault write secret/x foo=4")), null);
  });
});

// ---------------------------------------------------------------------------
// Part B — redaction depth
// ---------------------------------------------------------------------------

test("redactSensitiveText redacts each new provider token type", () => {
  const cases = [
    // AWS access key ids (long-term + temporary).
    ["aws key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"],
    ["aws temp ASIAIOSFODNN7EXAMPLE here", "ASIAIOSFODNN7EXAMPLE"],
    // GitHub classic + fine-grained.
    [`token ghp_${"a".repeat(36)} end`, `ghp_${"a".repeat(36)}`],
    [`token ghs_${"B".repeat(40)} end`, `ghs_${"B".repeat(40)}`],
    [`token github_pat_${"1".repeat(22)}_${"a".repeat(20)} end`, "github_pat_"],
    // Slack.
    ["slack xoxb-123456789012-abcdEFGH end", "xoxb-123456789012-abcdEFGH"],
    // GitLab.
    [`gitlab glpat-${"a".repeat(20)} end`, `glpat-${"a".repeat(20)}`],
    // npm automation token + .npmrc auth line.
    [`npm npm_${"a".repeat(36)} end`, `npm_${"a".repeat(36)}`],
    ["//registry.npmjs.org/:_authToken=abc123secretvalue", "abc123secretvalue"],
    // Google API key.
    [`goog AIza${"A".repeat(35)} end`, `AIza${"A".repeat(35)}`],
    // PEM private key block (multiline).
    [
      "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nDEFghi\n-----END RSA PRIVATE KEY-----\nafter",
      "MIIEabc",
    ],
  ];
  for (const [input, secret] of cases) {
    const out = redactSensitiveText(input);
    assert.ok(!out.includes(secret), `expected ${secret} to be redacted in: ${out}`);
    assert.match(out, /\[REDACTED\]/);
  }
});

test("redactSensitiveText preserves the PEM surrounding text and collapses the block", () => {
  const out = redactSensitiveText(
    "keep-before -----BEGIN PRIVATE KEY-----\nsecretmaterial\n-----END PRIVATE KEY----- keep-after",
  );
  assert.match(out, /keep-before/);
  assert.match(out, /keep-after/);
  assert.ok(!out.includes("secretmaterial"));
});

test("redactSensitiveText does NOT redact harmless lookalikes", () => {
  // A 40-char git SHA context, a normal URL, and the word "skill".
  const sha = "5d55ea2f1c9b0a7e6d4c3b2a1908f7e6d5c4b3a2";
  const negatives = [
    `commit ${sha}`,
    "see https://github.com/ixigo/agentify for details",
    "run the migrate-php-to-astro skill now",
    "installing skills and skillsets",
  ];
  for (const input of negatives) {
    assert.equal(redactSensitiveText(input), input, `should not redact: ${input}`);
  }
});
