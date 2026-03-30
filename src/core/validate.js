import fs from "node:fs/promises";
import path from "node:path";

import { getChangedFiles, getFileContentAtHead, getHeadCommit } from "./git.js";
import { exists, readJson, relative, walkFiles } from "./fs.js";
import { splitLicense, stripLeadingAgentifyHeader } from "./headers.js";

const ALLOWED_DOC_PATHS = [/^AGENTS\.md$/, /^AGENTIFY\.md$/, /^output\.txt$/, /^agentify-report\.html$/, /^docs\//, /^\.agents\//];
const ALLOWED_CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|cs|java|kt|kts|swift)$/;

export const FAILURE_CATEGORIES = {
  UNSAFE_PATH: "unsafe-path",
  CODE_BODY_CHANGED: "code-body-changed",
  FRESHNESS_STALE: "freshness-stale",
  INSPECTION_ERROR: "inspection-error",
};

const REMEDIATION_HINTS = {
  [FAILURE_CATEGORIES.UNSAFE_PATH]:
    "Only doc paths (.agents/, docs/, AGENTS.md) and code files with header-only changes are allowed. Run 'git checkout -- <path>' to revert.",
  [FAILURE_CATEGORIES.CODE_BODY_CHANGED]:
    "Agentify only modifies @agentify headers. If you edited this file intentionally, commit it separately before running agentify.",
  [FAILURE_CATEGORIES.FRESHNESS_STALE]:
    "Run 'agentify scan' followed by 'agentify doc' to refresh.",
  [FAILURE_CATEGORIES.INSPECTION_ERROR]:
    "The file may have been deleted or is unreadable. Run 'git status' to verify.",
};

function createFailure(category, filePath, message) {
  return {
    category,
    path: filePath,
    message,
    remediation: REMEDIATION_HINTS[category] || "",
  };
}

function isAllowedPath(filePath) {
  return ALLOWED_DOC_PATHS.some((pattern) => pattern.test(filePath)) || ALLOWED_CODE_EXTENSIONS.test(filePath);
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

async function validateFreshness(root, failures, options = {}) {
  const targetRoot = options.artifactRoot || root;
  const indexPath = path.join(targetRoot, ".agents", "index.json");
  if (!(await exists(indexPath))) {
    failures.push(
      createFailure(
        FAILURE_CATEGORIES.FRESHNESS_STALE,
        ".agents/index.json",
        "missing .agents/index.json"
      )
    );
    return;
  }
  const index = await readJson(indexPath);
  const headCommit = await getHeadCommit(root);
  if (index.index.head_commit !== headCommit) {
    failures.push(
      createFailure(
        FAILURE_CATEGORIES.FRESHNESS_STALE,
        ".agents/index.json",
        `stale index head_commit: expected ${headCommit}, found ${index.index.head_commit}`
      )
    );
  }

  for (const moduleInfo of index.modules) {
    if (!(await exists(path.join(targetRoot, moduleInfo.doc_path)))) {
      failures.push(
        createFailure(
          FAILURE_CATEGORIES.FRESHNESS_STALE,
          moduleInfo.doc_path,
          `missing module doc for ${moduleInfo.id}`
        )
      );
    }
    if (!(await exists(path.join(targetRoot, moduleInfo.metadata_path)))) {
      failures.push(
        createFailure(
          FAILURE_CATEGORIES.FRESHNESS_STALE,
          moduleInfo.metadata_path,
          `missing module metadata for ${moduleInfo.id}`
        )
      );
      continue;
    }
    const metadata = await readJson(path.join(targetRoot, moduleInfo.metadata_path));
    if (metadata.freshness?.last_indexed_commit !== headCommit) {
      failures.push(
        createFailure(
          FAILURE_CATEGORIES.FRESHNESS_STALE,
          moduleInfo.metadata_path,
          `stale module metadata for ${moduleInfo.id}`
        )
      );
    }
  }
}

async function validateChangedFiles(root, config, failures) {
  const changedFiles = await getChangedFiles(root);
  for (const entry of changedFiles) {
    const relPath = entry.path;

    if (entry.status === "D") continue;

    if (!isAllowedPath(relPath)) {
      failures.push(
        createFailure(
          FAILURE_CATEGORIES.UNSAFE_PATH,
          relPath,
          `Changed file outside allowlist: ${relPath}`
        )
      );
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
        failures.push(
          createFailure(
            FAILURE_CATEGORIES.CODE_BODY_CHANGED,
            relPath,
            `File body changed beyond header region in ${relPath}`
          )
        );
      }
    } catch (error) {
      failures.push(
        createFailure(
          FAILURE_CATEGORIES.INSPECTION_ERROR,
          relPath,
          `Unable to read ${relPath}: ${error.message}`
        )
      );
    }
  }
}

export async function validateRepo(root, config, options = {}) {
  const failures = [];
  await validateFreshness(root, failures, options);
  await validateChangedFiles(root, config, failures);

  const targetRoot = options.artifactRoot || root;
  const allFiles = (await walkFiles(targetRoot)).map((file) => relative(targetRoot, file));
  const unsafeGeneratedFiles = allFiles
    .filter((file) => file.startsWith(".agents/") || file.startsWith("docs/") || file === "AGENTS.md")
    .filter((file) => !isAllowedPath(file));
  for (const file of unsafeGeneratedFiles) {
    failures.push(
      createFailure(
        FAILURE_CATEGORIES.UNSAFE_PATH,
        file,
        `generated file in unsafe location: ${file}`
      )
    );
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
