import fs from "node:fs/promises";
import path from "node:path";

import { getChangedFiles, getFileContentsAtHead, getHeadCommit } from "./git.js";
import { exists, relative, walkFiles } from "./fs.js";
import { splitLicense, stripLeadingAgentifyHeader } from "./headers.js";
import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { getRepoMeta } from "./db/metadata-store.js";
import { loadModules } from "./db/structural-store.js";
import { listSemanticProjects } from "./db/semantic-store.js";
import { resolveAgentifyPaths } from "./project-store.js";
import { isSemanticEnabled } from "./semantic.js";

const ALLOWED_DOC_PATHS = [
  /(^|\/)AGENTIFY\.md$/,
  /^output\.txt$/,
  /^agentify-report\.html$/,
  /^\.agentify\.yaml$/,
  /^\.agentignore$/,
  /^\.guardrails$/,
  /^\.gitignore$/,
  /^docs\//,
  /^\.agentify\//,
  /^\.codex(\/|$)/,
  /^\.claude(\/|$)/,
  /^\.gemini(\/|$)/,
  /^\.opencode(\/|$)/,
  /^\.current_session(\/|$)/,
];
const ALLOWED_CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|cs|java|kt|kts|swift)$/;

export const FAILURE_CATEGORIES = {
  UNSAFE_PATH: "unsafe-path",
  CODE_BODY_CHANGED: "code-body-changed",
  FRESHNESS_STALE: "freshness-stale",
  INSPECTION_ERROR: "inspection-error",
};

const REMEDIATION_HINTS = {
  [FAILURE_CATEGORIES.UNSAFE_PATH]:
    "Only recognized Agentify paths (.agentify/, docs/, generated AGENTIFY.md files, provider skill dirs, .guardrails, .agentignore, .gitignore) and code files with header-only changes are allowed. Run 'git checkout -- <path>' to revert.",
  [FAILURE_CATEGORIES.CODE_BODY_CHANGED]:
    "Agentify only modifies @agentify headers. If you edited this file intentionally, commit it separately before running agentify.",
  [FAILURE_CATEGORIES.FRESHNESS_STALE]: "Run 'agentify scan' followed by 'agentify doc' to refresh.",
  [FAILURE_CATEGORIES.INSPECTION_ERROR]: "The file may have been deleted or is unreadable. Run 'git status' to verify.",
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

function stripTopAgentifyHeader(source, _filePath, _headerWindow) {
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
  const agentifyPaths = options.artifactPaths || (await resolveAgentifyPaths(targetRoot, options.config || {}));
  const indexPath = agentifyPaths.indexDb;
  if (!(await exists(indexPath))) {
    failures.push(
      createFailure(FAILURE_CATEGORIES.FRESHNESS_STALE, ".agentify/index.db", "missing .agentify/index.db"),
    );
    return;
  }
  const db = openIndexDatabase(agentifyPaths);
  try {
    const meta = getRepoMeta(db);
    const headCommit = await getHeadCommit(root);
    if (meta.head_commit !== headCommit) {
      failures.push(
        createFailure(
          FAILURE_CATEGORIES.FRESHNESS_STALE,
          ".agentify/index.db",
          `stale index head_commit: expected ${headCommit}, found ${meta.head_commit || "unknown"}`,
        ),
      );
    }

    const modules = loadModules(db);
    const moduleDocStates = [];
    for (const moduleInfo of modules) {
      moduleDocStates.push({
        moduleInfo,
        exists: await exists(path.join(targetRoot, moduleInfo.doc_path)),
      });
    }
    const requireModuleDocs =
      options.config?.docs !== false &&
      ((await exists(path.join(targetRoot, "AGENTIFY.md"))) || moduleDocStates.some((state) => state.exists));
    for (const { moduleInfo, exists: docExists } of moduleDocStates) {
      const docPath = moduleInfo.doc_path;
      if (!docExists) {
        if (!requireModuleDocs) {
          continue;
        }
        failures.push(
          createFailure(
            FAILURE_CATEGORIES.FRESHNESS_STALE,
            docPath,
            `indexed module ${moduleInfo.id} is missing generated doc ${docPath}`,
          ),
        );
        continue;
      }
      if (!moduleInfo.fingerprint) {
        failures.push(
          createFailure(
            FAILURE_CATEGORIES.FRESHNESS_STALE,
            docPath,
            `module ${moduleInfo.id} is missing a fingerprint in the DB index`,
          ),
        );
      }
    }

    if (isSemanticEnabled(options.config || {})) {
      const semanticProjects = listSemanticProjects(db);
      for (const projectInfo of semanticProjects) {
        if (projectInfo.status !== "ready") {
          failures.push(
            createFailure(
              FAILURE_CATEGORIES.FRESHNESS_STALE,
              ".agentify/index.db",
              `semantic project ${projectInfo.project_id} is ${projectInfo.status}`,
            ),
          );
        }
        if (Number(projectInfo.coverage_ratio || 0) < 1) {
          failures.push(
            createFailure(
              FAILURE_CATEGORIES.FRESHNESS_STALE,
              ".agentify/index.db",
              `semantic project ${projectInfo.project_id} has partial coverage`,
            ),
          );
        }
      }
    }
  } finally {
    closeIndexDatabase(db);
  }
}

async function validateChangedFiles(root, config, failures, options = {}) {
  const changedFiles = await getChangedFiles(root);
  const codeEntries = [];

  for (const entry of changedFiles) {
    const relPath = entry.path;

    if (entry.status === "D") continue;

    if (!isAllowedPath(relPath)) {
      failures.push(
        createFailure(FAILURE_CATEGORIES.UNSAFE_PATH, relPath, `Changed file outside allowlist: ${relPath}`),
      );
      continue;
    }
    if (!ALLOWED_CODE_EXTENSIONS.test(relPath)) {
      continue;
    }
    codeEntries.push(entry);
  }

  const headContents = await getFileContentsAtHead(
    root,
    codeEntries.map((entry) => entry.path),
  );
  for (const entry of codeEntries) {
    const relPath = entry.path;
    try {
      const after = await fs.readFile(path.join(root, relPath), "utf8");
      const before = headContents.get(relPath);
      const result = validateHeaderOnlyChange(before ?? "", after, relPath, config.headerWindow);
      if (!result.passed && !options.skipCodeBodyChanges) {
        failures.push(
          createFailure(
            FAILURE_CATEGORIES.CODE_BODY_CHANGED,
            relPath,
            `File body changed beyond header region in ${relPath}`,
          ),
        );
      }
    } catch (error) {
      failures.push(
        createFailure(FAILURE_CATEGORIES.INSPECTION_ERROR, relPath, `Unable to read ${relPath}: ${error.message}`),
      );
    }
  }
}

export async function validateRepo(root, config, options = {}) {
  const failures = [];
  if (!options.skipFreshness) {
    await validateFreshness(root, failures, { ...options, config });
  }
  if (!options.skipChangedFiles) {
    await validateChangedFiles(root, config, failures, options);
  }

  const targetRoot = options.artifactRoot || root;
  const allFiles = (await walkFiles(targetRoot, { respectIgnore: true })).map((file) => relative(targetRoot, file));
  const unsafeGeneratedFiles = allFiles
    .filter((file) => file.startsWith(".agentify/") || file.startsWith("docs/"))
    .filter((file) => !isAllowedPath(file));
  for (const file of unsafeGeneratedFiles) {
    failures.push(createFailure(FAILURE_CATEGORIES.UNSAFE_PATH, file, `generated file in unsafe location: ${file}`));
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
