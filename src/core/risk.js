import path from "node:path";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { normalizeRows } from "./db/utils.js";
import { loadCommands, loadFiles, loadModules, loadSymbols, loadTests } from "./db/structural-store.js";
import { getChangedFiles, getChangedFilesSince } from "./git.js";

const RISK_SCHEMA_VERSION = "risk-v1";
const MAX_NEIGHBOR_DISTANCE = 2;

function normalizePath(filePath) {
  return String(filePath || "")
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "");
}

function uniqSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function riskLevel(score) {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  if (score > 0) return "low";
  return "none";
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

function addEdge(map, from, to, kind) {
  if (!from || !to || from === to) {
    return;
  }
  const fromPath = normalizePath(from);
  const toPath = normalizePath(to);
  if (!map.has(fromPath)) {
    map.set(fromPath, []);
  }
  map.get(fromPath).push({ path: toPath, kind });
}

function unresolvedImportTargets(fromPath, specifier) {
  const rawSpecifier = String(specifier || "");
  if (!rawSpecifier.startsWith(".")) {
    return [];
  }

  const basePath = normalizePath(path.join(path.dirname(fromPath), rawSpecifier));
  return [
    basePath,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}/index.js`,
    `${basePath}/index.jsx`,
    `${basePath}/index.mjs`,
    `${basePath}/index.cjs`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
  ];
}

function loadImportEdges(db) {
  const structural = normalizeRows(db.prepare(`
    SELECT from_path, to_path, specifier, kind
    FROM imports
    ORDER BY from_path, to_path, kind
  `).all()).flatMap((row) => {
    const targets = row.to_path
      ? [row.to_path]
      : unresolvedImportTargets(row.from_path, row.specifier);
    return targets.map((target) => ({
      from: row.from_path,
      to: target,
      kind: `import:${row.kind}${row.to_path ? "" : ":unresolved"}`,
      source: "structural",
    }));
  });

  const semantic = normalizeRows(db.prepare(`
    SELECT from_file_path, to_file_path, edge_kind, edge_domain, confidence
    FROM semantic_symbol_edges
    WHERE from_file_path IS NOT NULL
      AND to_file_path IS NOT NULL
    ORDER BY from_file_path, to_file_path, edge_kind, edge_domain
  `).all()).map((row) => ({
    from: row.from_file_path,
    to: row.to_file_path,
    kind: `semantic:${row.edge_domain}:${row.edge_kind}`,
    source: "semantic",
    confidence: row.confidence ?? 1,
  }));

  return [...structural, ...semantic];
}

function loadSemanticFacts(db) {
  const edgeRows = normalizeRows(db.prepare(`
    SELECT from_file_path, to_file_path, edge_domain, confidence
    FROM semantic_symbol_edges
    WHERE from_file_path IS NOT NULL
    ORDER BY from_file_path, to_file_path
  `).all());
  const surfaceRows = normalizeRows(db.prepare(`
    SELECT file_path, kind, role, surface_key, display_name
    FROM semantic_surfaces
    ORDER BY file_path, kind, role, surface_key
  `).all());
  const symbolRows = normalizeRows(db.prepare(`
    SELECT symbol_id, file_path, name, kind, export_name, is_exported, start_line, end_line
    FROM semantic_symbols
    ORDER BY file_path, start_line, name
  `).all());

  const byFile = new Map();
  function ensure(filePath) {
    const normalized = normalizePath(filePath);
    if (!byFile.has(normalized)) {
      byFile.set(normalized, {
        incoming: 0,
        outgoing: 0,
        runtimeIncoming: 0,
        runtimeOutgoing: 0,
        surfaces: [],
        exportedSymbols: [],
      });
    }
    return byFile.get(normalized);
  }

  for (const row of edgeRows) {
    if (row.from_file_path) {
      const facts = ensure(row.from_file_path);
      facts.outgoing += Number(row.confidence ?? 1);
      if (row.edge_domain === "runtime") facts.runtimeOutgoing += Number(row.confidence ?? 1);
    }
    if (row.to_file_path) {
      const facts = ensure(row.to_file_path);
      facts.incoming += Number(row.confidence ?? 1);
      if (row.edge_domain === "runtime") facts.runtimeIncoming += Number(row.confidence ?? 1);
    }
  }

  for (const row of surfaceRows) {
    ensure(row.file_path).surfaces.push({
      kind: row.kind,
      role: row.role,
      surface_key: row.surface_key,
      display_name: row.display_name,
    });
  }

  for (const row of symbolRows) {
    if (!row.is_exported) continue;
    ensure(row.file_path).exportedSymbols.push({
      symbol_id: row.symbol_id,
      name: row.name,
      kind: row.kind,
      export_name: row.export_name,
      start_line: row.start_line,
      end_line: row.end_line,
      source: "semantic",
    });
  }

  return byFile;
}

function buildGraph(edges) {
  const reverse = new Map();
  const forward = new Map();
  for (const edge of edges) {
    addEdge(forward, edge.from, edge.to, edge.kind);
    addEdge(reverse, edge.to, edge.from, edge.kind);
  }
  return { forward, reverse };
}

function buildNeighborhood(changedFiles, graph) {
  const impacted = new Map();
  const queue = [];

  for (const fileInfo of changedFiles) {
    const seedPaths = uniqSorted([fileInfo.path, fileInfo.orig_path]);
    for (const filePath of seedPaths) {
      if (!filePath) continue;
      impacted.set(filePath, {
        path: filePath,
        distance: 0,
        via: [],
        reasons: ["changed"],
      });
      queue.push({ path: filePath, distance: 0 });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.distance >= MAX_NEIGHBOR_DISTANCE) {
      continue;
    }
    const dependents = graph.reverse.get(current.path) || [];
    for (const edge of dependents) {
      const nextDistance = current.distance + 1;
      const existing = impacted.get(edge.path);
      if (!existing || nextDistance < existing.distance) {
        impacted.set(edge.path, {
          path: edge.path,
          distance: nextDistance,
          via: [{ from: current.path, kind: edge.kind }],
          reasons: [nextDistance === 1 ? "direct dependent" : "transitive dependent"],
        });
        queue.push({ path: edge.path, distance: nextDistance });
      } else if (existing.distance === nextDistance) {
        existing.via.push({ from: current.path, kind: edge.kind });
      }
    }
  }

  return Array.from(impacted.values())
    .map((item) => ({
      ...item,
      via: item.via
        .sort((left, right) => left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind))
        .slice(0, 5),
    }))
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path));
}

function statusWeight(status) {
  const code = String(status || "M").charAt(0);
  switch (code) {
    case "A": return 8;
    case "D": return 14;
    case "R": return 12;
    case "C": return 8;
    case "M": return 6;
    default: return 5;
  }
}

function fileSignal(fileInfo) {
  if (!fileInfo) {
    return 6;
  }
  let score = 0;
  if (fileInfo.is_config) score += 16;
  if (fileInfo.is_entrypoint) score += 12;
  if (fileInfo.is_key_file) score += 10;
  if (fileInfo.is_test) score -= 6;
  if (!fileInfo.is_test && !fileInfo.is_config) score += 7;
  return score;
}

function computeFileRisk(change, fileInfo, graphStats, semanticFacts) {
  const semantic = semanticFacts || {
    incoming: 0,
    outgoing: 0,
    runtimeIncoming: 0,
    runtimeOutgoing: 0,
    surfaces: [],
    exportedSymbols: [],
  };
  const incoming = graphStats.incoming || 0;
  const outgoing = graphStats.outgoing || 0;
  const semanticCentrality = semantic.runtimeIncoming * 5
    + semantic.runtimeOutgoing * 2
    + Math.max(0, semantic.incoming - semantic.runtimeIncoming) * 2
    + Math.max(0, semantic.outgoing - semantic.runtimeOutgoing);
  const surfaceScore = semantic.surfaces.length * 12;
  const exportScore = Math.min(12, semantic.exportedSymbols.length * 3);
  const fanoutScore = incoming * 6 + outgoing * 2;
  return {
    base: 10,
    status: statusWeight(change.status),
    file_signal: fileSignal(fileInfo),
    dependency_fanout: fanoutScore,
    semantic_centrality: semanticCentrality,
    semantic_surface: surfaceScore,
    exported_api: exportScore,
    total: 10 + statusWeight(change.status) + fileSignal(fileInfo) + fanoutScore + semanticCentrality + surfaceScore + exportScore,
  };
}

function collectGraphStats(edges) {
  const stats = new Map();
  function ensure(filePath) {
    const normalized = normalizePath(filePath);
    if (!stats.has(normalized)) {
      stats.set(normalized, { incoming: 0, outgoing: 0 });
    }
    return stats.get(normalized);
  }
  for (const edge of edges) {
    ensure(edge.from).outgoing += 1;
    ensure(edge.to).incoming += 1;
  }
  return stats;
}

function shellQuote(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandLine(command, args) {
  return [command, ...(args || [])].map(shellQuote).join(" ");
}

function buildImpactedModules(modules, impactedFiles, changedByPath, filesByPath) {
  const byModule = new Map();
  for (const impacted of impactedFiles) {
    const fileInfo = filesByPath.get(impacted.path);
    const owner = fileInfo?.module_id
      ? modules.find((moduleInfo) => moduleInfo.id === fileInfo.module_id)
      : findOwningModule(modules, impacted.path);
    if (!owner) continue;
    if (!byModule.has(owner.id)) {
      byModule.set(owner.id, {
        module_id: owner.id,
        module_name: owner.name,
        module_root: owner.root_path,
        stack: owner.stack,
        changed_files: [],
        impacted_files: [],
        score: 0,
      });
    }
    const moduleImpact = byModule.get(owner.id);
    moduleImpact.impacted_files.push(impacted.path);
    moduleImpact.score += Math.max(1, MAX_NEIGHBOR_DISTANCE + 1 - impacted.distance) * 5;
    if (changedByPath.has(impacted.path)) {
      moduleImpact.changed_files.push(impacted.path);
      moduleImpact.score += 15;
    }
  }

  return Array.from(byModule.values())
    .map((moduleImpact) => ({
      ...moduleImpact,
      changed_files: uniqSorted(moduleImpact.changed_files),
      impacted_files: uniqSorted(moduleImpact.impacted_files),
      score: clampScore(moduleImpact.score),
    }))
    .sort((left, right) => right.score - left.score || left.module_id.localeCompare(right.module_id));
}

function collectImpactedSymbols(symbols, semanticFactsByFile, impactedFiles) {
  const impactedSet = new Set(impactedFiles.map((fileInfo) => fileInfo.path));
  const structuralSymbols = symbols
    .filter((symbol) => impactedSet.has(symbol.file_path) && symbol.exported)
    .map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      file_path: symbol.file_path,
      module_id: symbol.module_id,
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      source: "structural",
    }));
  const semanticSymbols = [];
  for (const filePath of impactedSet) {
    const facts = semanticFactsByFile.get(filePath);
    for (const symbol of facts?.exportedSymbols || []) {
      semanticSymbols.push({
        name: symbol.name,
        kind: symbol.kind,
        file_path: filePath,
        module_id: null,
        start_line: symbol.start_line,
        end_line: symbol.end_line,
        source: "semantic",
      });
    }
  }

  const deduped = new Map();
  for (const symbol of [...structuralSymbols, ...semanticSymbols]) {
    const key = `${symbol.file_path}:${symbol.name}:${symbol.kind}`;
    if (!deduped.has(key)) {
      deduped.set(key, symbol);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => left.file_path.localeCompare(right.file_path) || left.start_line - right.start_line || left.name.localeCompare(right.name))
    .slice(0, 25);
}

function buildTestRecommendations(commands, tests, impactedModules, impactedFiles, changedByPath) {
  const impactedModuleIds = new Set(impactedModules.map((moduleInfo) => moduleInfo.module_id));
  const impactedFileSet = new Set(impactedFiles.map((fileInfo) => fileInfo.path));
  const moduleScore = new Map(impactedModules.map((moduleInfo) => [moduleInfo.module_id, moduleInfo.score]));
  const directTests = tests.filter((testInfo) => {
    const testPath = normalizePath(testInfo.file_path);
    const relatedPath = normalizePath(testInfo.related_path);
    return impactedFileSet.has(testPath)
      || impactedFileSet.has(relatedPath)
      || changedByPath.has(testPath)
      || changedByPath.has(relatedPath);
  });
  const directTestModules = new Set(directTests.map((testInfo) => testInfo.module_id).filter(Boolean));
  const directTestFilesByModule = new Map();
  for (const testInfo of directTests) {
    if (!testInfo.module_id) continue;
    const list = directTestFilesByModule.get(testInfo.module_id) || [];
    list.push(testInfo.file_path);
    directTestFilesByModule.set(testInfo.module_id, list);
  }

  const recommendations = [];
  for (const commandInfo of commands) {
    if (commandInfo.command_type !== "test") {
      continue;
    }
    const moduleId = commandInfo.module_id;
    const isImpacted = moduleId && impactedModuleIds.has(moduleId);
    const hasDirectTests = moduleId && directTestModules.has(moduleId);
    if (!isImpacted && !hasDirectTests) {
      continue;
    }
    const directFiles = uniqSorted(directTestFilesByModule.get(moduleId) || []);
    const priority = clampScore(35 + (moduleScore.get(moduleId) || 0) + (hasDirectTests ? 20 : 0));
    recommendations.push({
      command: commandInfo.command,
      args: commandInfo.args,
      command_line: commandLine(commandInfo.command, commandInfo.args),
      module_id: moduleId,
      priority,
      reason: hasDirectTests
        ? `Covers directly related test files for ${moduleId}.`
        : `Covers impacted module ${moduleId}.`,
      related_test_files: directFiles,
    });
  }

  return recommendations
    .sort((left, right) => right.priority - left.priority || left.command_line.localeCompare(right.command_line))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.command_line === item.command_line) === index);
}

function buildReasons(changedFileScores, impactedModules, semanticFactsByFile) {
  const reasons = [];
  const topFile = [...changedFileScores]
    .sort((left, right) => right.score.total - left.score.total || left.path.localeCompare(right.path))[0];
  if (topFile) {
    reasons.push(`${topFile.path} has the highest changed-file risk contribution (${Math.round(topFile.score.total)}).`);
    if (topFile.score.dependency_fanout > 0) {
      reasons.push("Dependency fan-out reaches files that import the changed code.");
    }
    if (topFile.score.semantic_centrality > 0) {
      reasons.push("Semantic edge centrality indicates runtime/type relationships around changed files.");
    }
  }
  if (impactedModules.length > 1) {
    reasons.push(`Changes cross ${impactedModules.length} impacted modules.`);
  }
  if (changedFileScores.some((item) => (semanticFactsByFile.get(item.path)?.surfaces || []).length > 0)) {
    reasons.push("At least one changed file owns a semantic surface.");
  }
  return reasons.sort();
}

export async function buildRiskReport(root, options = {}) {
  const db = openIndexDatabase(root, { readOnly: true });
  try {
    const modules = loadModules(db);
    const files = loadFiles(db);
    const symbols = loadSymbols(db);
    const tests = loadTests(db);
    const commands = loadCommands(db);
    const edges = loadImportEdges(db);
    const filesByPath = new Map(files.map((fileInfo) => [fileInfo.path, fileInfo]));
    const semanticFactsByFile = loadSemanticFacts(db);
    const graph = buildGraph(edges);
    const graphStats = collectGraphStats(edges);
    const changedFiles = (options.changedFiles
      || (options.since ? await getChangedFilesSince(root, options.since) : await getChangedFiles(root)))
      .map((entry) => ({
        status: entry.status || "M",
        path: normalizePath(entry.path),
        orig_path: entry.origPath ? normalizePath(entry.origPath) : null,
      }))
      .filter((entry) => entry.path)
      .sort((left, right) => left.path.localeCompare(right.path) || String(left.status).localeCompare(String(right.status)));
    const changedByPath = new Map(changedFiles.map((entry) => [entry.path, entry]));
    const impactedFiles = buildNeighborhood(changedFiles, graph)
      .map((fileImpact) => ({
        ...fileImpact,
        module_id: filesByPath.get(fileImpact.path)?.module_id || findOwningModule(modules, fileImpact.path)?.id || null,
      }));
    const changedFileScores = changedFiles.map((change) => {
      const fileInfo = filesByPath.get(change.path) || null;
      return {
        path: change.path,
        status: change.status,
        module_id: fileInfo?.module_id || findOwningModule(modules, change.path)?.id || null,
        score: computeFileRisk(
          change,
          fileInfo,
          graphStats.get(change.path) || { incoming: 0, outgoing: 0 },
          semanticFactsByFile.get(change.path)
        ),
      };
    });
    const impactedModules = buildImpactedModules(modules, impactedFiles, changedByPath, filesByPath);
    const impactedSymbols = collectImpactedSymbols(symbols, semanticFactsByFile, impactedFiles);
    const rawScore = changedFileScores.reduce((total, item) => total + item.score.total, 0)
      + impactedFiles.filter((item) => item.distance > 0).length * 4
      + impactedModules.length * 4;
    const score = clampScore(rawScore);
    const testRecommendations = buildTestRecommendations(commands, tests, impactedModules, impactedFiles, changedByPath);

    return {
      schema_version: RISK_SCHEMA_VERSION,
      command: "risk",
      since: options.since || null,
      changed_files: changedFileScores,
      risk: {
        score,
        level: riskLevel(score),
        reasons: buildReasons(changedFileScores, impactedModules, semanticFactsByFile),
      },
      impacted: {
        modules: impactedModules,
        files: impactedFiles,
        symbols: impactedSymbols,
      },
      prioritized_test_commands: testRecommendations,
      notes: testRecommendations.length === 0
        ? ["No indexed test command covers the impacted modules. Run agentify scan after adding package test scripts."]
        : [],
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export function renderRiskReport(report) {
  const lines = [];
  lines.push(`Risk: ${report.risk.score}/100 (${report.risk.level})`);
  if (report.since) {
    lines.push(`Since: ${report.since}`);
  }
  lines.push("");
  lines.push("Changed files:");
  if (report.changed_files.length === 0) {
    lines.push("- none");
  } else {
    for (const fileInfo of report.changed_files) {
      lines.push(`- ${fileInfo.path} [${fileInfo.status}] score ${Math.round(fileInfo.score.total)}`);
    }
  }
  lines.push("");
  lines.push("Impacted modules:");
  if (report.impacted.modules.length === 0) {
    lines.push("- none");
  } else {
    for (const moduleInfo of report.impacted.modules.slice(0, 10)) {
      lines.push(`- ${moduleInfo.module_id} (${moduleInfo.impacted_files.length} file(s), score ${moduleInfo.score})`);
    }
  }
  lines.push("");
  lines.push("Prioritized tests:");
  if (report.prioritized_test_commands.length === 0) {
    lines.push("- none");
  } else {
    for (const testCommand of report.prioritized_test_commands.slice(0, 10)) {
      lines.push(`- [${testCommand.priority}] ${testCommand.command_line}`);
    }
  }
  for (const note of report.notes || []) {
    lines.push("");
    lines.push(`Note: ${note}`);
  }
  return lines.join("\n");
}
