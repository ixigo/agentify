import fs from "node:fs/promises";
import path from "node:path";

import { getChangedFiles, getFileContentAtHead, getHeadCommit } from "./git.js";
import { exists, readJson, relative, walkFiles } from "./fs.js";
import { splitLicense, stripLeadingAgentifyHeader } from "./headers.js";

const ALLOWED_DOC_PATHS = [/^AGENTS\.md$/, /^AGENTIFY\.md$/, /^output\.txt$/, /^agentify-report\.html$/, /^docs\//, /^\.agents\//];
const ALLOWED_CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|cs|java|kt|kts|swift)$/;

function isAllowedPath(filePath) {
  return ALLOWED_DOC_PATHS.some((pattern) => pattern.test(filePath)) || ALLOWED_CODE_EXTENSIONS.test(filePath);
}

function classifyCommentLine(line, filePath) {
  const trimmed = line.trim();
  if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
    return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/") || trimmed === "";
  }
  if (filePath.endsWith(".py")) {
    return trimmed.startsWith("#") || trimmed.startsWith('"""') || trimmed.endsWith('"""') || trimmed === "";
  }
  if (/\.(cs|java|kt|kts|swift)$/.test(filePath)) {
    return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/") || trimmed.startsWith("///") || trimmed === "";
  }
  return false;
}

function stripTopAgentifyHeader(source, filePath, headerWindow) {
  const shebangMatch = source.match(/^#!.*\r?\n/);
  const shebang = shebangMatch ? shebangMatch[0] : "";
  const body = shebang ? source.slice(shebang.length) : source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const { prefix, rest } = splitLicense(body, eol);
  return `${shebang}${prefix}${stripLeadingAgentifyHeader(rest)}`;
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
    if (!ALLOWED_CODE_EXTENSIONS.test(relPath)) {
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
