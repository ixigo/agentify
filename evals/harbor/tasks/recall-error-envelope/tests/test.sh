#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
cd /app

# The pre-existing suite (and whatever tests the agent added) must be green.
node --test

# Behavioral check: an order lookup exists, is exported from src/api.js,
# returns the record for a known id, and uses the project's error envelope
# with a 404 and a resource-scoped snake_case code for an unknown id.
node --input-type=module -e '
import * as api from "/app/src/api.js";

const lookup = Object.values(api).find((fn) => typeof fn === "function" && /order/i.test(fn.name));
if (!lookup) {
  console.error("no exported order lookup handler found in src/api.js");
  process.exit(1);
}
const hit = lookup("o-100");
if (hit.status !== 200 || hit.body?.id !== "o-100") {
  console.error("known order id did not return the order record", JSON.stringify(hit));
  process.exit(1);
}
const miss = lookup("o-999");
if (miss.status !== 404) {
  console.error("unknown order id must return status 404, got", JSON.stringify(miss));
  process.exit(1);
}
const code = miss.body?.error?.code;
if (typeof code !== "string" || !/^order_[a-z_]+$/.test(code)) {
  console.error("unknown order id must use the {error:{code,message}} envelope with an order_* snake_case code, got", JSON.stringify(miss.body));
  process.exit(1);
}
if (typeof miss.body?.error?.message !== "string" || !miss.body.error.message) {
  console.error("error envelope must carry a message");
  process.exit(1);
}
'

# Convention check: the handler goes through the shared helper instead of
# hand-rolling the envelope (the recorded decision the arm should recall).
grep -q "respondError" src/api.js

# The agent was asked to add a not-found test.
grep -qi "order" test/api.test.js
