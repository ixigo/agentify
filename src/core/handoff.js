import fs from "node:fs/promises";
import path from "node:path";

import { buildExecutionPlan } from "./planner.js";
import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadSymbols } from "./db/structural-store.js";
import { ensurePrivateDir, exists, readJson, relative, writePrivateJson, writePrivateText } from "./fs.js";
import { getChangedFiles, getChangedFilesSince, getHeadCommit } from "./git.js";
import { resolveAgentifyPaths } from "./project-store.js";
import { getSessionArtifactPaths } from "./session-memory.js";
import { listSessions, resumeSession } from "./session.js";
import { normalizePath } from "./utils/paths.js";

const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_SYMBOLS = 12;
const MAX_TOUCHED_SYMBOLS_PER_FILE = 12;
const MAX_RISKS = 12;
const RECENT_SESSION_LIMIT = 8;

function uniqueSorted(items) {
  return Array.from(new Set(items.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function byPathThenLine(left, right) {
  return left.file_path.localeCompare(right.file_path) || left.start_line - right.start_line || left.name.localeCompare(right.name);
}

function normalizeChangedEntry(entry) {
  return {
    status: entry.status || "?",
    path: normalizePath(entry.path),
    orig_path: entry.origPath ? normalizePath(entry.origPath) : null,
  };
}

async function collectTouchedFiles(root, manifest) {
  const byPath = new Map();
  const add = (entry, source) => {
    const normalized = normalizeChangedEntry(entry);
    if (!normalized.path) {
      return;
    }
    const previous = byPath.get(normalized.path);
    const previousSources = Array.isArray(previous?.source)
      ? previous.source
      : previous?.source
        ? [previous.source]
        : [];
    byPath.set(normalized.path, {
      ...normalized,
      source: previous ? uniqueSorted([...previousSources, source]) : source,
    });
  };

  if (manifest.head_commit_at_creation && manifest.head_commit_at_creation !== "nogit") {
    for (const entry of await getChangedFilesSince(root, manifest.head_commit_at_creation)) {
      add(entry, "session-base-diff");
    }
  }

  for (const entry of await getChangedFiles(root)) {
    add(entry, "working-tree");
  }

  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function summarizePlan(plan) {
  if (!plan) {
    return {
      confidence: 0,
      modules: [],
      files: [],
      symbols: [],
    };
  }

  return {
    confidence: plan.confidence,
    modules: plan.selected_modules.map((item) => ({
      id: item.id,
      root_path: item.root_path,
      score: item.score,
      reasons: (item.reasons || []).map((reason) => reason.reason).slice(0, 3),
    })),
    files: plan.selected_files.slice(0, MAX_CONTEXT_FILES).map((item) => ({
      path: item.path,
      module_id: item.module_id,
      score: item.score,
      reasons: (item.reasons || []).map((reason) => reason.reason).slice(0, 3),
    })),
    symbols: plan.selected_symbols.slice(0, MAX_CONTEXT_SYMBOLS).map((item) => ({
      name: item.name,
      kind: item.kind,
      file_path: item.file_path,
      start_line: item.start_line,
      end_line: item.end_line,
      score: item.score,
      source: item.source || "structural",
    })),
  };
}

function summarizeTests(plan) {
  if (!plan) {
    return { files: [], commands: [] };
  }
  return {
    files: plan.related_tests.map((item) => ({
      file_path: item.file_path,
      related_path: item.related_path || null,
      framework: item.framework || null,
    })),
    commands: plan.verification_commands.map((item) => ({
      command: item.command,
      args: item.args || [],
      command_type: item.command_type || null,
      module_id: item.module_id || null,
    })),
  };
}

async function loadTouchedSymbolNeighborhood(root, touchedFiles, agentifyPaths) {
  if (touchedFiles.length === 0 || !(await exists(agentifyPaths.indexDb))) {
    return [];
  }

  const touched = new Set(touchedFiles.map((item) => item.path));
  const db = openIndexDatabase(agentifyPaths, { readOnly: true });
  try {
    const symbolsByFile = new Map();
    for (const symbolInfo of loadSymbols(db).filter((item) => touched.has(item.file_path)).sort(byPathThenLine)) {
      if (!symbolsByFile.has(symbolInfo.file_path)) {
        symbolsByFile.set(symbolInfo.file_path, []);
      }
      symbolsByFile.get(symbolInfo.file_path).push({
        name: symbolInfo.name,
        kind: symbolInfo.kind,
        module_id: symbolInfo.module_id || null,
        exported: Boolean(symbolInfo.exported),
        start_line: symbolInfo.start_line,
        end_line: symbolInfo.end_line,
      });
    }

    return Array.from(symbolsByFile.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, symbols]) => ({
        file_path: filePath,
        symbols: symbols.slice(0, MAX_TOUCHED_SYMBOLS_PER_FILE),
        omitted_symbols: Math.max(0, symbols.length - MAX_TOUCHED_SYMBOLS_PER_FILE),
      }));
  } finally {
    closeIndexDatabase(db);
  }
}

async function scanRisks(root, filePaths) {
  const risks = [];
  const paths = uniqueSorted(filePaths).slice(0, 32);
  const riskPattern = /\b(TODO|FIXME|XXX|HACK|BUG|RISK)\b[:\s-]*(.*)$/i;

  for (const filePath of paths) {
    const absolutePath = path.join(root, filePath);
    let content = "";
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(riskPattern);
      if (!match) {
        continue;
      }
      risks.push({
        file_path: filePath,
        line: index + 1,
        tag: match[1].toUpperCase(),
        text: match[2].trim().slice(0, 180) || lines[index].trim().slice(0, 180),
      });
      if (risks.length >= MAX_RISKS) {
        return risks;
      }
    }
  }

  return risks;
}

function extractTouchedPathsFromBundle(bundle) {
  const touched = Array.isArray(bundle?.touched_files) ? bundle.touched_files : [];
  return uniqueSorted(touched.map((item) => typeof item === "string" ? item : item?.path));
}

async function loadSessionTouchedPaths(root, sessionId) {
  const paths = getSessionArtifactPaths(root, sessionId);
  if (await exists(paths.handoffJsonPath)) {
    try {
      return extractTouchedPathsFromBundle(await readJson(paths.handoffJsonPath));
    } catch {
      return [];
    }
  }
  return [];
}

async function collectConflictHints(root, sessionId, touchedFiles) {
  const touchedPaths = new Set(touchedFiles.map((item) => item.path));
  if (touchedPaths.size === 0) {
    return [];
  }

  const hints = [];
  const sessions = (await listSessions(root))
    .filter((session) => session.session_id !== sessionId)
    .slice(0, RECENT_SESSION_LIMIT);

  for (const session of sessions) {
    const otherTouchedPaths = await loadSessionTouchedPaths(root, session.session_id);
    const overlap = otherTouchedPaths.filter((filePath) => touchedPaths.has(filePath));
    if (overlap.length === 0) {
      continue;
    }

    hints.push({
      session_id: session.session_id,
      created_at: session.created_at || null,
      name: session.name || null,
      severity: overlap.length >= 3 ? "high" : "medium",
      overlap_files: overlap,
      handoff_path: `.agentify/session/${session.session_id}/handoff.json`,
    });
  }

  return hints;
}

function renderCommand(commandInfo) {
  return [commandInfo.command, ...(commandInfo.args || [])].join(" ").trim();
}

function buildNextActions(bundle) {
  const actions = [];
  actions.push(`Continue: ${bundle.task}`);
  if (bundle.conflict_hints.length > 0) {
    actions.push("Review conflict hints before editing overlapping files.");
  }
  if (bundle.top_ranked_context.files.length > 0) {
    actions.push(`Start with ${bundle.top_ranked_context.files.slice(0, 3).map((item) => item.path).join(", ")}.`);
  }
  if (bundle.unresolved_risks.length > 0) {
    actions.push(`Resolve or explicitly defer ${bundle.unresolved_risks.length} TODO/risk item(s).`);
  }
  if (bundle.recommended_tests.commands.length > 0) {
    actions.push(`Run ${renderCommand(bundle.recommended_tests.commands[0])}.`);
  } else if (bundle.recommended_tests.files.length > 0) {
    actions.push(`Run tests covering ${bundle.recommended_tests.files.slice(0, 3).map((item) => item.file_path).join(", ")}.`);
  }
  return actions;
}

function renderHandoffMarkdown(bundle) {
  const contextFiles = bundle.top_ranked_context.files.length > 0
    ? bundle.top_ranked_context.files.map((item) => `- ${item.path}${item.reasons.length > 0 ? ` (${item.reasons.join("; ")})` : ""}`).join("\n")
    : "- none";
  const touched = bundle.touched_files.length > 0
    ? bundle.touched_files.map((item) => `- ${item.path} [${item.status}; ${Array.isArray(item.source) ? item.source.join(", ") : item.source}]`).join("\n")
    : "- none";
  const symbols = bundle.touched_symbol_neighborhood.length > 0
    ? bundle.touched_symbol_neighborhood.flatMap((fileInfo) => [
      `- ${fileInfo.file_path}`,
      ...fileInfo.symbols.map((symbol) => `  - ${symbol.name} (${symbol.kind}) lines ${symbol.start_line}-${symbol.end_line}`),
    ]).join("\n")
    : "- none";
  const tests = bundle.recommended_tests.commands.length > 0
    ? bundle.recommended_tests.commands.map((item) => `- ${renderCommand(item)}`).join("\n")
    : bundle.recommended_tests.files.map((item) => `- ${item.file_path}`).join("\n") || "- none";
  const risks = bundle.unresolved_risks.length > 0
    ? bundle.unresolved_risks.map((item) => `- ${item.file_path}:${item.line} ${item.tag} ${item.text}`.trim()).join("\n")
    : "- none";
  const conflicts = bundle.conflict_hints.length > 0
    ? bundle.conflict_hints.map((item) => `- ${item.severity}: ${item.session_id} overlaps ${item.overlap_files.join(", ")}`).join("\n")
    : "- none";

  return `# Agentify Handoff

## Session
- ID: ${bundle.session_id}
- Parent: ${bundle.parent_id || "none"}
- Provider: ${bundle.provider}
- Task: ${bundle.task}
- HEAD: ${bundle.current_head}

## Next Actions
${bundle.next_actions.map((item) => `- ${item}`).join("\n")}

## Top-Ranked Context
- Confidence: ${bundle.top_ranked_context.confidence}
${contextFiles}

## Touched Files
${touched}

## Touched Symbol Neighborhood
${symbols}

## Recommended Tests
${tests}

## Unresolved Risks and TODOs
${risks}

## Conflict Hints
${conflicts}
`;
}

export async function buildHandoffBundle(root, config, sessionId, task = "") {
  const session = await resumeSession(root, sessionId);
  const manifest = session.manifest;
  const resolvedTask = String(task || "").trim()
    || manifest.name
    || session.context?.run_history?.at?.(-1)?.task
    || "Continue this session from the latest repository state.";
  const touchedFiles = await collectTouchedFiles(root, manifest);
  const currentHead = await getHeadCommit(root);
  const agentifyPaths = config._agentifyPaths || await resolveAgentifyPaths(root, config);
  let plan = null;
  const planWarnings = [];

  try {
    plan = await buildExecutionPlan(root, config, resolvedTask);
  } catch (error) {
    planWarnings.push(`Planner context unavailable: ${error.message}`);
  }

  const selectedRiskPaths = plan?.selected_files?.map((item) => item.path) || [];
  const touchedSymbolNeighborhood = await loadTouchedSymbolNeighborhood(root, touchedFiles, agentifyPaths);
  const bundle = {
    schema_version: "1.0",
    bundle_type: "agentify-handoff",
    session_id: manifest.session_id,
    parent_id: manifest.parent_id || null,
    provider: manifest.provider || manifest.tool || config.provider || "local",
    task: resolvedTask,
    session_created_at: manifest.created_at || null,
    base_head: manifest.head_commit_at_creation || "unknown",
    current_head: currentHead,
    artifact_refs: {
      markdown: `.agentify/session/${sessionId}/handoff.md`,
      json: `.agentify/session/${sessionId}/handoff.json`,
      manifest: `.agentify/session/${sessionId}/session-manifest.json`,
      context: `.agentify/session/${sessionId}/context.json`,
      checklist: `.agentify/session/${sessionId}/checklist.json`,
      transcript: `.agentify/session/${sessionId}/transcript.md`,
    },
    top_ranked_context: summarizePlan(plan),
    touched_files: touchedFiles,
    touched_symbol_neighborhood: touchedSymbolNeighborhood,
    recommended_tests: summarizeTests(plan),
    unresolved_risks: [
      ...planWarnings.map((message) => ({ file_path: null, line: null, tag: "RISK", text: message })),
      ...await scanRisks(root, [...touchedFiles.map((item) => item.path), ...selectedRiskPaths]),
    ].slice(0, MAX_RISKS),
    conflict_hints: await collectConflictHints(root, sessionId, touchedFiles),
    next_actions: [],
  };
  bundle.next_actions = buildNextActions(bundle);
  return bundle;
}

export async function writeHandoffBundle(root, config, sessionId, task = "") {
  const paths = getSessionArtifactPaths(root, sessionId);
  const bundle = await buildHandoffBundle(root, config, sessionId, task);
  await ensurePrivateDir(paths.sessionDir);
  await writePrivateJson(paths.handoffJsonPath, bundle);
  await writePrivateText(paths.handoffMarkdownPath, renderHandoffMarkdown(bundle));
  return {
    bundle,
    jsonPath: paths.handoffJsonPath,
    markdownPath: paths.handoffMarkdownPath,
    relativeJsonPath: relative(root, paths.handoffJsonPath),
    relativeMarkdownPath: relative(root, paths.handoffMarkdownPath),
  };
}
