import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  VERSION,
  checkForUpdate,
  compareSemver,
  parseGitDescribe,
  pickLatestReleaseTag,
  repoUrlFromPackage,
  resolveVersionString,
  shapeVersion,
} from "../src/core/version.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Run `agentify` in a child process so the node:test reporter's stdout is never
// interleaved with the command's output. The cache home is redirected so the
// invocation counter never touches the user's real cache.
async function runCliBinary(args) {
  const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-version-cache-"));
  try {
    const result = await execFileAsync(process.execPath, ["src/cli.js", ...args], {
      cwd: repoRoot,
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return result.stdout;
  } finally {
    await fs.rm(cacheHome, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// parseGitDescribe
// ---------------------------------------------------------------------------

test("parseGitDescribe recognizes an exact release tag (distance 0)", () => {
  assert.deepEqual(parseGitDescribe("v0.5.0-0-gabc1234"), {
    exactTag: "v0.5.0",
    shortSha: "abc1234",
    dirty: false,
  });
});

test("parseGitDescribe treats commits past a tag as untagged", () => {
  assert.deepEqual(parseGitDescribe("v0.5.0-3-gdeadbee"), {
    exactTag: null,
    shortSha: "deadbee",
    dirty: false,
  });
});

test("parseGitDescribe flags a dirty working tree", () => {
  assert.deepEqual(parseGitDescribe("v0.5.0-0-gabc1234-dirty"), {
    exactTag: "v0.5.0",
    shortSha: "abc1234",
    dirty: true,
  });
});

test("parseGitDescribe handles a repo with no tags (bare --always sha)", () => {
  assert.deepEqual(parseGitDescribe("abc1234"), {
    exactTag: null,
    shortSha: "abc1234",
    dirty: false,
  });
});

test("parseGitDescribe returns null when git produced nothing", () => {
  assert.equal(parseGitDescribe(null), null);
  assert.equal(parseGitDescribe(""), null);
  assert.equal(parseGitDescribe("   "), null);
});

// ---------------------------------------------------------------------------
// shapeVersion — the install-shape matrix
// ---------------------------------------------------------------------------

test("shapeVersion prints a clean version on an exact release tag", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", git: { exactTag: "v0.5.0", shortSha: "abc1234", dirty: false } }),
    "0.5.0",
  );
});

test("shapeVersion appends the sha on an untagged checkout", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", git: { exactTag: null, shortSha: "abc1234", dirty: false } }),
    "0.5.0+abc1234",
  );
});

test("shapeVersion never treats a dirty tree as a clean release", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", git: { exactTag: "v0.5.0", shortSha: "abc1234", dirty: true } }),
    "0.5.0+abc1234",
  );
});

test("shapeVersion ignores a tag that does not match the package version", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", git: { exactTag: "v0.4.0", shortSha: "abc1234", dirty: false } }),
    "0.5.0+abc1234",
  );
});

test("shapeVersion reads a build-info release tag written by install.sh", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", buildInfo: { ref: "v0.5.0", commit: "abc1234000" } }),
    "0.5.0",
  );
});

test("shapeVersion appends the sha for a build-info non-release ref", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", buildInfo: { ref: "main", commit: "abc1234def" } }),
    "0.5.0+abc1234",
  );
});

test("shapeVersion falls back to npm gitHead when nothing else is present", () => {
  assert.equal(
    shapeVersion({ version: "0.5.0", gitHead: "abc1234def5678" }),
    "0.5.0+abc1234",
  );
});

test("shapeVersion returns the bare version when no identity source is available", () => {
  assert.equal(shapeVersion({ version: "0.5.0" }), "0.5.0");
});

test("shapeVersion prefers git over build-info over gitHead", () => {
  assert.equal(
    shapeVersion({
      version: "0.5.0",
      git: { exactTag: null, shortSha: "1111111", dirty: false },
      buildInfo: { ref: "main", commit: "2222222222" },
      gitHead: "3333333333",
    }),
    "0.5.0+1111111",
  );
});

// ---------------------------------------------------------------------------
// resolveVersionString — injected IO
// ---------------------------------------------------------------------------

test("resolveVersionString uses the injected git runner without touching disk", () => {
  const out = resolveVersionString({
    version: "0.5.0",
    runGitDescribe: () => "v0.5.0-7-gfeedface",
    buildInfo: null,
    gitHead: null,
  });
  assert.equal(out, "0.5.0+feedfac");
});

test("resolveVersionString with a no-git runner falls through to build-info", () => {
  const out = resolveVersionString({
    version: "0.5.0",
    runGitDescribe: () => null,
    buildInfo: { ref: "v0.5.0", commit: "abc1234000" },
    gitHead: null,
  });
  assert.equal(out, "0.5.0");
});

