import fs from "node:fs/promises";
import path from "node:path";

import { writeText } from "./fs.js";

export const AGENTIFY_GITIGNORE_START = "# >>> agentify generated artifacts";
export const AGENTIFY_GITIGNORE_END = "# <<< agentify generated artifacts";

export const AGENTIFY_GITIGNORE_PATTERNS = [
  ".agentify/",
  ".current_session/",
  "AGENTIFY.md",
  "docs/repo-map.md",
  "docs/modules/",
  "output.txt",
  "agentify-report.html",
];

const LEGACY_AGENTIFY_GITIGNORE_PATTERNS = [".agents/", ".agentify/work/"];

const AGENTIFY_GITIGNORE_HEADER =
  "# Local/runtime Agentify output. Commit .agentify.yaml, .agentignore, and .guardrails when you want repo-shared policy.";

function getManagedGitignoreLines() {
  return [AGENTIFY_GITIGNORE_HEADER, ...AGENTIFY_GITIGNORE_PATTERNS];
}

export function renderAgentifyGitignoreBlock(preservedLines = []) {
  return [AGENTIFY_GITIGNORE_START, ...getManagedGitignoreLines(), ...preservedLines, AGENTIFY_GITIGNORE_END, ""].join(
    "\n",
  );
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function collectPreservedBlockLines(blockText) {
  const managedLines = new Set(
    [...getManagedGitignoreLines(), ...LEGACY_AGENTIFY_GITIGNORE_PATTERNS].map((line) => line.trim()),
  );
  const seen = new Set();
  const preserved = [];

  for (const line of String(blockText || "").split(/\n/)) {
    const normalized = line.trim();
    if (!normalized || managedLines.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    preserved.push(line);
  }

  return preserved;
}

function applyAgentifyGitignoreBlock(existingText) {
  const normalized = normalizeText(existingText || "");
  const startIndex = normalized.indexOf(AGENTIFY_GITIGNORE_START);
  const endIndex = normalized.indexOf(AGENTIFY_GITIGNORE_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    const afterEnd = endIndex + AGENTIFY_GITIGNORE_END.length;
    const blockText = normalized.slice(startIndex + AGENTIFY_GITIGNORE_START.length, endIndex);
    const block = renderAgentifyGitignoreBlock(collectPreservedBlockLines(blockText));
    const nextText = `${normalized.slice(0, startIndex)}${block}${normalized.slice(afterEnd).replace(/^\n+/, "")}`;
    return nextText.endsWith("\n") ? nextText : `${nextText}\n`;
  }

  const block = renderAgentifyGitignoreBlock();
  const prefix = normalized.trimEnd();
  if (!prefix) {
    return block;
  }
  return `${prefix}\n\n${block}`;
}

export async function ensureAgentifyGitignore(root, { dryRun = false } = {}) {
  const gitignorePath = path.join(root, ".gitignore");
  let existing = null;

  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const next = applyAgentifyGitignoreBlock(existing || "");
  const changed = existing === null || normalizeText(existing) !== next;

  if (changed && !dryRun) {
    await writeText(gitignorePath, next);
  }

  return {
    path: gitignorePath,
    existed: existing !== null,
    changed,
    status:
      existing === null
        ? dryRun
          ? "would_create"
          : "created"
        : changed
          ? dryRun
            ? "would_update"
            : "updated"
          : "unchanged",
  };
}
