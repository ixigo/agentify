import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeManagerPlan, sanitizeModuleResponse } from "../src/core/agent-contract.js";

test("sanitizeManagerPlan drops unknown module ids and trims content", () => {
  const plan = sanitizeManagerPlan(
    {
      repo_summary: "  repo summary  ",
      shared_conventions: ["  docs under docs  ", "", 1],
      module_focus: [
        { module_id: "auth", focus: " authentication flows " },
        { module_id: "payments", focus: "ignored" }
      ]
    },
    new Set(["auth"])
  );

  assert.equal(plan.repo_summary, "repo summary");
  assert.deepEqual(plan.shared_conventions, ["docs under docs"]);
  assert.deepEqual(plan.module_focus, [{ module_id: "auth", focus: "authentication flows" }]);
});

test("sanitizeModuleResponse filters out paths outside the module and fills missing header summaries", () => {
  const result = sanitizeModuleResponse(
    {
      markdown: "# Auth\n",
      summary: "Auth module summary",
      public_api: [
        { symbol: "login", kind: "function", path: "src/auth/index.ts" },
        { symbol: "escape", kind: "function", path: "../hack.ts" }
      ],
      start_here: [
        { path: "src/auth/index.ts", why: "entry" },
        { path: "src/other/index.ts", why: "wrong module" }
      ],
      side_effects: ["network", "invalid"],
      header_summaries: [
        { path: "src/auth/index.ts", summary: "Main auth surface." },
        { path: "src/other/index.ts", summary: "Should be ignored." }
      ]
    },
    { rootPath: "src/auth" },
    new Set(["src/auth/index.ts", "src/auth/service.ts"])
  );

  assert.deepEqual(result.public_api, [
    { symbol: "login", kind: "function", path: "src/auth/index.ts" }
  ]);
  assert.deepEqual(result.start_here, [
    { path: "src/auth/index.ts", why: "entry" }
  ]);
  assert.deepEqual(result.side_effects, ["network"]);
  assert.deepEqual(result.header_summaries, [
    { path: "src/auth/index.ts", summary: "Main auth surface." },
    { path: "src/auth/service.ts", summary: "Auth module summary" }
  ]);
});
