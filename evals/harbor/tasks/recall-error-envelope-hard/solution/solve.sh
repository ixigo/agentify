#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

cat > src/api.js <<'EOF'
import { respondError, respondOk } from "./errors.js";
import { orders, users } from "./store.js";

export function getUser(id) {
  const user = users.get(id);
  if (!user) {
    return respondError(404, "user_not_found", `No user with id ${id}`);
  }
  return respondOk(user);
}

export function getOrder(id) {
  const order = orders.get(id);
  if (!order) {
    return respondError(404, "order_not_found", `No order with id ${id}`);
  }
  return respondOk(order);
}
EOF

cat >> test/api.test.js <<'EOF'

test("getOrder uses the error envelope for unknown ids", async () => {
  const { getOrder } = await import("../src/api.js");
  const response = getOrder("o-404");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "order_not_found");
});
EOF

node --test
