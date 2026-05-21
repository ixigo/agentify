import path from "node:path";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadModuleDependencies, loadModules, searchIndex } from "./db/structural-store.js";
import { resolveAgentifyPaths } from "./project-store.js";
import {
  loadSemanticFileContext,
  loadSemanticInternalEdges,
  loadSemanticModuleDependencies,
  loadSemanticReferencesToSymbols,
  resolveSemanticSymbols,
  searchSemanticIndex,
} from "./db/semantic-store.js";
import { getChangedFilesSince } from "./git.js";

function normalizePath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function findOwningModule(modules, filePath) {
  const normalized = normalizePath(filePath);
  const sorted = [...modules].sort((left, right) => right.root_path.length - left.root_path.length);
  for (const moduleInfo of sorted) {
    if (
      moduleInfo.root_path === "."
      || normalized === moduleInfo.root_path
      || normalized.startsWith(`${moduleInfo.root_path}/`)
    ) {
      return moduleInfo;
    }
  }
  return null;
}

function symbolResolution(symbol, definitions) {
  return {
    symbol,
    ambiguous: definitions.length > 1,
    definitions,
    message: definitions.length === 0
      ? "No semantic symbol found"
      : definitions.length > 1
        ? "Multiple semantic symbols matched; results include all candidates in deterministic order"
        : undefined,
  };
}

function edgeRank(edge) {
  const kindScore = {
    calls: 100,
    renders: 90,
    references: 75,
    imports: 50,
    "re-exports": 45,
  }[edge.edge_kind] || 25;
  const domainScore = edge.edge_domain === "runtime" ? 10 : 0;
  return kindScore + domainScore + Number(edge.confidence || 0);
}

function rankedReferences(edges) {
  return edges
    .map((edge) => ({
      rank: edgeRank(edge),
      edge_kind: edge.edge_kind,
      edge_domain: edge.edge_domain,
      confidence: edge.confidence,
      from: edge.from,
      to: edge.to,
      metadata: edge.metadata,
    }))
    .sort((left, right) => {
      const rankDelta = right.rank - left.rank;
      if (rankDelta !== 0) return rankDelta;
      const fileDelta = String(left.from.file_path || "").localeCompare(String(right.from.file_path || ""));
      if (fileDelta !== 0) return fileDelta;
      return Number(left.from.start_line || 0) - Number(right.from.start_line || 0);
    });
}

function uniqueCallers(edges) {
  const callers = new Map();
  for (const ref of rankedReferences(edges.filter((edge) => ["calls", "renders"].includes(edge.edge_kind)))) {
    const key = ref.from.symbol_id || ref.from.file_path;
    const existing = callers.get(key);
    if (!existing || ref.rank > existing.rank) {
      callers.set(key, {
        rank: ref.rank,
        edge_kind: ref.edge_kind,
        edge_domain: ref.edge_domain,
        symbol_id: ref.from.symbol_id,
        name: ref.from.name,
        kind: ref.from.kind,
        file_path: ref.from.file_path,
        start_line: ref.from.start_line,
        end_line: ref.from.end_line,
      });
    }
  }
  return Array.from(callers.values()).sort((left, right) => {
    const rankDelta = right.rank - left.rank;
    if (rankDelta !== 0) return rankDelta;
    const fileDelta = String(left.file_path || "").localeCompare(String(right.file_path || ""));
    if (fileDelta !== 0) return fileDelta;
    return Number(left.start_line || 0) - Number(right.start_line || 0);
  });
}

function normalizeDepth(depth) {
  const parsed = Number(depth ?? 3);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 3;
  }
  return Math.min(Math.floor(parsed), 6);
}

function impactEdgeTargetFile(edge) {
  return edge.to.file_path || null;
}

function summarizeImpactVia(edge) {
  return {
    edge_kind: edge.edge_kind,
    edge_domain: edge.edge_domain,
    confidence: edge.confidence,
    from_file_path: edge.from.file_path,
    from_symbol: edge.from.name,
    to_file_path: impactEdgeTargetFile(edge),
    to_symbol: edge.to.name,
  };
}

