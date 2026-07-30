import fs from "node:fs/promises";
import path from "node:path";

import { writeText } from "./fs.js";

export const AGENTIFY_GITIGNORE_START = "# >>> agentify generated artifacts";
export const AGENTIFY_GITIGNORE_END = "# <<< agentify generated artifacts";

const AGENTIFY_GENERATED_PROJECT_PATTERNS = [
  "plans/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-*.html",
  ".current_session/",
  "AGENTIFY.md",
  "docs/repo-map.md",
  "docs/modules/",
  "output.txt",
  "agentify-report.html",
  "agentify-value-report.html",
  "agentify-session-analysis.html",
];

export const AGENTIFY_GITIGNORE_PATTERNS = [
  ".agentify/",
  ...AGENTIFY_GENERATED_PROJECT_PATTERNS,
];

// Shared-context mode: everything under .agentify/ stays local except
// context/notes.jsonl, which is committed as team memory. Gitignore cannot
// re-include a file whose parent directory is excluded, hence the ladder.
export const AGENTIFY_SHARED_GITIGNORE_PATTERNS = [
  ".agentify/*",
  "!.agentify/context",
  ".agentify/context/*",
  "!.agentify/context/notes.jsonl",
  ...AGENTIFY_GENERATED_PROJECT_PATTERNS,
];

export const SHARED_NOTES_MARKER = "!.agentify/context/notes.jsonl";

const LEGACY_AGENTIFY_GITIGNORE_PATTERNS = [
  ".agents/",
  ".agentify/work/",
  "# Local/runtime Agentify output. Commit .agentify.yaml, .agentignore, and .guardrails when you want repo-shared policy.",
  "# Agentify-generated files stay local. CLAUDE.md, AGENTS.md, and this .gitignore remain visible to Git.",
];

const AGENTIFY_GITIGNORE_HEADER =
  "# New Agentify-owned files stay local. CLAUDE.md, AGENTS.md, and this .gitignore remain visible to Git.";

function getManagedGitignoreLines({ shared = false } = {}) {
  return [
    AGENTIFY_GITIGNORE_HEADER,
    ...(shared ? AGENTIFY_SHARED_GITIGNORE_PATTERNS : AGENTIFY_GITIGNORE_PATTERNS),
  ];
}

export function hasSharedNotesGitignore(text) {
  return String(text || "").includes(SHARED_NOTES_MARKER);
}

export function renderAgentifyGitignoreBlock(preservedLines = [], { shared = false } = {}) {
  return [
    AGENTIFY_GITIGNORE_START,
    ...getManagedGitignoreLines({ shared }),
    ...preservedLines,
    AGENTIFY_GITIGNORE_END,
    "",
  ].join("\n");
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function collectPreservedBlockLines(blockText) {
  const managedLines = new Set([
    ...getManagedGitignoreLines({ shared: false }),
    ...getManagedGitignoreLines({ shared: true }),
    ...LEGACY_AGENTIFY_GITIGNORE_PATTERNS,
  ].map((line) => line.trim()));
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

function mergeAdditionalPatterns(preservedLines, additionalPatterns = []) {
  const seen = new Set(preservedLines.map((line) => line.trim()).filter(Boolean));
  const merged = [...preservedLines];
  for (const pattern of additionalPatterns) {
    const normalized = String(pattern || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function applyAgentifyGitignoreBlock(existingText, { shared, additionalPatterns = [] } = {}) {
  const normalized = normalizeText(existingText || "");
  const startIndex = normalized.indexOf(AGENTIFY_GITIGNORE_START);
  const endIndex = normalized.indexOf(AGENTIFY_GITIGNORE_END);
  // Preserve the current mode unless the caller explicitly switches it.
  const effectiveShared = shared === undefined ? hasSharedNotesGitignore(normalized) : shared;

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    const afterEnd = endIndex + AGENTIFY_GITIGNORE_END.length;
    const blockText = normalized.slice(startIndex + AGENTIFY_GITIGNORE_START.length, endIndex);
    const preserved = mergeAdditionalPatterns(collectPreservedBlockLines(blockText), additionalPatterns);
    const block = renderAgentifyGitignoreBlock(preserved, { shared: effectiveShared });
    const nextText = `${normalized.slice(0, startIndex)}${block}${normalized.slice(afterEnd).replace(/^\n+/, "")}`;
    return nextText.endsWith("\n") ? nextText : `${nextText}\n`;
  }

  const block = renderAgentifyGitignoreBlock(
    mergeAdditionalPatterns([], additionalPatterns),
    { shared: effectiveShared },
  );
  const prefix = normalized.trimEnd();
  if (!prefix) {
    return block;
  }
  return `${prefix}\n\n${block}`;
}

export async function ensureAgentifyGitignore(root, {
  dryRun = false,
  shared,
  additionalPatterns = [],
} = {}) {
  const gitignorePath = path.join(root, ".gitignore");
  let existing = null;

  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const next = applyAgentifyGitignoreBlock(existing || "", { shared, additionalPatterns });
  const changed = existing === null || normalizeText(existing) !== next;

  if (changed && !dryRun) {
    await writeText(gitignorePath, next);
  }

  return {
    path: gitignorePath,
    existed: existing !== null,
    shared: hasSharedNotesGitignore(next),
    changed,
    status: existing === null
      ? dryRun ? "would_create" : "created"
      : changed
        ? dryRun ? "would_update" : "updated"
        : "unchanged",
  };
}
