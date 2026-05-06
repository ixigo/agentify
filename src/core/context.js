import fs from "node:fs/promises";
import path from "node:path";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { searchIndex } from "./db/structural-store.js";
import { searchSemanticIndex } from "./db/semantic-store.js";
import { normalizeContextMode } from "./context-mode.js";

const MAX_FETCH_LINES = 240;

function normalizePathForOutput(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function resolveRepoPath(root, filePath) {
  const normalized = normalizePathForOutput(filePath);
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error("context fetch path must be a repository-relative path");
  }
  const fullPath = path.resolve(root, normalized);
  const rootPath = path.resolve(root);
  if (fullPath !== rootPath && !fullPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("context fetch path resolved outside the repository");
  }
  return { normalized, fullPath };
}

function parseLineRange(raw) {
  const match = String(raw || "").trim().match(/^(\d+):(\d+)$/);
  if (!match) {
    throw new Error("context fetch --lines requires A:B line range");
  }
  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("context fetch --lines requires a valid ascending A:B range");
  }
  const boundedEnd = Math.min(endLine, startLine + MAX_FETCH_LINES - 1);
  return {
    startLine,
    endLine: boundedEnd,
    requestedEndLine: endLine,
    truncated: boundedEnd < endLine,
  };
}

function rankedRefs(searchResult) {
  const refs = [];
  const groups = [
    ["semantic_symbols", 500],
    ["semantic_surfaces", 450],
    ["symbols", 400],
    ["files", 300],
    ["modules", 200],
  ];
  for (const [key, baseRank] of groups) {
    const items = searchResult[key] || [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      refs.push({
        rank: baseRank - index,
        type: key.replace(/^semantic_/, "semantic-").replace(/s$/, ""),
        path: item.file_path || item.path || item.root_path || item.doc_path || null,
        name: item.name || item.display_name || item.id || item.surface_key || null,
        kind: item.kind || item.stack || null,
        ref: item,
      });
    }
  }
  return refs.sort((left, right) => {
    const rankDelta = right.rank - left.rank;
    if (rankDelta !== 0) return rankDelta;
    return String(left.path || left.name || "").localeCompare(String(right.path || right.name || ""));
  });
}

export async function searchContext(root, term, options = {}) {
  const query = String(term || "").trim();
  if (!query || query === "true") {
    throw new Error("context search requires a search term");
  }
  const db = openIndexDatabase(root, { readOnly: true });
  try {
    const structural = searchIndex(db, query, options.limit || 20);
    const semantic = searchSemanticIndex(db, query, options.limit || 20);
    return {
      command: "context search",
      term: query,
      refs: rankedRefs({ ...structural, ...semantic }),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

function findSymbolRange(root, normalizedPath, symbol) {
  const db = openIndexDatabase(root, { readOnly: true });
  try {
    const semantic = db.prepare(`
      SELECT name, display_name, kind, start_line, end_line
      FROM semantic_symbols
      WHERE file_path = ?
        AND (name = ? OR display_name = ? OR export_name = ?)
      ORDER BY
        CASE WHEN name = ? THEN 0 ELSE 1 END,
        start_line
      LIMIT 1
    `).get(normalizedPath, symbol, symbol, symbol, symbol);
    if (semantic) {
      return {
        symbol: semantic.name,
        display_name: semantic.display_name,
        kind: semantic.kind,
        startLine: semantic.start_line,
        endLine: semantic.end_line,
      };
    }

    const structural = db.prepare(`
      SELECT name, kind, start_line, end_line
      FROM symbols
      WHERE file_path = ?
        AND name = ?
      ORDER BY start_line
      LIMIT 1
    `).get(normalizedPath, symbol);
    if (structural) {
      return {
        symbol: structural.name,
        display_name: structural.name,
        kind: structural.kind,
        startLine: structural.start_line,
        endLine: structural.end_line,
      };
    }
  } finally {
    closeIndexDatabase(db);
  }
  return null;
}

function renderSlice(lines, startLine, endLine) {
  return lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${String(startLine + index).padStart(4, " ")}: ${line}`)
    .join("\n");
}

export async function fetchContext(root, filePath, options = {}) {
  const { normalized, fullPath } = resolveRepoPath(root, filePath);
  let range;
  let symbol = null;
  if (options.symbol) {
    const symbolName = String(options.symbol).trim();
    if (!symbolName || symbolName === "true") {
      throw new Error("context fetch --symbol requires a symbol name");
    }
    symbol = findSymbolRange(root, normalized, symbolName);
    if (!symbol) {
      throw new Error(`context fetch could not find symbol "${symbolName}" in ${normalized}`);
    }
    const endLine = Math.max(symbol.startLine, symbol.endLine || symbol.startLine);
    range = {
      startLine: symbol.startLine,
      endLine: Math.min(endLine, symbol.startLine + MAX_FETCH_LINES - 1),
      requestedEndLine: endLine,
      truncated: endLine > symbol.startLine + MAX_FETCH_LINES - 1,
    };
  } else if (options.lines) {
    range = parseLineRange(options.lines);
  } else {
    throw new Error("context fetch requires --lines A:B or --symbol <name>");
  }

  const text = await fs.readFile(fullPath, "utf8");
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.min(range.startLine, totalLines);
  const endLine = Math.min(range.endLine, totalLines);

  return {
    command: "context fetch",
    path: normalized,
    start_line: startLine,
    end_line: endLine,
    requested_end_line: range.requestedEndLine,
    total_lines: totalLines,
    truncated: range.truncated || range.endLine > totalLines,
    symbol,
    content: renderSlice(lines, startLine, endLine),
  };
}

export { normalizeContextMode };

export function buildRoutedPrompt(basePrompt, memoryMarkdown = "", options = {}) {
  const task = String(basePrompt || "").trim();
  const sections = [
    "You are running in Agentify routed context mode.",
    "",
    "Context routing rules:",
    "- Start from repo docs and DB refs: AGENTIFY.md, docs/repo-map.md, docs/modules/, and .agents/index.db.",
    "- No full source file bodies are injected by default.",
    "- For more repository context, use only these bounded Agentify commands:",
    "  - agentify context search <term>",
    "  - agentify context fetch <path> --lines A:B",
    "  - agentify context fetch <path> --symbol X",
    "  - agentify context compact --session <id>",
    "  - agentify context status --session <id>",
    "- Do not use nested agentify scan/doc/up/query commands or direct SQLite reads for context routing.",
  ];
  if (memoryMarkdown.trim()) {
    sections.push("", memoryMarkdown.trim());
  }
  sections.push("", `Task: ${task}`);
  return sections.join("\n");
}
