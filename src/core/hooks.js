import fs from "node:fs/promises";
import path from "node:path";
import { exists, writeText } from "./fs.js";

const AGENTIFY_MARKER = "# @agentify";

const PRE_COMMIT_BODY = `${AGENTIFY_MARKER} pre-commit hook
# Validates freshness and generated-artifact safety before commit.
# --hook keeps this guard out of the way of ordinary tracked source edits.
agentify check --hook
`;

const POST_MERGE_BODY = `${AGENTIFY_MARKER} post-merge hook
# Refreshes the repository index after merge
agentify scan --json >/dev/null 2>&1 || true
`;

const HOOK_BODIES = [
  { name: "pre-commit", configKey: "preCommit", body: PRE_COMMIT_BODY },
  { name: "post-merge", configKey: "postMerge", body: POST_MERGE_BODY },
];

function isHookEnabled(settings, configKey) {
  return settings?.[configKey] !== false;
}

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

async function readFileMode(filePath) {
  try {
    return (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return null;
  }
}

async function writeTextPreservingMode(filePath, text) {
  const mode = await readFileMode(filePath);
  await writeText(filePath, text);
  if (mode !== null) {
    await fs.chmod(filePath, mode);
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

async function removeManagedHookBlock(hookPath) {
  const content = await safeRead(hookPath);
  if (!content || !content.includes(AGENTIFY_MARKER)) return false;

  const { remaining } = stripAgentifyBlock(content);
  if (remaining && remaining !== "#!/bin/sh") {
    await writeTextPreservingMode(hookPath, `${remaining}\n`);
  } else {
    await fs.unlink(hookPath).catch(() => {});
  }
  return true;
}

export async function installHooks(root, settings = {}) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) {
    throw new Error(".git/hooks directory not found — is this a git repository?");
  }

  const installed = [];
  const removed = [];

  for (const { name, configKey, body } of HOOK_BODIES) {
    const hookPath = path.join(hooksDir, name);
    if (!isHookEnabled(settings, configKey)) {
      if (await removeManagedHookBlock(hookPath)) {
        removed.push(name);
      }
      continue;
    }

    const existing = await safeRead(hookPath);
    const next = composeHookContent(existing, body);

    if (existing === next) {
      continue;
    }

    await writeText(hookPath, next);
    await fs.chmod(hookPath, 0o755);
    installed.push(name);
  }

  return { installed, removed };
}

export async function removeHooks(root) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) return [];

  const removed = [];
  for (const { name } of HOOK_BODIES) {
    const hookPath = path.join(hooksDir, name);
    const content = await safeRead(hookPath);
    if (!content || !content.includes(AGENTIFY_MARKER)) continue;

    const { remaining } = stripAgentifyBlock(content);
    if (remaining && remaining !== "#!/bin/sh") {
      await writeText(hookPath, `${remaining}\n`);
      await fs.chmod(hookPath, 0o755);
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

export async function syncManagedHooks(root, { dryRun = false, settings = {} } = {}) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) {
    return {
      git_repository: false,
      results: [],
      status: "skipped_not_git_repository",
    };
  }

  const results = [];

  for (const { name, configKey, body } of HOOK_BODIES) {
    const hookPath = path.join(hooksDir, name);
    const existing = await safeRead(hookPath);

    if (!isHookEnabled(settings, configKey)) {
      if (!existing) {
        results.push({ name, path: hookPath, managed: false, status: "skipped_disabled" });
        continue;
      }

      const { hadMarker, remaining } = stripAgentifyBlock(existing);
      if (!hadMarker) {
        results.push({ name, path: hookPath, managed: false, status: "skipped_disabled_unmanaged" });
        continue;
      }

      if (!dryRun) {
        if (remaining && remaining !== "#!/bin/sh") {
          await writeTextPreservingMode(hookPath, `${remaining}\n`);
        } else {
          await fs.unlink(hookPath).catch(() => {});
        }
      }

      results.push({
        name,
        path: hookPath,
        managed: true,
        status: dryRun ? "would_remove_disabled" : "removed_disabled",
      });
      continue;
    }

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

  const changed = results.some((item) =>
    ["updated", "would_update", "removed_disabled", "would_remove_disabled"].includes(item.status)
  );
  return {
    git_repository: true,
    results,
    status: changed ? dryRun ? "would_sync" : "synced" : "unchanged",
  };
}
