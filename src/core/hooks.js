import fs from "node:fs/promises";
import path from "node:path";
import { exists } from "./fs.js";

const AGENTIFY_MARKER = "# @agentify";

const PRE_COMMIT_TEMPLATE = `#!/bin/sh
${AGENTIFY_MARKER} pre-commit hook
# Validates freshness and safety before commit
agentify check
`;

const POST_MERGE_TEMPLATE = `#!/bin/sh
${AGENTIFY_MARKER} post-merge hook
# Refreshes index and metadata after merge
agentify scan --skip-finalize 2>/dev/null || true
`;

async function safeRead(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function installHooks(root) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) {
    throw new Error(".git/hooks directory not found — is this a git repository?");
  }

  const installed = [];
  const hooks = [
    ["pre-commit", PRE_COMMIT_TEMPLATE],
    ["post-merge", POST_MERGE_TEMPLATE],
  ];

  for (const [name, template] of hooks) {
    const hookPath = path.join(hooksDir, name);
    const existing = await safeRead(hookPath);

    if (existing && existing.includes(AGENTIFY_MARKER)) {
      continue;
    }

    if (existing) {
      await fs.writeFile(hookPath, `${existing}\n\n${template}`, "utf8");
    } else {
      await fs.writeFile(hookPath, template, "utf8");
    }
    await fs.chmod(hookPath, 0o755);
    installed.push(name);
  }

  return installed;
}

export async function removeHooks(root) {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!(await exists(hooksDir))) return [];

  const removed = [];
  for (const name of ["pre-commit", "post-merge"]) {
    const hookPath = path.join(hooksDir, name);
    const content = await safeRead(hookPath);
    if (!content || !content.includes(AGENTIFY_MARKER)) continue;

    const lines = content.split(/\r?\n/);
    const filtered = [];
    let inAgentifyBlock = false;

    for (const line of lines) {
      if (line.includes(AGENTIFY_MARKER)) {
        inAgentifyBlock = true;
        continue;
      }
      if (inAgentifyBlock && (line.startsWith("#") || line.startsWith("agentify ") || line.trim() === "")) {
        continue;
      }
      inAgentifyBlock = false;
      filtered.push(line);
    }

    const remaining = filtered.join("\n").trim();
    if (remaining && remaining !== "#!/bin/sh") {
      await fs.writeFile(hookPath, `${remaining}\n`, "utf8");
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
