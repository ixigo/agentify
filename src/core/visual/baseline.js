import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "package.json"];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function resolveBaselineRef(root, ref) {
  const mergeBase = String(ref).match(/^merge-base(?::(.+))?$/);
  if (mergeBase) {
    const base = mergeBase[1] ?? defaultBranch(root);
    return git(["merge-base", "HEAD", base], root);
  }
  return git(["rev-parse", "--verify", `${ref}^{commit}`], root);
}

export function defaultBranch(root) {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root).replace(/^origin\//, "");
  } catch {
    for (const candidate of ["main", "master", "release"]) {
      try {
        git(["rev-parse", "--verify", candidate], root);
        return candidate;
      } catch {}
    }
  }
  throw new Error("Could not find a default branch for merge-base; pass --baseline merge-base:<branch>");
}

export function describeCheckout(root, label, ref) {
  return {
    label,
    ref: ref ?? git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    sha: git(["rev-parse", "--short", "HEAD"], root),
    subject: git(["log", "-1", "--format=%s"], root),
    dirtyFiles: git(["status", "--porcelain", "--", "."], root).split("\n").filter(Boolean).length,
  };
}

function installStamp(repoDir, appDir) {
  const hash = createHash("sha1");
  for (const dir of new Set([repoDir, appDir])) {
    for (const name of LOCKFILES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) hash.update(name).update(fs.readFileSync(file));
    }
  }
  return hash.digest("hex");
}

export function baselineDir(root) {
  return path.join(root, ".agentify", "visual", "baseline");
}

export function ensureBaseline({ root, ref, config, log = () => {}, spawn = spawnSync }) {
  const repoRoot = git(["rev-parse", "--show-toplevel"], root);
  const appRelative = path.relative(repoRoot, root);
  const sha = resolveBaselineRef(root, ref);
  const dir = baselineDir(root);
  const repoDir = path.join(dir, "repo");
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    log(`Creating baseline worktree for ${ref} (${sha.slice(0, 9)})`);
    fs.rmSync(repoDir, { recursive: true, force: true });
    git(["worktree", "add", "--detach", repoDir, sha], root);
  } else if (git(["rev-parse", "HEAD"], repoDir) !== sha) {
    log(`Moving baseline worktree to ${ref} (${sha.slice(0, 9)})`);
    git(["checkout", "--detach", "--force", sha], repoDir);
    const scope = appRelative || ".";
    git(["clean", "-fdq", "--", scope, `:!${path.join(scope, "node_modules")}`], repoDir);
  }

  const appDir = path.join(repoDir, appRelative);
  if (config.install) {
    const stampFile = path.join(dir, "install.stamp");
    const wanted = installStamp(repoDir, appDir);
    const current = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8") : "";
    if (current !== wanted) {
      log(`Installing baseline dependencies: ${config.install.join(" ")}`);
      const result = spawn(config.install[0], config.install.slice(1), {
        cwd: appDir,
        stdio: "inherit",
        env: { ...process.env, CI: "true", LEFTHOOK: "0", HUSKY: "0" },
      });
      if (result.status !== 0) throw new Error(`Baseline install failed: ${config.install.join(" ")}`);
      fs.writeFileSync(stampFile, wanted);
    }
  }

  for (const entry of [path.relative(root, config.file), ...config.baseline.copy]) {
    const source = path.resolve(root, entry);
    if (!fs.existsSync(source)) throw new Error(`baseline.copy entry not found: ${entry}`);
    fs.cpSync(source, path.join(appDir, entry), { recursive: true, force: true });
  }

  return { ref, sha, root: appDir, repoDir, configFile: path.join(appDir, path.relative(root, config.file)) };
}

export function removeBaseline(root) {
  const repoDir = path.join(baselineDir(root), "repo");
  if (!fs.existsSync(repoDir)) return false;
  git(["worktree", "remove", "--force", repoDir], root);
  fs.rmSync(baselineDir(root), { recursive: true, force: true });
  return true;
}
