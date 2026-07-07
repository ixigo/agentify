import { getHeadCommit } from "./git.js";
import { exists, relative, walkFiles } from "./fs.js";
import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { getRepoMeta } from "./db/metadata-store.js";
import { resolveAgentifyPaths } from "./project-store.js";

const ALLOWED_GENERATED_PATHS = [
  /^\.agentify\.yaml$/,
  /^\.agentignore$/,
  /^\.guardrails$/,
  /^\.gitignore$/,
  /^CLAUDE\.md$/,
  /^docs\//,
  /^\.agentify\//,
  /^\.codex(\/|$)/,
  /^\.claude(\/|$)/,
  /^\.gemini(\/|$)/,
  /^\.opencode(\/|$)/,
  /^\.current_session(\/|$)/,
];

export const FAILURE_CATEGORIES = {
  UNSAFE_PATH: "unsafe-path",
  FRESHNESS_STALE: "freshness-stale",
};

const REMEDIATION_HINTS = {
  [FAILURE_CATEGORIES.UNSAFE_PATH]:
    "Only recognized Agentify paths (.agentify/, docs/, provider skill dirs, .guardrails, .agentignore, .gitignore) are expected. Move or remove the file.",
  [FAILURE_CATEGORIES.FRESHNESS_STALE]:
    "Run 'agentify scan' to refresh the index.",
};

function createFailure(category, filePath, message) {
  return {
    category,
    path: filePath,
    message,
    remediation: REMEDIATION_HINTS[category] || "",
  };
}

function isAllowedGeneratedPath(filePath) {
  return ALLOWED_GENERATED_PATHS.some((pattern) => pattern.test(filePath));
}

async function validateFreshness(root, failures, options = {}) {
  const targetRoot = options.artifactRoot || root;
  const agentifyPaths = options.artifactPaths || await resolveAgentifyPaths(targetRoot, options.config || {});
  const indexPath = agentifyPaths.indexDb;
  if (!(await exists(indexPath))) {
    failures.push(
      createFailure(
        FAILURE_CATEGORIES.FRESHNESS_STALE,
        ".agentify/index.db",
        "missing .agentify/index.db"
      )
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
          `stale index head_commit: expected ${headCommit}, found ${meta.head_commit || "unknown"}`
        )
      );
    }
  } finally {
    closeIndexDatabase(db);
  }
}

export async function validateRepo(root, config, options = {}) {
  const failures = [];
  if (!options.skipFreshness) {
    await validateFreshness(root, failures, { ...options, config });
  }

  const targetRoot = options.artifactRoot || root;
  const allFiles = (await walkFiles(targetRoot, { respectIgnore: true })).map((file) => relative(targetRoot, file));
  const unsafeGeneratedFiles = allFiles
    .filter((file) => file.startsWith(".agentify/") || file.startsWith("docs/repo-map"))
    .filter((file) => !isAllowedGeneratedPath(file));
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
