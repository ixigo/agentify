import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { exists, readJson, writeJson } from "./fs.js";

const execFileAsync = promisify(execFile);

async function runGit(targetPath, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, ...args]);
    return stdout.trim();
  } catch {
    throw new Error(`${targetPath} is not inside a git worktree`);
  }
}

async function realpathIfPossible(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function resolveGitWorktree(targetPath) {
  const requestedPath = path.resolve(targetPath);
  const topLevel = path.resolve(await runGit(requestedPath, ["rev-parse", "--show-toplevel"]));
  const rawCommonDir = await runGit(requestedPath, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(topLevel, rawCommonDir);

  return {
    root: topLevel,
    gitCommonDir: await realpathIfPossible(gitCommonDir),
  };
}

function createLinkPayload({ canonical, current }) {
  return {
    schema_version: 1,
    kind: "agentify-linked-project",
    canonical_root: canonical.root,
    project_store: path.join(canonical.root, ".agentify"),
    git_common_dir: current.gitCommonDir,
  };
}

function sameLinkPayload(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function linkProject(root, options = {}) {
  const from = String(options.from || "").trim();
  if (!from || from === "true") {
    throw new Error("agentify link requires --from <canonical-worktree>");
  }

  const current = await resolveGitWorktree(root);
  const canonical = await resolveGitWorktree(from);
  if (current.gitCommonDir !== canonical.gitCommonDir) {
    throw new Error("Cannot link unrelated repositories: target and canonical worktree do not share the same git common dir");
  }

  const payload = createLinkPayload({ canonical, current });
  const linkPath = path.join(current.root, ".agentify", "link.json");

  if (!options.dryRun && options.prepareTarget) {
    await options.prepareTarget(current.root);
  }

  if (await exists(linkPath)) {
    const existing = await readJson(linkPath);
    if (sameLinkPayload(existing, payload)) {
      return {
        command: "link",
        root: current.root,
        from: canonical.root,
        link_path: linkPath,
        project_store: payload.project_store,
        git_common_dir: payload.git_common_dir,
        linked: true,
        changed: false,
        dry_run: Boolean(options.dryRun),
      };
    }
  }

  if (!options.dryRun) {
    await writeJson(linkPath, payload);
  }

  return {
    command: "link",
    root: current.root,
    from: canonical.root,
    link_path: linkPath,
    project_store: payload.project_store,
    git_common_dir: payload.git_common_dir,
    linked: true,
    changed: !options.dryRun,
    dry_run: Boolean(options.dryRun),
  };
}
