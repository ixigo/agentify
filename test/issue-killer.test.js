import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runIssueKiller } from "../src/core/issue-killer.js";

const execFileAsync = promisify(execFile);

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function initGitRepo(root) {
  await fs.writeFile(path.join(root, "README.md"), "# test\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function withFakePath(root, testBody) {
  const bin = path.join(root, "bin");
  const tmuxLog = path.join(root, "tmux.log");
  const originalPath = process.env.PATH;

  await writeExecutable(path.join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ nameWithOwner: "acme/widgets" }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  console.log(JSON.stringify([
    { number: 101, title: "Fix login redirect", url: "https://github.com/acme/widgets/issues/101", state: "OPEN", labels: [{ name: "agentify-ready" }] },
    { number: 102, title: "Add billing retry", url: "https://github.com/acme/widgets/issues/102", state: "OPEN", labels: [{ name: "agentify-ready" }] }
  ]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const number = Number(String(args[2]).match(/issues\\/(\\d+)/)?.[1] || 999);
  console.log(JSON.stringify({ number, title: "Explicit issue", url: args[2], state: "OPEN", labels: [] }));
  process.exit(0);
}
console.error("unexpected gh args", args.join(" "));
process.exit(2);
`);

  await writeExecutable(path.join(bin, "wt"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const root = args[args.indexOf("-C") + 1];
const branch = args[args.length - 1];
const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
const target = path.join(path.dirname(root), path.basename(root) + "-wt-" + safe);
const result = spawnSync("git", ["-C", root, "worktree", "add", "-b", branch, target, "HEAD"], { stdio: "inherit" });
process.exit(result.status || 0);
`);

  await writeExecutable(path.join(bin, "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "has-session") process.exit(1);
fs.appendFileSync(${JSON.stringify(tmuxLog)}, args.join("\\u0000") + "\\n");
process.exit(0);
`);

  await writeExecutable(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");

  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  try {
    return await testBody({ bin, tmuxLog });
  } finally {
    process.env.PATH = originalPath;
  }
}

async function withQuietConsole(testBody) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await testBody();
  } finally {
    console.log = originalLog;
  }
}

test("issue-killer dry-run selects opt-in GitHub labelled issues", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-issue-killer-dry-"));
  await initGitRepo(root);

  await withFakePath(root, async () => {
    const result = await withQuietConsole(() =>
      runIssueKiller(root, { provider: "codex", dryRun: true, json: true }, {
        label: "agentify-ready",
        limit: 2,
        allowPartial: false,
      })
    );

    assert.equal(result.dry_run, true);
    assert.equal(result.issue_provider, "github");
    assert.equal(result.agent_provider, "codex");
    assert.equal(result.assignments.length, 2);
    assert.equal(result.assignments[0].branch, "issue/101-fix-login-redirect");
    assert.equal(result.assignments[0].worktree_path, null);
  });
});

test("issue-killer creates Worktrunk worktrees and tmux panes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-issue-killer-live-"));
  await initGitRepo(root);

  await withFakePath(root, async ({ tmuxLog }) => {
    const result = await withQuietConsole(() =>
      runIssueKiller(root, { provider: "codex", dryRun: false, json: true }, {
        label: "agentify-ready",
        limit: 2,
      })
    );

    assert.equal(result.assignments.length, 2);
    assert.ok(result.assignments[0].worktree_path.endsWith("wt-issue-101-fix-login-redirect"));
    assert.ok(result.assignments[1].worktree_path.endsWith("wt-issue-102-add-billing-retry"));
    assert.match(result.assignments[0].pane_command, /^'codex' '--cd'/);
    assert.match(result.assignments[0].pane_command, /gh pr create --draft/);

    const tmuxCalls = await fs.readFile(tmuxLog, "utf8");
    assert.match(tmuxCalls, /new-session/);
    assert.match(tmuxCalls, /split-window/);
    assert.match(tmuxCalls, /select-layout/);
  });
});

test("issue-killer explicit URLs default limit to URL count", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-issue-killer-url-"));
  await initGitRepo(root);

  await withFakePath(root, async () => {
    const result = await withQuietConsole(() =>
      runIssueKiller(root, { provider: "claude", dryRun: true, json: true }, {
        issueUrl: "https://github.com/acme/widgets/issues/333",
      })
    );

    assert.equal(result.agent_provider, "claude");
    assert.equal(result.assignments.length, 1);
    assert.equal(result.assignments[0].issue.number, 333);
    assert.equal(result.assignments[0].branch, "issue/333-explicit-issue");
  });
});

test("issue-killer rejects unsupported issue providers before preflight", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-issue-killer-provider-"));
  await assert.rejects(
    () => runIssueKiller(root, { provider: "codex" }, { issueProvider: "gitlab", label: "agentify-ready" }),
    /not supported in v1/,
  );
});

test("issue-killer requires opt-in label or explicit issue URLs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-issue-killer-selection-"));
  await assert.rejects(
    () => runIssueKiller(root, { provider: "codex" }, { label: "", issueUrl: "" }),
    /requires --label/,
  );
});
