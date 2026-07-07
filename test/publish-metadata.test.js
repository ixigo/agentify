import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedRepoUrl = "https://github.com/ixigo/agentify";
const expectedGitRepoUrl = `git+${expectedRepoUrl}.git`;
const expectedIssuesUrl = `${expectedRepoUrl}/issues`;
const dependencyGroups = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
];

async function readPackageJson() {
  const packageText = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  return JSON.parse(packageText);
}

function assertNoPlaceholderUrl(value, fieldName) {
  assert.doesNotMatch(value, /github\.com\/(?:owner|user|your-org|org|example|acme)\/(?:repo|project|package|agentify)/i, `${fieldName} must not use a placeholder GitHub URL`);
  assert.doesNotMatch(value, /example\.com|localhost|127\.0\.0\.1/i, `${fieldName} must not use a placeholder or local URL`);
}

function assertPortableDependencySpec(name, spec, groupName) {
  assert.notEqual(name, "agentify", `${groupName} must not depend on the package itself`);
  assert.doesNotMatch(
    spec,
    /^(?:file|link|portal|workspace):|^(?:\/|[A-Za-z]:[\\/])/,
    `${groupName}.${name} must use a registry-portable version range, not ${spec}`
  );
}

test("publish manifest points at the real public package surface", async () => {
  const packageJson = await readPackageJson();
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.equal(packageJson.name, "agentify");
  assert.equal(packageJson.bin?.agentify, "./src/cli.js");
  assert.equal(packageJson.exports?.["."], "./src/main.js");
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: expectedGitRepoUrl,
  });
  assert.equal(packageJson.homepage, expectedRepoUrl);
  assert.deepEqual(packageJson.bugs, { url: expectedIssuesUrl });

  for (const [fieldName, value] of [
    ["repository.url", packageJson.repository.url],
    ["homepage", packageJson.homepage],
    ["bugs.url", packageJson.bugs.url],
  ]) {
    assertNoPlaceholderUrl(value, fieldName);
  }

  assert.ok(readme.includes(`git clone ${expectedRepoUrl}.git`));
  assert.match(readme, /https:\/\/www\.npmjs\.com\/package\/agentify/);
  assert.doesNotMatch(readme, /github\.com\/(?:owner|user|your-org|org|example|acme)\//i);
});

test("publish dependencies and workspace metadata are portable", async () => {
  const packageJson = await readPackageJson();

  for (const groupName of dependencyGroups) {
    const dependencies = packageJson[groupName] ?? {};
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === "string") {
        assertPortableDependencySpec(name, spec, groupName);
      }
    }
  }

  const optionalMetadataFiles = ["pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json"];
  for (const relativePath of optionalMetadataFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    const contents = await fs.readFile(absolutePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (contents === null) {
      continue;
    }

    assert.doesNotMatch(contents, /\bagentify:\s*(?:link|file|portal|workspace):/i, `${relativePath} must not pin agentify to a local self-link`);
    assert.doesNotMatch(contents, /(?:link|file|portal):(?:~|\/|[A-Za-z]:[\\/])/i, `${relativePath} must not include machine-local dependency links`);
  }
});

test("npm pack dry-run includes the publishable CLI and documentation surface", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    maxBuffer: 2 * 1024 * 1024,
  });
  const [packResult] = JSON.parse(stdout);
  const packedPaths = new Set(packResult.files.map((file) => file.path));

  assert.equal(packResult.name, "agentify");
  assert.ok(packResult.entryCount > 0, "dry-run pack should produce a non-empty package");

  for (const requiredPath of [
    "package.json",
    "README.md",
    "LICENSE",
    "src/cli.js",
    "src/main.js",
    "docs/usage.md",
    "skills/auto-pilot/SKILL.md",
  ]) {
    assert.ok(packedPaths.has(requiredPath), `published package should include ${requiredPath}`);
  }
});
