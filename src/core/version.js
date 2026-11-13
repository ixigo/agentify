import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

// The published package version. This is the baseline identity; the running
// commit (when it differs from a release tag) is appended as build metadata.
export const VERSION = pkg.version;

// The installed package root (two levels up from src/core/). Git lookups, the
// install.sh build-info file, and package.json gitHead are all resolved here.
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const BUILD_INFO_FILE = ".agentify-build-info.json";
const SHORT_SHA_LEN = 7;
const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const LS_REMOTE_TIMEOUT_MS = 10_000;

function semverParts(value) {
  const match = SEMVER_TAG.exec(String(value || "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function stripV(value) {
  const parts = semverParts(value);
  return parts ? parts.join(".") : null;
}

function shortSha(sha) {
  const hex = String(sha || "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(hex) ? hex.slice(0, SHORT_SHA_LEN) : null;
}

// Compare two X.Y.Z strings (an optional leading v is ignored). Returns a
// negative, zero, or positive number, so e.g. v0.9.0 sorts below v0.10.0.
export function compareSemver(a, b) {
  const pa = semverParts(a) || [0, 0, 0];
  const pb = semverParts(b) || [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// Parse `git describe --tags --always --long --dirty --abbrev=7` output into a
// structured source. Returns null when git produced nothing (not a checkout).
export function parseGitDescribe(desc) {
  if (desc == null) return null;
  let value = String(desc).trim();
  if (value === "") return null;

  const dirty = value.endsWith("-dirty");
  if (dirty) value = value.slice(0, -"-dirty".length);

  // <tag>-<distance>-g<sha>: distance 0 means HEAD is exactly on the tag.
  const long = /^(.+)-(\d+)-g([0-9a-f]{4,40})$/.exec(value);
  if (long) {
    const distance = Number(long[2]);
    return {
      exactTag: distance === 0 ? long[1] : null,
      shortSha: long[3].slice(0, SHORT_SHA_LEN),
      dirty,
    };
  }

  // No tags in history: `--always` falls back to a bare abbreviated sha.
  const bare = /^([0-9a-f]{4,40})$/.exec(value);
  if (bare) {
    return { exactTag: null, shortSha: bare[1].slice(0, SHORT_SHA_LEN), dirty };
  }

  // A tag with no commit suffix (unexpected with --long, handled defensively).
  return { exactTag: value, shortSha: null, dirty };
}

// Shape the version string from whatever identity sources are available. Pure
// over its inputs so it can be unit-tested without git, a filesystem, or a real
// global install. Precedence: git checkout, install.sh build-info, npm gitHead.
export function shapeVersion({ version = VERSION, git = null, buildInfo = null, gitHead = null } = {}) {
  const v = version;

  if (git) {
    if (git.exactTag && !git.dirty && stripV(git.exactTag) === v) return v;
    if (git.shortSha) return `${v}+${git.shortSha}`;
  }

  if (buildInfo) {
    if (buildInfo.ref && stripV(buildInfo.ref) === v) return v;
    const sha = shortSha(buildInfo.commit);
    if (sha) return `${v}+${sha}`;
  }

  const head = shortSha(gitHead);
  if (head) return `${v}+${head}`;

  return v;
}

function defaultRunGitDescribe(root) {
  // Only a checkout of agentify itself counts. Without this guard git walks up
  // from an installed package and reports the commit of whatever repository
  // happens to contain the global prefix (a dotfiles repo in $HOME, say).
  if (!existsSync(path.join(root, ".git"))) {
    return null;
  }
  try {
    return execFileSync(
      "git",
      ["-C", root, "describe", "--tags", "--always", "--long", "--dirty", "--abbrev=7"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
  } catch {
    return null;
  }
}

function readBuildInfo(root) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, BUILD_INFO_FILE), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        ref: typeof parsed.ref === "string" ? parsed.ref : null,
        commit: typeof parsed.commit === "string" ? parsed.commit : null,
      };
    }
  } catch {
    // No build-info file (a git checkout or a bare npm/registry install).
  }
  return null;
}

function readGitHead(root) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof parsed.gitHead === "string" ? parsed.gitHead : null;
  } catch {
    return null;
  }
}

// Resolve the display version for `--version`. Runs at most one git subprocess
// and two small file reads, and only on the version path — never on a hot CLI
// start. Every source is overridable so tests inject them instead of touching
// git, disk, or the network.
export function resolveVersionString(options = {}) {
  const root = options.root || PACKAGE_ROOT;
  const version = options.version || VERSION;
  const runGitDescribe = options.runGitDescribe || defaultRunGitDescribe;
  const git = options.git !== undefined ? options.git : parseGitDescribe(runGitDescribe(root));
  const buildInfo = options.buildInfo !== undefined ? options.buildInfo : readBuildInfo(root);
  const gitHead = options.gitHead !== undefined ? options.gitHead : readGitHead(root);
  return shapeVersion({ version, git, buildInfo, gitHead });
}

// Pick the highest vX.Y.Z tag from `git ls-remote --tags` output. Non-release
// tags and peeled `^{}` refs of annotated tags are ignored.
export function pickLatestReleaseTag(lsRemoteOutput) {
  const candidates = [];
  for (const line of String(lsRemoteOutput || "").split("\n")) {
    const match = /\brefs\/tags\/(\S+)$/.exec(line.trim());
    if (!match) continue;
    const ref = match[1];
    if (ref.endsWith("^{}")) continue;
    const parts = semverParts(ref);
    if (!parts) continue;
    candidates.push({ tag: ref, parts });
  }
  candidates.sort((a, b) => compareSemver(b.tag, a.tag) || b.tag.localeCompare(a.tag));
  return candidates.length ? candidates[0].tag : null;
}

// The git URL to query for release tags. Honors AGENTIFY_REPO (the same
// override install.sh uses) and otherwise reads it from package.json.
export function repoUrlFromPackage(env = process.env) {
  const configured = String(env.AGENTIFY_REPO || "").trim();
  if (configured) return `https://github.com/${configured}.git`;
  const url = String(pkg.repository?.url || "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  return url ? `${url}.git` : "";
}

function defaultRunLsRemote(repoUrl) {
  return execFileSync("git", ["ls-remote", "--tags", repoUrl], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: LS_REMOTE_TIMEOUT_MS,
  });
}

// The only Agentify code path that touches the network, and only when the user
// explicitly runs `agentify version --check`. Resolves the latest release tag
// over `git ls-remote` (no GitHub API, no token) and compares it to the
// installed version. Never throws: a failed lookup reports status "unknown".
export function checkForUpdate(options = {}) {
  const installed = options.version || VERSION;
  const repoUrl = options.repoUrl || repoUrlFromPackage(options.env || process.env);
  const runLsRemote = options.runLsRemote || defaultRunLsRemote;

  let output;
  try {
    output = runLsRemote(repoUrl);
  } catch {
    return { installed, latest: null, status: "unknown", ok: false, repo: repoUrl };
  }

  const latest = pickLatestReleaseTag(output);
  if (!latest) {
    return { installed, latest: null, status: "no_releases", ok: true, repo: repoUrl };
  }

  const status = compareSemver(installed, latest) >= 0 ? "up_to_date" : "behind";
  return { installed, latest, status, ok: true, repo: repoUrl };
}
