import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { createClient } from "../src/client.js";

test("loadConfig reads the flat keys from settings.yaml", () => {
  const config = loadConfig();
  assert.equal(typeof config.retry_limit, "number");
  assert.ok(config.retry_limit >= 1);
  assert.equal(config.base_url, "https://api.example.test");
  assert.equal(typeof config.timeout_ms, "number");
});

test("createClient honors the retry limit from config", () => {
  const client = createClient();
  const plan = client.request("/ping");
  assert.equal(plan.attempts, loadConfig().retry_limit);
  assert.ok(plan.url.startsWith("https://api.example.test"));
});
