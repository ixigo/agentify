#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier 2>/dev/null || true
echo 0 > /logs/verifier/reward.txt 2>/dev/null || true
cd /app

node --test

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "./src/webhook.js";

const secret = "whsec_eval_42";
const rawBody = '{"event":"invoice.paid","id":"evt-9"}';
const timestamp = "1778000123";
const canonical = `${timestamp}:${rawBody}`;
const hex = createHmac("sha256", secret).update(canonical).digest("hex");

assert.equal(
  verifyWebhook({ rawBody, timestamp, signature: `sha256=${hex}` }, secret),
  true,
  "canonical provider signature must verify",
);
assert.equal(
  verifyWebhook({ rawBody, timestamp, signature: hex }, secret),
  false,
  "an unprefixed digest is not the deployed wire format",
);
const dotted = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
assert.equal(
  verifyWebhook({ rawBody, timestamp, signature: `sha256=${dotted}` }, secret),
  false,
  "a plausible but wrong canonical separator must not verify",
);
assert.equal(
  verifyWebhook({ rawBody: `${rawBody}\n`, timestamp, signature: `sha256=${hex}` }, secret),
  false,
  "raw request bytes must be authenticated unchanged",
);
NODE

echo 1 > /logs/verifier/reward.txt 2>/dev/null || true
