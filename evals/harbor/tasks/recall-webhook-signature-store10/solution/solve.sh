#!/usr/bin/env bash
set -euo pipefail
cd /app

cat > src/webhook.js <<'EOF'
import { digest, secureEqual } from "./crypto.js";

export function verifyWebhook({ rawBody, timestamp, signature }, secret) {
  const expected = `sha256=${digest(secret, `${timestamp}:${rawBody}`)}`;
  return secureEqual(expected, signature);
}
EOF

cat > test/webhook.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "../src/crypto.js";
import { verifyWebhook } from "../src/webhook.js";

test("verifyWebhook accepts the provider wire format", () => {
  const rawBody = '{"paid":true}';
  const timestamp = "1778000000";
  const signature = `sha256=${digest("secret", `${timestamp}:${rawBody}`)}`;
  assert.equal(verifyWebhook({ rawBody, timestamp, signature }, "secret"), true);
  assert.equal(verifyWebhook({ rawBody: `${rawBody} `, timestamp, signature }, "secret"), false);
});
EOF

node --test
