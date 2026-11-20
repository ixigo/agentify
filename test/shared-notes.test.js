import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { addNote, clearContext, contextStatus, listDecisions, loadContextSnapshot, matchContext, renderContextDigest, trackEvent } from "../src/core/ctx.js";
import { buildMcpTools } from "../src/core/mcp-server.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args]);
}

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await git(root, "config", "user.name", "Agentify Tests");
  await git(root, "config", "user.email", "agentify-tests@example.com");
  await git(root, "commit", "--allow-empty", "-m", "init");
}

async function mkTempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function addWorktree(mainRoot, branch, dir) {
  await git(mainRoot, "worktree", "add", "-b", branch, dir);
}

function noteTexts(snapshot) {
  return snapshot.notes.map((note) => note.note);
}

async function ctxLoadViaMcp(root) {
  const tools = buildMcpTools(root, {});
  const ctxLoad = tools.find((tool) => tool.name === "ctx_load");
  return ctxLoad.handler();
}

test("a note written in a worktree is visible in the main checkout and siblings", async () => {
  const parent = await mkTempDir("agentify-shared-main-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wtA = path.join(parent, "wt-a");
    const wtB = path.join(parent, "wt-b");
    await addWorktree(main, "feat-a", wtA);
    await addWorktree(main, "feat-b", wtB);

    await addNote(wtA, "shared: retry backoff handling was rewritten this week", { session: "sa" });

    // Visible in the main checkout and the sibling worktree.
    assert.deepEqual(noteTexts(await loadContextSnapshot(main)), ["shared: retry backoff handling was rewritten this week"]);
    assert.deepEqual(noteTexts(await loadContextSnapshot(wtB)), ["shared: retry backoff handling was rewritten this week"]);

    // Visible to ctx match and the MCP ctx_load tool in the main checkout.
    const matched = await matchContext(main, "retry backoff handling rewrite", { recordInjection: false });
    assert.match(matched.digest || "", /retry backoff/);
    assert.match(await ctxLoadViaMcp(main), /retry backoff/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("removing a worktree loses no notes, and the originating branch is recorded", async () => {
  const parent = await mkTempDir("agentify-shared-remove-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feature-x", wt);

    const result = await addNote(wt, "note from the throwaway worktree", { session: "sx" });
    assert.equal(result.record.branch, "feature-x");

    await git(main, "worktree", "remove", "--force", wt);
    await assert.rejects(fs.access(wt));

    const snapshot = await loadContextSnapshot(main);
    assert.deepEqual(noteTexts(snapshot), ["note from the throwaway worktree"]);
    assert.equal(snapshot.notes[0].branch, "feature-x");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("decisions are repo-scoped across worktrees too", async () => {
  const parent = await mkTempDir("agentify-shared-decision-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feat-dec", wt);

    await addNote(wt, "chose sqlite over json because of concurrent writes", { type: "decision", session: "sd" });
    const listed = await listDecisions(main, "sqlite");
    assert.equal(listed.decisions.length, 1);
    assert.match(listed.decisions[0].note, /chose sqlite/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("staleness honours a note's branch: same-branch flagged, other-branch is provenance, legacy flagged", async () => {
  const parent = await mkTempDir("agentify-shared-provenance-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    // A real directory exists so a missing file under it is "confirmed missing"
    // (an absent first segment would not be flagged for an unrelated reason).
    await fs.mkdir(path.join(main, "src/core"), { recursive: true });
    await fs.writeFile(path.join(main, "src/core/keep.ts"), "export {}\n", "utf8");
    const { stdout } = await git(main, "branch", "--show-current");
    const currentBranch = stdout.trim();

    const notesPath = path.join(main, ".agentify", "context", "notes.jsonl");
    await fs.mkdir(path.dirname(notesPath), { recursive: true });
    await fs.writeFile(notesPath, [
      JSON.stringify({ ts: "2026-02-01T00:00:00.000Z", branch: currentBranch, note: "same branch: logic moved to src/core/gone-a.ts" }),
      JSON.stringify({ ts: "2026-02-02T00:00:00.000Z", branch: "feature-elsewhere", note: "other branch: logic in src/core/gone-b.ts" }),
      JSON.stringify({ ts: "2026-02-03T00:00:00.000Z", note: "legacy: logic in src/core/gone-c.ts" }),
    ].join("\n") + "\n", "utf8");

    const snapshot = await loadContextSnapshot(main);
    const byText = (needle) => snapshot.notes.find((note) => note.note.includes(needle));

    assert.deepEqual(byText("gone-a.ts").stale_refs, ["src/core/gone-a.ts"], "same-branch missing path is flagged");
    assert.equal(byText("gone-b.ts").stale_refs, undefined, "other-branch missing path is not flagged");
    assert.equal(byText("gone-b.ts").cross_branch, "feature-elsewhere", "other-branch note carries provenance");
    assert.deepEqual(byText("gone-c.ts").stale_refs, ["src/core/gone-c.ts"], "legacy note (no branch) is flagged");

    const digest = renderContextDigest(snapshot);
    assert.match(digest, /\(written on feature-elsewhere\)/);
    assert.ok(!/gone-b\.ts[^\n]*STALE/.test(digest), "other-branch note shows no STALE warning");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a note written on a linked worktree's branch is provenance, not stale, in the main checkout", async () => {
  const parent = await mkTempDir("agentify-shared-prov-wt-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    await fs.mkdir(path.join(main, "src"), { recursive: true });
    await fs.writeFile(path.join(main, "src/keep.ts"), "export {}\n", "utf8");
    await git(main, "add", "-A");
    await git(main, "commit", "-m", "add src");
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feat-prov", wt);

    // Written on feat-prov, referencing a file that exists on neither checkout.
    const added = await addNote(wt, "the retry helper now lives in src/moved-helper.ts", { session: "sw" });
    assert.equal(added.record.branch, "feat-prov");

    // Same branch (the worktree) → flagged; src/ exists in the checkout.
    const wtNote = (await loadContextSnapshot(wt)).notes.find((n) => n.note.includes("moved-helper.ts"));
    assert.deepEqual(wtNote.stale_refs, ["src/moved-helper.ts"]);

    // Other branch (main) → provenance, not stale, even though src/ exists here too.
    const mainNote = (await loadContextSnapshot(main)).notes.find((n) => n.note.includes("moved-helper.ts"));
    assert.equal(mainNote.stale_refs, undefined);
    assert.equal(mainNote.cross_branch, "feat-prov");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a note superseded from a linked worktree is hidden in the main checkout", async () => {
  const parent = await mkTempDir("agentify-shared-supersede-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feat-sup", wt);

    // A note recorded in the main checkout...
    const stale = await addNote(main, "the webhook retry uses the old fixed 30s backoff", { session: "sm" });
    // ...superseded from a linked worktree (notes are shared on this branch).
    const fresh = await addNote(wt, "the webhook retry now uses exponential backoff with jitter", {
      session: "sw",
      supersedes: stale.record.id,
    });
    assert.equal(fresh.record.supersedes, stale.record.id);

    // The superseded note is gone from the main checkout's injected digest...
    assert.deepEqual(noteTexts(await loadContextSnapshot(main)), ["the webhook retry now uses exponential backoff with jitter"]);
    // ...and from the sibling worktree, and from ctx match.
    assert.deepEqual(noteTexts(await loadContextSnapshot(wt)), ["the webhook retry now uses exponential backoff with jitter"]);
    const matched = await matchContext(main, "fix the webhook retry backoff", { recordInjection: false });
    assert.ok(!/fixed 30s backoff/.test(matched.digest || ""), "superseded note not injected in main");

    // It is still inspectable with --all, marked by what superseded it.
    const all = await loadContextSnapshot(main, { includeSuperseded: true });
    const hidden = all.notes.find((note) => note.id === stale.record.id);
    assert.ok(hidden && hidden.superseded_by.id === fresh.record.id);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("existing per-worktree notes migrate into the shared store once, de-duplicated", async () => {
  const parent = await mkTempDir("agentify-shared-migrate-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "legacy", wt);

    // A note already recorded in the main store before notes were repo-scoped.
    const mainNotes = path.join(main, ".agentify", "context", "notes.jsonl");
    await fs.mkdir(path.dirname(mainNotes), { recursive: true });
    await fs.writeFile(mainNotes, JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", note: "legacy main note" }) + "\n", "utf8");

    // A legacy local notes.jsonl inside the linked worktree: one new line plus a
    // duplicate of the main note.
    const wtNotes = path.join(wt, ".agentify", "context", "notes.jsonl");
    await fs.mkdir(path.dirname(wtNotes), { recursive: true });
    await fs.writeFile(wtNotes, [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", note: "legacy main note" }),
      JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", note: "legacy worktree note" }),
    ].join("\n") + "\n", "utf8");

    // First read in the worktree triggers the migration.
    const snapshot = await loadContextSnapshot(wt);
    assert.deepEqual(noteTexts(snapshot).sort(), ["legacy main note", "legacy worktree note"]);

    // The local file was renamed so the migration is idempotent.
    await assert.rejects(fs.access(wtNotes));
    await fs.access(`${wtNotes}.migrated`);

    // Shared store has exactly the two unique notes (duplicate collapsed).
    const sharedLines = (await fs.readFile(mainNotes, "utf8")).trim().split("\n");
    assert.equal(sharedLines.length, 2);

    // A second read does not re-add anything.
    await loadContextSnapshot(wt);
    const afterLines = (await fs.readFile(mainNotes, "utf8")).trim().split("\n");
    assert.equal(afterLines.length, 2);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("concurrent appends from parallel worktrees do not corrupt or lose notes", async () => {
  const parent = await mkTempDir("agentify-shared-concurrent-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const roots = [main];
    for (let i = 0; i < 3; i += 1) {
      const wt = path.join(parent, `wt-${i}`);
      await addWorktree(main, `branch-${i}`, wt);
      roots.push(wt);
    }

    const writes = [];
    for (const root of roots) {
      for (let n = 0; n < 8; n += 1) {
        writes.push(addNote(root, `note ${path.basename(root)} #${n}`, { session: "c" }));
      }
    }
    await Promise.all(writes);

    const sharedNotes = path.join(main, ".agentify", "context", "notes.jsonl");
    const lines = (await fs.readFile(sharedNotes, "utf8")).trim().split("\n");
    assert.equal(lines.length, roots.length * 8);
    // Every line is valid JSON — no interleaved/corrupt writes.
    for (const line of lines) {
      JSON.parse(line);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a non-git directory keeps notes in its own local store", async () => {
  const root = await mkTempDir("agentify-shared-nongit-");
  try {
    const result = await addNote(root, "local-only note", { session: "n" });
    assert.equal(result.path, path.join(root, ".agentify", "context", "notes.jsonl"));
    assert.equal(result.record.branch, undefined);

    // Events still write per-checkout regardless.
    await trackEvent(root, {
      session_id: "n",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "a.js" },
      tool_response: {},
    });
    const snapshot = await loadContextSnapshot(root);
    assert.deepEqual(noteTexts(snapshot), ["local-only note"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a subproject note in the main checkout stays local and never migrates", async () => {
  const main = await mkTempDir("agentify-shared-subhome-");
  try {
    await initGitRepo(main);
    const sub = path.join(main, "native-food-ordering");
    await fs.mkdir(sub, { recursive: true });

    const result = await addNote(sub, "subproject note");
    // Writes to the subproject's own store, not the repo-root store.
    assert.equal(result.path, path.join(sub, ".agentify", "context", "notes.jsonl"));
    assert.deepEqual(noteTexts(await loadContextSnapshot(sub)), ["subproject note"]);

    // No migration happened: no .migrated file, and the repo-root store has no notes.
    await assert.rejects(fs.access(path.join(sub, ".agentify", "context", "notes.jsonl.migrated")));
    await assert.rejects(fs.access(path.join(main, ".agentify", "context", "notes.jsonl")));
  } finally {
    await fs.rm(main, { recursive: true, force: true });
  }
});

test("a subproject note in a linked worktree shares with the same subproject in main", async () => {
  const parent = await mkTempDir("agentify-shared-subwt-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feat-sub", wt);

    const subInWt = path.join(wt, "native-food-ordering");
    await fs.mkdir(subInWt, { recursive: true });
    await addNote(subInWt, "subproject note from a worktree", { session: "s" });

    // Visible at the SAME subproject path in the main checkout...
    const subInMain = path.join(main, "native-food-ordering");
    assert.deepEqual(noteTexts(await loadContextSnapshot(subInMain)), ["subproject note from a worktree"]);
    // ...and NOT redirected into the repo-root store.
    await assert.rejects(fs.access(path.join(main, ".agentify", "context", "notes.jsonl")));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a bare repo with worktrees falls back to the per-checkout local store", async () => {
  const parent = await mkTempDir("agentify-shared-bare-");
  try {
    const seed = path.join(parent, "seed");
    await fs.mkdir(seed, { recursive: true });
    await initGitRepo(seed);
    const bare = path.join(parent, "bare.git");
    await execFileAsync("git", ["clone", "--quiet", "--bare", seed, bare]);
    const wt = path.join(parent, "wt1");
    await git(bare, "worktree", "add", "--quiet", "-b", "wt1branch", wt, "HEAD");

    const result = await addNote(wt, "note in a bare-repo worktree", { session: "b" });
    // Must stay inside the worktree, never dirname(common-dir) = the parent dir.
    assert.equal(result.path, path.join(wt, ".agentify", "context", "notes.jsonl"));
    await assert.rejects(fs.access(path.join(parent, ".agentify", "context", "notes.jsonl")));
    await assert.rejects(fs.access(path.join(bare, "context", "notes.jsonl")));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a submodule keeps notes in its own working tree, not under .git/modules", async () => {
  const parent = await mkTempDir("agentify-shared-submodule-");
  try {
    const sup = path.join(parent, "super");
    const subRepo = path.join(parent, "subrepo");
    await fs.mkdir(sup, { recursive: true });
    await fs.mkdir(subRepo, { recursive: true });
    await initGitRepo(sup);
    await initGitRepo(subRepo);
    await execFileAsync("git", ["-C", sup, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", subRepo, "libs/sub"]);

    const subWorking = path.join(sup, "libs", "sub");
    const result = await addNote(subWorking, "note inside a submodule", { session: "m" });
    assert.equal(result.path, path.join(subWorking, ".agentify", "context", "notes.jsonl"));
    assert.deepEqual(noteTexts(await loadContextSnapshot(subWorking)), ["note inside a submodule"]);
    // Never written into the superproject's .git/modules store.
    await assert.rejects(fs.access(path.join(sup, ".git", "modules", "libs", "sub", ".agentify")));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("ctx clear in a linked worktree preserves the shared notes", async () => {
  const parent = await mkTempDir("agentify-shared-clear-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feat-clear", wt);

    await addNote(wt, "shared note survives clear", { session: "c" });
    await trackEvent(wt, {
      session_id: "c",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "x.js" },
      tool_response: {},
    });

    const cleared = await clearContext(wt, { archive: false });
    assert.equal(cleared.shared_notes_preserved, true);
    // Per-checkout events are gone, but the shared note is still there everywhere.
    assert.equal((await loadContextSnapshot(wt)).summary.eventCount, 0);
    assert.deepEqual(noteTexts(await loadContextSnapshot(main)), ["shared note survives clear"]);

    // Clearing from the MAIN worktree does clear the shared notes.
    const clearedMain = await clearContext(main, { archive: false });
    assert.equal(clearedMain.shared_notes_preserved, false);
    assert.deepEqual(noteTexts(await loadContextSnapshot(main)), []);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("migration leaves the local file in place when the merge fails, and .migrated is not counted", async () => {
  const parent = await mkTempDir("agentify-shared-migfail-");
  try {
    const main = path.join(parent, "main");
    await fs.mkdir(main, { recursive: true });
    await initGitRepo(main);
    const wt = path.join(parent, "wt");
    await addWorktree(main, "feat-mig", wt);

    // Local legacy notes in the worktree.
    const wtNotes = path.join(wt, ".agentify", "context", "notes.jsonl");
    await fs.mkdir(path.dirname(wtNotes), { recursive: true });
    await fs.writeFile(wtNotes, JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", note: "legacy" }) + "\n", "utf8");

    // Make the shared store un-writable by putting a FILE where the context
    // directory should be, so the migration's append fails (but reads still
    // return empty rather than throwing).
    const sharedContext = path.join(main, ".agentify", "context");
    await fs.mkdir(path.join(main, ".agentify"), { recursive: true });
    await fs.writeFile(sharedContext, "not a directory", "utf8");

    await loadContextSnapshot(wt); // triggers migration, which must fail cleanly
    // Local file is preserved (not renamed) for a later retry.
    await fs.access(wtNotes);
    await assert.rejects(fs.access(`${wtNotes}.migrated`));

    // ctx status never counts a notes.jsonl.migrated file.
    await fs.rm(sharedContext, { recursive: true, force: true });
    const sharedNotes = path.join(sharedContext, "notes.jsonl");
    await fs.mkdir(sharedContext, { recursive: true });
    await fs.writeFile(sharedNotes, JSON.stringify({ ts: "2026-02-01T00:00:00.000Z", note: "real" }) + "\n", "utf8");
    await fs.writeFile(`${sharedNotes}.migrated`, [
      JSON.stringify({ ts: "2026-02-02T00:00:00.000Z", note: "old a" }),
      JSON.stringify({ ts: "2026-02-03T00:00:00.000Z", note: "old b" }),
    ].join("\n") + "\n", "utf8");
    const status = await contextStatus(main);
    assert.equal(status.note_count, 1);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
