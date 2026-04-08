import fs from "node:fs/promises";
import path from "node:path";
import { exists, writeText } from "./fs.js";

const AGENTIFY_MARKER = "# @agentify";

const PRE_COMMIT_BODY = `${AGENTIFY_MARKER} pre-commit hook
# Validates freshness and safety before commit
agentify check
`;

const POST_MERGE_BODY = `${AGENTIFY_MARKER} post-merge hook
# Refreshes index and metadata after merge
agentify scan --json >/dev/null 2>&1 || true
`;

const HOOK_BODIES = [
  ["pre-commit", PRE_COMMIT_BODY],
  ["post-merge", POST_MERGE_BODY],
];

function renderHookScript(body) {
  return `#!/bin/sh\n${body.trimEnd()}\n`;
}

async function safeRead(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function stripAgentifyBlock(content) {
  const lines = String(content || "").split(/\r?\n/);
  const filtered = [];
  let hadMarker = false;
  let inAgentifyBlock = false;

  for (const line of lines) {
    if (line.includes(AGENTIFY_MARKER)) {
      hadMarker = true;
      inAgentifyBlock = true;
      continue;
    }
    if (inAgentifyBlock && (line.startsWith("#") || line.startsWith("agentify ") || line.trim() === "")) {
      continue;
    }
    inAgentifyBlock = false;
    filtered.push(line);
  }

  return {
    hadMarker,
    remaining: filtered.join("\n").trim(),
  };
}

function composeHookContent(existing, body) {
  if (!existing) {
    return renderHookScript(body);
  }

  const { remaining } = stripAgentifyBlock(existing);
  if (!remaining || remaining === "#!/bin/sh") {
    return renderHookScript(body);
  }

  return `${remaining}\n\n${body.trimEnd()}\n`;
}

export async function installHooks(root) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) {
    throw new Error(".git/hooks directory not found — is this a git repository?");
  }

  const installed = [];

  for (const [name, body] of HOOK_BODIES) {
    const hookPath = path.join(hooksDir, name);
    const existing = await safeRead(hookPath);

    if (existing && existing.includes(AGENTIFY_MARKER)) {
      continue;
    }

    await writeText(hookPath, composeHookContent(existing, body));
    await fs.chmod(hookPath, 0o755);
    installed.push(name);
  }

  return installed;
}

export async function removeHooks(root) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) return [];

  const removed = [];
  for (const [name] of HOOK_BODIES) {
    const hookPath = path.join(hooksDir, name);
    const content = await safeRead(hookPath);
    if (!content || !content.includes(AGENTIFY_MARKER)) continue;

    const { remaining } = stripAgentifyBlock(content);
    if (remaining && remaining !== "#!/bin/sh") {
      await writeText(hookPath, `${remaining}\n`);
    } else {
      await fs.unlink(hookPath).catch(() => {});
    }
    removed.push(name);
  }

  return removed;
}

export async function statusHooks(root) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) return { preCommit: false, postMerge: false };

  const preCommit = await safeRead(path.join(hooksDir, "pre-commit"));
  const postMerge = await safeRead(path.join(hooksDir, "post-merge"));

  return {
    preCommit: preCommit?.includes(AGENTIFY_MARKER) || false,
    postMerge: postMerge?.includes(AGENTIFY_MARKER) || false,
  };
}

export async function syncManagedHooks(root, { dryRun = false } = {}) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) {
    return {
      git_repository: false,
      results: [],
      status: "skipped_not_git_repository",
    };
  }

  const results = [];

  for (const [name, body] of HOOK_BODIES) {
    const hookPath = path.join(hooksDir, name);
    const existing = await safeRead(hookPath);
    if (!existing) {
      results.push({ name, path: hookPath, managed: false, status: "skipped_missing" });
      continue;
    }

    const { hadMarker } = stripAgentifyBlock(existing);
    if (!hadMarker) {
      results.push({ name, path: hookPath, managed: false, status: "skipped_unmanaged" });
      continue;
    }

    const next = composeHookContent(existing, body);
    if (existing === next) {
      results.push({ name, path: hookPath, managed: true, status: "unchanged" });
      continue;
    }

    if (!dryRun) {
      await writeText(hookPath, next);
      await fs.chmod(hookPath, 0o755);
    }

    results.push({
      name,
      path: hookPath,
      managed: true,
      status: dryRun ? "would_update" : "updated",
    });
  }

  const changed = results.some((item) => item.status === "updated" || item.status === "would_update");
  return {
    git_repository: true,
    results,
    status: changed ? dryRun ? "would_sync" : "synced" : "unchanged",
  };
}
