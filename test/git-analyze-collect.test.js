import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  collectCommits,
  streamCommitRecords,
  parseNumstat,
  createIgnoreMatcher,
} from "../src/core/git-analyze/collect.js";

const execFileAsync = promisify(execFile);

function git(root, args, options = {}) {
  return execFileAsync("git", args, { cwd: root, ...options });
}

// A repository crafted to exercise every tricky path: hostile message bytes, a
// secret (redaction), a rename, a binary file, a lockfile-only (generated)
// commit, a non-conventional subject, a revert pair, and a merge commit.
async function buildFixtureRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-collect-"));
  const msgFile = path.join(os.tmpdir(), `agentify-msg-${process.pid}-${Date.now()}.txt`);

  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Fix Ture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "commit.gpgsign", "false"]);

  // 1: conventional feat with an issue key
  await fs.writeFile(path.join(root, "a.txt"), "hello\nworld\n");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-m", "feat(core): add a (#12)"]);
  const defaultBranch = (await git(root, ["branch", "--show-current"])).stdout.trim();

  // 2: hostile body (quotes, newlines, field-separator + control bytes) and a
  //    secret that must be redacted on the way into the record.
  await fs.writeFile(path.join(root, "b.txt"), "content\n");
  await git(root, ["add", "b.txt"]);
  const hostileBody = [
    'fix: hostile "quotes" here',
    "",
    "body with \x1f field-sep and \x1b escape and 'single' quotes",
    "AWS_SECRET_ACCESS_KEY=abc123hiddenvalue",
    "trailing line",
  ].join("\n");
  await fs.writeFile(msgFile, hostileBody);
  await git(root, ["commit", "-F", msgFile]);

  // 3: rename with an edit (must count once, against the new path)
  await git(root, ["mv", "a.txt", "c.txt"]);
  await fs.writeFile(path.join(root, "c.txt"), "hello\nworld\nmore\n");
  await git(root, ["add", "c.txt"]);
  await git(root, ["commit", "-m", "refactor: rename a to c"]);

  // 4: binary file (numstat reports -/-, 0 lines, tracked separately)
  await fs.writeFile(path.join(root, "img.bin"), Buffer.from([0, 1, 2, 0, 255, 10, 0, 7, 0]));
  await git(root, ["add", "img.bin"]);
  await git(root, ["commit", "-m", "chore: add binary"]);

  // 5: lockfile-only commit (generated path, excluded from file lists)
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages: {}\n");
  await git(root, ["add", "pnpm-lock.yaml"]);
  await git(root, ["commit", "-m", "chore: update lockfile"]);

  // 6 + 7: a revert pair
  await fs.writeFile(path.join(root, "d.txt"), "to be reverted\n");
  await git(root, ["add", "d.txt"]);
  await git(root, ["commit", "-m", "feat: add d"]);
  await git(root, ["revert", "--no-edit", "HEAD"]);

  // 8: non-conventional subject
  await fs.writeFile(path.join(root, "wip.txt"), "scratch\n");
  await git(root, ["add", "wip.txt"]);
  await git(root, ["commit", "-m", "wip"]);

  // 9 + 10: a feature branch and a merge commit
  await git(root, ["checkout", "-q", "-b", "feature"]);
  await fs.writeFile(path.join(root, "e.txt"), "feature work\n");
  await git(root, ["add", "e.txt"]);
  await git(root, ["commit", "-m", "feat: e on feature (#34)"]);
  await git(root, ["checkout", "-q", defaultBranch]);
  await git(root, ["merge", "--no-ff", "-m", "Merge pull request #99 from feature", "feature"]);

  return { root, msgFile };
}

function findBySubject(records, needle) {
  return records.find((record) => record.subject.includes(needle));
}

