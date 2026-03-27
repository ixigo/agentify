import fs from "node:fs/promises";
import path from "node:path";

import { getChangedFiles, getFileContentAtHead, getHeadCommit } from "./git.js";
import { exists, readJson, relative, walkFiles } from "./fs.js";

const ALLOWED_DOC_PATHS = [/^AGENTS\.md$/, /^AGENTIFY\.md$/, /^output\.txt$/, /^agentify-report\.html$/, /^docs\//, /^\.agents\//];

function isAllowedPath(filePath) {
  return ALLOWED_DOC_PATHS.some((pattern) => pattern.test(filePath)) || /\.(ts|tsx|js|jsx|py|cs)$/.test(filePath);
}

function classifyCommentLine(line, filePath) {
  const trimmed = line.trim();
  if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
    return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/") || trimmed === "";
  }
  if (filePath.endsWith(".py")) {
    return trimmed.startsWith("#") || trimmed.startsWith('"""') || trimmed.endsWith('"""') || trimmed === "";
  }
  if (filePath.endsWith(".cs")) {
    return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/") || trimmed.startsWith("///") || trimmed === "";
  }
  return false;
}

function stripTopAgentifyHeader(source, filePath, headerWindow) {
  const lines = source.split(/\r?\n/);
  const windowText = lines.slice(0, headerWindow).join("\n");

  if (/\.(ts|tsx|js|jsx|cs)$/.test(filePath)) {
    const match = windowText.match(/^(#!.*\n)?(?:\/\*[\s\S]*?@agentify[\s\S]*?\*\/\n\n?)/);
    if (match) {
      return source.slice(match[0].length);
    }
  }

  if (filePath.endsWith(".py")) {
    const match = windowText.match(/^(#!.*\n)?(?:"""@agentify[\s\S]*?"""\n\n?)/);
    if (match) {
      return source.slice(match[0].length);
    }
  }

  return source;
}

export function validateHeaderOnlyChange(before, after, filePath, headerWindow = 80) {
  const normalizedBefore = stripTopAgentifyHeader(before, filePath, headerWindow);
  const normalizedAfter = stripTopAgentifyHeader(after, filePath, headerWindow);
  if (normalizedBefore !== normalizedAfter) {
    return { passed: false, reason: "file body changed beyond allowed header region" };
  }

  return { passed: true };
}

async function validateFreshness(root, failures) {
  const indexPath = path.join(root, ".agents", "index.json");
  if (!(await exists(indexPath))) {
    failures.push("missing .agents/index.json");
    return;
  }
  const index = await readJson(indexPath);
  const headCommit = await getHeadCommit(root);
  if (index.index.head_commit !== headCommit) {
    failures.push(`stale index head_commit: expected ${headCommit}, found ${index.index.head_commit}`);
  }

  for (const moduleInfo of index.modules) {
    if (!(await exists(path.join(root, moduleInfo.doc_path)))) {
      failures.push(`missing module doc for ${moduleInfo.id}`);
    }
    if (!(await exists(path.join(root, moduleInfo.metadata_path)))) {
      failures.push(`missing module metadata for ${moduleInfo.id}`);
      continue;
    }
    const metadata = await readJson(path.join(root, moduleInfo.metadata_path));
    if (metadata.freshness?.last_indexed_commit !== headCommit) {
      failures.push(`stale module metadata for ${moduleInfo.id}`);
    }
  }
}

async function validateChangedFiles(root, config, failures) {
  const changedFiles = await getChangedFiles(root);
  for (const file of changedFiles) {
    const relPath = file.split(path.sep).join("/");
    if (!isAllowedPath(relPath)) {
      failures.push(`unsafe changed path: ${relPath}`);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|py|cs)$/.test(relPath)) {
      continue;
    }

    try {
      const after = await fs.readFile(path.join(root, relPath), "utf8");
      const before = await getFileContentAtHead(root, relPath);
      const result = validateHeaderOnlyChange(before ?? "", after, relPath, config.headerWindow);
      if (!result.passed) {
        failures.push(`unsafe code change in ${relPath}: ${result.reason}`);
      }
    } catch (error) {
      failures.push(`unable to inspect changed code file ${relPath}: ${error.message}`);
    }
  }
}

export async function validateRepo(root, config) {
  const failures = [];
  await validateFreshness(root, failures);
  await validateChangedFiles(root, config, failures);

  const allFiles = (await walkFiles(root)).map((file) => relative(root, file));
  const unsafeGeneratedFiles = allFiles.filter((file) => file.startsWith(".agents/") || file.startsWith("docs/") || file === "AGENTS.md").filter((file) => !isAllowedPath(file));
  for (const file of unsafeGeneratedFiles) {
    failures.push(`generated file in unsafe location: ${file}`);
  }

  return {
    passed: failures.length === 0,
    failures
  };
}