// ---------------------------------------------------------------------------
// compareSemver + pickLatestReleaseTag
// ---------------------------------------------------------------------------

test("compareSemver orders by numeric component, not lexically", () => {
  assert.ok(compareSemver("v0.10.0", "v0.9.0") > 0);
  assert.ok(compareSemver("0.9.0", "0.10.0") < 0);
  assert.equal(compareSemver("v0.5.0", "0.5.0"), 0);
  assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
});

test("pickLatestReleaseTag ignores non-release tags and peeled refs", () => {
  const lsRemote = [
    "aaaaaaaaaaaa\trefs/tags/v0.9.0",
    "bbbbbbbbbbbb\trefs/tags/v0.10.0",
    "cccccccccccc\trefs/tags/v0.10.0^{}",
    "dddddddddddd\trefs/tags/v0.4.0",
    "eeeeeeeeeeee\trefs/tags/nightly",
    "ffffffffffff\trefs/tags/v1.0.0-rc1",
  ].join("\n");
  assert.equal(pickLatestReleaseTag(lsRemote), "v0.10.0");
});

test("pickLatestReleaseTag returns null when there are no release tags", () => {
  assert.equal(pickLatestReleaseTag(""), null);
  assert.equal(pickLatestReleaseTag("xxxx\trefs/tags/nightly\nyyyy\trefs/heads/main"), null);
});

test("repoUrlFromPackage honors AGENTIFY_REPO and otherwise reads package.json", () => {
  assert.equal(repoUrlFromPackage({ AGENTIFY_REPO: "octo/thing" }), "https://github.com/octo/thing.git");
  assert.equal(repoUrlFromPackage({}), "https://github.com/ixigo/agentify.git");
});

// ---------------------------------------------------------------------------
// checkForUpdate — offline/behind/up-to-date/no-releases, all injected
// ---------------------------------------------------------------------------

test("checkForUpdate reports 'behind' when a newer release exists", () => {
  const result = checkForUpdate({
    version: "0.5.0",
    repoUrl: "https://example/x.git",
    runLsRemote: () => "aaaa\trefs/tags/v0.6.0\nbbbb\trefs/tags/v0.5.0",
  });
  assert.deepEqual(result, {
    installed: "0.5.0",
    latest: "v0.6.0",
    status: "behind",
    ok: true,
    repo: "https://example/x.git",
  });
});

test("checkForUpdate reports 'up_to_date' when installed matches or exceeds latest", () => {
  const result = checkForUpdate({
    version: "0.6.0",
    runLsRemote: () => "aaaa\trefs/tags/v0.6.0",
  });
  assert.equal(result.status, "up_to_date");
  assert.equal(result.ok, true);
});

test("checkForUpdate reports 'no_releases' when the repo has no release tags", () => {
  const result = checkForUpdate({
    version: "0.5.0",
    runLsRemote: () => "aaaa\trefs/heads/main",
  });
  assert.equal(result.status, "no_releases");
  assert.equal(result.latest, null);
  assert.equal(result.ok, true);
});

test("checkForUpdate fails closed (status 'unknown') when offline", () => {
  const result = checkForUpdate({
    version: "0.5.0",
    runLsRemote: () => {
      throw new Error("network unreachable");
    },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.ok, false);
  assert.equal(result.latest, null);
});

// ---------------------------------------------------------------------------
// command surface (no network: only the plain `version` path)
// ---------------------------------------------------------------------------

test("agentify version prints the shaped version string", async () => {
  const out = await runCliBinary(["version"]);
  assert.match(out, /^agentify v\d+\.\d+\.\d+/);
});

test("agentify version --json prints a machine-readable version", async () => {
  const out = await runCliBinary(["version", "--json"]);
  const parsed = JSON.parse(out);
  assert.match(parsed.version, /^\d+\.\d+\.\d+/);
});

test("VERSION is the published package version", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("an installed package inside an unrelated git repo does not borrow that repo's commit", async () => {
  const { execFileSync } = await import("node:child_process");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const outer = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "agentify-version-outer-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", outer, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "outer");
    const installed = nodePath.join(outer, "lib", "node_modules", "agentify");
    await fsp.mkdir(installed, { recursive: true });
    await fsp.writeFile(nodePath.join(installed, "package.json"), JSON.stringify({ name: "agentify", version: "1.2.3" }));
    assert.equal(resolveVersionString({ root: installed, version: "1.2.3" }), "1.2.3");
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});