function computeImpacts(filePath, edges, maxDepth) {
  const incomingByTargetFile = new Map();
  for (const edge of edges) {
    const targetFile = impactEdgeTargetFile(edge);
    if (!targetFile || !edge.from.file_path || edge.from.file_path === targetFile) {
      continue;
    }
    if (!incomingByTargetFile.has(targetFile)) {
      incomingByTargetFile.set(targetFile, []);
    }
    incomingByTargetFile.get(targetFile).push(edge);
  }

  const visited = new Set([filePath]);
  const impacts = new Map();
  let frontier = new Set([filePath]);

  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth += 1) {
    const next = new Set();
    for (const target of frontier) {
      const incoming = incomingByTargetFile.get(target) || [];
      for (const edge of incoming) {
        const impactedFile = edge.from.file_path;
        if (!impactedFile || visited.has(impactedFile)) {
          continue;
        }
        const score = Math.round(((maxDepth - depth + 1) * 100 + edgeRank(edge)) * 100) / 100;
        const existing = impacts.get(impactedFile);
        const via = summarizeImpactVia(edge);
        if (!existing) {
          impacts.set(impactedFile, {
            file_path: impactedFile,
            depth,
            rank: score,
            via: [via],
          });
        } else {
          existing.rank = Math.max(existing.rank, score);
          existing.via.push(via);
        }
        next.add(impactedFile);
      }
    }
    for (const impactedFile of next) {
      visited.add(impactedFile);
    }
    frontier = next;
  }

  return Array.from(impacts.values()).sort((left, right) => {
    const depthDelta = left.depth - right.depth;
    if (depthDelta !== 0) return depthDelta;
    const rankDelta = right.rank - left.rank;
    if (rankDelta !== 0) return rankDelta;
    return left.file_path.localeCompare(right.file_path);
  });
}

async function resolveQueryPaths(root, options = {}) {
  return options.artifactPaths || await resolveAgentifyPaths(root, options.config || {});
}

export async function queryOwner(root, filePath, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const modules = loadModules(db);
    const owner = findOwningModule(modules, filePath);
    const normalized = normalizePath(filePath);

    if (!owner) {
      return { file: normalized, module_id: null, message: "No owning module found" };
    }

    return {
      file: normalized,
      module_id: owner.id,
      module_name: owner.name,
      module_root: owner.root_path,
      doc_path: owner.doc_path,
      stack: owner.stack,
      semantic: loadSemanticFileContext(db, normalized),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryDeps(root, moduleId, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const modules = loadModules(db);
    const moduleInfo = modules.find((item) => item.id === moduleId);
    if (!moduleInfo) {
      return { module_id: moduleId, error: "Module not found" };
    }
    const deps = loadModuleDependencies(db, moduleId);
    const semanticDeps = loadSemanticModuleDependencies(db, moduleId);
    return {
      module_id: moduleId,
      depends_on: deps.dependsOn,
      used_by: deps.usedBy,
      semantic_depends_on: semanticDeps.dependsOn,
      semantic_used_by: semanticDeps.usedBy,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryChanged(root, sinceCommit, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const modules = loadModules(db);
    const changed = await getChangedFilesSince(root, sinceCommit);
    const affectedModules = new Map();

    for (const entry of changed) {
      const owner = findOwningModule(modules, entry.path);
      if (!owner) {
        continue;
      }
      if (!affectedModules.has(owner.id)) {
        affectedModules.set(owner.id, {
          module_id: owner.id,
          module_name: owner.name,
          changed_files: [],
        });
      }
      affectedModules.get(owner.id).changed_files.push({
        status: entry.status,
        path: entry.path,
      });
    }

    return {
      since: sinceCommit,
      affected_modules: Array.from(affectedModules.values()),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function querySearch(root, term, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const semantic = searchSemanticIndex(db, term);
    return {
      term,
      ...searchIndex(db, term),
      ...semantic,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryDef(root, symbol, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    return symbolResolution(symbol, resolveSemanticSymbols(db, symbol));
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryRefs(root, symbol, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const definitions = resolveSemanticSymbols(db, symbol);
    const references = rankedReferences(loadSemanticReferencesToSymbols(
      db,
      definitions.map((definition) => definition.symbol_id)
    ));
    return {
      ...symbolResolution(symbol, definitions),
      references,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryCallers(root, symbol, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const definitions = resolveSemanticSymbols(db, symbol);
    const edges = loadSemanticReferencesToSymbols(
      db,
      definitions.map((definition) => definition.symbol_id)
    );
    return {
      ...symbolResolution(symbol, definitions),
      callers: uniqueCallers(edges),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryImpacts(root, filePath, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const normalized = normalizePath(filePath);
    const depth = normalizeDepth(options.depth);
    return {
      file: normalized,
      depth,
      impacts: computeImpacts(normalized, loadSemanticInternalEdges(db), depth),
    };
  } finally {
    closeIndexDatabase(db);
  }
}
