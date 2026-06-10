import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePath,
  normalizePrefix,
  normalizeRepoPath,
  toGitRelativePath,
  toRootRelativePath,
} from "../src/core/utils/paths.js";

test("normalizePath converts separators, trims leading dot, and collapses slashes", () => {
  assert.equal(normalizePath(".\\src//core\\git.js"), "src/core/git.js");
  assert.equal(normalizePath("./src///core"), "src/core");
  assert.equal(normalizePath(null), "");
});

test("normalizeRepoPath preserves execution and cleanup normalization modes", () => {
  assert.equal(normalizeRepoPath("./.agentify//index.db"), ".agentify/index.db");
  assert.equal(
    normalizeRepoPath("/docs//modules\\core.md", { stripEmptySegments: true }),
    "docs/modules/core.md",
  );
  assert.equal(normalizeRepoPath("", { nullOnEmpty: true }), null);
});

test("prefix and git-root path helpers handle nested worktree prefixes", () => {
  assert.equal(normalizePrefix("packages/app/"), "packages/app");
  assert.equal(toRootRelativePath("packages/app/src/index.js", "packages/app"), "src/index.js");
  assert.equal(toRootRelativePath("packages/app", "packages/app"), ".");
  assert.equal(toRootRelativePath("other/file.js", "packages/app"), null);
  assert.equal(toGitRelativePath("src/index.js", "packages/app"), "packages/app/src/index.js");
  assert.equal(toGitRelativePath(".", "packages/app"), "packages/app");
});
