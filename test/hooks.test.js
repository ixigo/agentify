import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installHooks } from "../src/core/hooks.js";

test("installHooks writes a valid post-merge refresh command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });

  await installHooks(root);

  const postMerge = await fs.readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
  assert.match(postMerge, /agentify scan --json >\/dev\/null 2>&1 \|\| true/);
  assert.doesNotMatch(postMerge, /--skip-finalize/);
});