test("collectCommits builds the frozen record shape and keeps counts deterministic", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  // Merges are never in the counted set; their subjects live separately.
  assert.ok(collection.commits.every((record) => record.isMerge === false));
  assert.equal(collection.merges.length, 1);
  assert.ok(collection.merges[0].subject.includes("Merge pull request #99"));
  assert.equal(collection.merges[0].isMerge, true);

  const feat = findBySubject(collection.commits, "add a (#12)");
  assert.equal(feat.type, "feat");
  assert.equal(feat.scope, "core");
  assert.equal(feat.breaking, false);
  assert.deepEqual(feat.issueKeys, ["#12"]);
  assert.equal(feat.short, feat.sha.slice(0, 7));
  assert.match(feat.authoredAt, /^\d{4}-\d{2}-\d{2}T/);

  // Distinct issue refs count across commits AND merges (#12, #34, #99).
  assert.equal(collection.stats.issueRefs, 3);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits redacts secrets on the way into the record body", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  const hostile = findBySubject(collection.commits, "hostile");
  assert.ok(hostile, "hostile commit record exists");
  assert.match(hostile.body, /\[REDACTED\]/);
  assert.doesNotMatch(hostile.body, /abc123hiddenvalue/);
  // The hostile body must not corrupt the following (rename) record.
  const rename = findBySubject(collection.commits, "rename a to c");
  assert.equal(rename.type, "refactor");
  assert.deepEqual(rename.files, ["c.txt"]);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits counts a rename once against the new path", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  const rename = findBySubject(collection.commits, "rename a to c");
  assert.deepEqual(rename.files, ["c.txt"]);
  assert.equal(rename.filesExcluded, 0);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits counts a binary file with zero lines and tracks it separately", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  const binary = findBySubject(collection.commits, "add binary");
  assert.deepEqual(binary.files, ["img.bin"]);
  assert.equal(binary.insertions, 0);
  assert.equal(binary.deletions, 0);
  assert.ok(collection.stats.binaryFiles >= 1);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits excludes generated paths from file lists but keeps their line counts (auditable)", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  const lockfile = findBySubject(collection.commits, "update lockfile");
  assert.deepEqual(lockfile.files, [], "pnpm-lock.yaml is dropped from the file list");
  assert.equal(lockfile.filesExcluded, 1);
  // Raw line churn still counts the lockfile edit.
  assert.ok(lockfile.insertions > 0);
  assert.ok(collection.stats.filesExcluded >= 1);
  assert.ok(collection.notes.some((note) => /excluded from file lists/i.test(note)));

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits detects a non-conventional subject and a revert pair", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  const wip = findBySubject(collection.commits, "wip");
  assert.equal(wip.type, null);
  assert.equal(wip.scope, null);

  const revert = collection.commits.find((record) => record.isRevert);
  assert.ok(revert, "a revert commit is present");
  assert.match(revert.subject, /^Revert "feat: add d"/);
  assert.match(revert.revertOf, /^[0-9a-f]{7,40}$/);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits reports a cap instead of silently truncating", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root, { maxCommits: 2 });

  assert.equal(collection.commits.length, 2);
  assert.equal(collection.truncated.commits, true);
  assert.ok(collection.notes.some((note) => /capped at 2/.test(note)));

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits reads the branch table via for-each-ref", async () => {
  const { root, msgFile } = await buildFixtureRepo();
  const collection = await collectCommits(root);

  assert.ok(collection.branches.length >= 2);
  const feature = collection.branches.find((branch) => branch.name === "feature");
  assert.ok(feature, "the feature branch is listed");
  assert.match(feature.tip, /^[0-9a-f]{40}$/);
  assert.equal(feature.tipShort, feature.tip.slice(0, 7));
  assert.match(feature.committerDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof feature.hasUpstream, "boolean");

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("streamCommitRecords yields records incrementally, before the process exits", async () => {
  const { root, msgFile } = await buildFixtureRepo();

  const generator = streamCommitRecords(root, { merges: false });
  const first = await generator.next();
  assert.equal(first.done, false);
  assert.match(first.value.sha, /^[0-9a-f]{40}$/);
  // Abandon the stream early: the generator's cleanup must kill the child.
  await generator.return();

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(msgFile, { force: true });
});

test("collectCommits on a repo with no commits degrades to an empty result with a note", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-git-empty-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Fix Ture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);

  const collection = await collectCommits(root);
  assert.equal(collection.commits.length, 0);
  assert.equal(collection.merges.length, 0);
  assert.ok(collection.notes.some((note) => /No commit history/i.test(note)));

  await fs.rm(root, { recursive: true, force: true });
});

test("parseNumstat handles normal, binary, and rename entries", () => {
  // Normal + rename (empty path, then two NUL path tokens) + binary.
  const rest = "\n5\t2\tsrc/a.js\0" + "3\t1\t\0old/b.js\0new/b.js\0" + "-\t-\timg.png\0";
  const result = parseNumstat(rest);
  assert.equal(result.insertions, 8);
  assert.equal(result.deletions, 3);
  assert.deepEqual(result.files, ["src/a.js", "new/b.js", "img.png"]);
  assert.equal(result.binaryFiles, 1);
  assert.deepEqual(result.excludedFiles, []);
});

test("createIgnoreMatcher matches the default generated patterns", () => {
  const matcher = createIgnoreMatcher(["pnpm-lock.yaml", "dist/", "*.min.*", ".agentify/work/**"]);
  assert.equal(matcher("pnpm-lock.yaml"), true);
  assert.equal(matcher("packages/app/pnpm-lock.yaml"), true);
  assert.equal(matcher("dist/index.js"), true);
  assert.equal(matcher("app.min.js"), true);
  assert.equal(matcher(".agentify/work/tmp/x.json"), true);
  assert.equal(matcher("src/index.js"), false);
  assert.equal(matcher("distinct/thing.js"), false);
});
