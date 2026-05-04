import fs from "node:fs/promises";
import path from "node:path";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadSymbols } from "./db/structural-store.js";
import { resolveSemanticSymbols } from "./db/semantic-store.js";
import { querySearch } from "./query.js";

function normalizePath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function resolveRepoPath(root, filePath) {
  const normalized = normalizePath(filePath).replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("context fetch requires a non-empty repo-relative path");
  }

  const rootPath = path.resolve(root);
  const absolutePath = path.resolve(rootPath, normalized);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("context fetch path must stay inside the repository");
  }

  return { relativePath: normalizePath(path.relative(rootPath, absolutePath)), absolutePath };
}

function parseLineRange(value) {
  const match = String(value || "").match(/^(\d+):(\d+)$/);
  if (!match) {
    throw new Error("context fetch --lines must use A:B syntax with 1-based inclusive line numbers");
  }

  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("context fetch --lines requires positive 1-based line numbers where A <= B");
  }

  return { startLine, endLine };
}

function exactLineSlice(content, startLine, endLine) {
  const lines = String(content || "").split(/\r?\n/);
  return lines.slice(startLine - 1, endLine).join("\n");
}

function findSymbolInIndex(root, relativePath, symbolName) {
  const db = openIndexDatabase(root, { readOnly: true });
  try {
    const semanticMatches = resolveSemanticSymbols(db, symbolName)
      .filter((symbolInfo) => normalizePath(symbolInfo.file_path) === relativePath);
    if (semanticMatches.length > 0) {
      return semanticMatches[0];
    }

    return loadSymbols(db)
      .filter((symbolInfo) => normalizePath(symbolInfo.file_path) === relativePath)
      .find((symbolInfo) => symbolInfo.name === symbolName) || null;
  } finally {
    closeIndexDatabase(db);
  }
}

export async function contextSearch(root, term) {
  const value = String(term || "").trim();
  if (!value) {
    throw new Error("context search requires a search term");
  }
  return querySearch(root, value);
}

export async function contextFetch(root, filePath, options = {}) {
  const { relativePath, absolutePath } = resolveRepoPath(root, filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  let range;
  let mode;
  let symbol = null;

  if (options.symbol && options.lines) {
    throw new Error("context fetch accepts only one of --symbol <name> or --lines A:B");
  }

  if (options.symbol) {
    symbol = findSymbolInIndex(root, relativePath, String(options.symbol));
    if (!symbol) {
      throw new Error(`context fetch could not find symbol "${options.symbol}" in ${relativePath}`);
    }
    range = { startLine: symbol.start_line, endLine: symbol.end_line };
    mode = "symbol";
  } else if (options.lines) {
    range = parseLineRange(options.lines);
    mode = "lines";
  } else {
    throw new Error("context fetch requires --symbol <name> or --lines A:B");
  }

  const exact = exactLineSlice(content, range.startLine, range.endLine);
  return {
    path: relativePath,
    mode,
    symbol: symbol ? {
      name: symbol.name,
      kind: symbol.kind,
    } : null,
    start_line: range.startLine,
    end_line: range.endLine,
    byte_count: Buffer.byteLength(exact, "utf8"),
    content: exact,
  };
}
