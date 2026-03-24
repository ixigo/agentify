import fs from "node:fs/promises";
import path from "node:path";

import { relative, walkFiles } from "./fs.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function stripExtension(filePath) {
  return filePath.replace(/\.(ts|tsx|js|jsx)$/, "");
}

function resolveImport(fromFile, specifier, root) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx")
  ];

  for (const candidate of candidates) {
    if (TS_EXTENSIONS.some((ext) => candidate.endsWith(ext)) || candidate.endsWith("/index.ts") || candidate.endsWith("/index.tsx") || candidate.endsWith("/index.js") || candidate.endsWith("/index.jsx")) {
      return relative(root, candidate);
    }
  }

  return relative(root, `${base}.ts`);
}

function collectImports(text) {
  const specs = [];
  const patterns = [
    /import\s+[^'"]*['"]([^'"]+)['"]/g,
    /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      specs.push(match[1]);
    }
  }

  return specs;
}

export async function buildDependencyGraph(root) {
  const files = await walkFiles(root);
  const sourceFiles = files.filter((file) => TS_EXTENSIONS.some((ext) => file.endsWith(ext)));
  const graph = { nodes: {}, edges: [] };

  for (const file of sourceFiles) {
    const relPath = relative(root, file);
    graph.nodes[relPath] = { inDegree: 0, outDegree: 0 };
  }

  for (const file of sourceFiles) {
    const relPath = relative(root, file);
    const raw = await fs.readFile(file, "utf8");
    const imports = collectImports(raw);

    for (const specifier of imports) {
      const resolved = resolveImport(file, specifier, root);
      const target = resolved;
      if (!target || !graph.nodes[target]) {
        continue;
      }
      graph.edges.push({ from: relPath, to: target });
      graph.nodes[relPath].outDegree += 1;
      graph.nodes[target].inDegree += 1;
    }
  }

  return graph;
}

export function rankKeyFiles(moduleFiles, graph, limit) {
  const scored = moduleFiles.map((file) => {
    const node = graph.nodes[file] || { inDegree: 0, outDegree: 0 };
    let score = node.inDegree * 3 + node.outDegree;
    if (/\/?(src\/)?(index|main|app)\.(ts|tsx|js|jsx)$/.test(file)) {
      score += 10;
    }
    if (/(controller|service|module|route|page)\.(ts|tsx|js|jsx)$/.test(file)) {
      score += 8;
    }
    if (/\/(index|public|exports)\.(ts|tsx|js|jsx)$/.test(file)) {
      score += 6;
    }
    if (/(config|env|constants)\.(ts|tsx|js|jsx)$/.test(file)) {
      score += 3;
    }
    return { file, score };
  });

  return scored
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit)
    .map((item) => item.file);
}
