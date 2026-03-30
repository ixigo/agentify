import fs from "node:fs/promises";
import path from "node:path";

import { relative, walkFiles } from "./fs.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const PY_EXTENSIONS = [".py"];
const JAVA_EXTENSIONS = [".java"];
const KOTLIN_EXTENSIONS = [".kt", ".kts"];
const SWIFT_EXTENSIONS = [".swift"];
const DOTNET_EXTENSIONS = [".cs"];

const EXTENSION_MAP = {
  ts: TS_EXTENSIONS,
  python: PY_EXTENSIONS,
  java: JAVA_EXTENSIONS,
  kotlin: KOTLIN_EXTENSIONS,
  swift: SWIFT_EXTENSIONS,
  dotnet: DOTNET_EXTENSIONS,
};

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
    path.join(base, "index.jsx"),
  ];

  for (const candidate of candidates) {
    if (TS_EXTENSIONS.some((ext) => candidate.endsWith(ext))) {
      return relative(root, candidate);
    }
  }

  return relative(root, `${base}.ts`);
}

function collectTsImports(text) {
  const specs = [];
  const patterns = [
    /import\s+[^'"]*['"]([^'"]+)['"]/g,
    /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      specs.push({ specifier: match[1], kind: "import" });
    }
  }
  return specs;
}

function collectPythonImports(text) {
  const specs = [];
  for (const match of text.matchAll(/^import\s+([\w.]+)/gm)) {
    specs.push({ specifier: match[1], kind: "import" });
  }
  for (const match of text.matchAll(/^from\s+([\w.]+)\s+import/gm)) {
    specs.push({ specifier: match[1], kind: "import" });
  }
  return specs;
}

function collectJavaImports(text) {
  const specs = [];
  for (const match of text.matchAll(/^import\s+(?:static\s+)?([\w.]+)/gm)) {
    specs.push({ specifier: match[1], kind: "import" });
  }
  return specs;
}

function collectSwiftImports(text) {
  const specs = [];
  for (const match of text.matchAll(/^import\s+(\w+)/gm)) {
    specs.push({ specifier: match[1], kind: "import" });
  }
  return specs;
}

function collectDotnetImports(text) {
  const specs = [];
  for (const match of text.matchAll(/^using\s+([\w.]+)\s*;/gm)) {
    specs.push({ specifier: match[1], kind: "using" });
  }
  for (const match of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
    specs.push({ specifier: match[1], kind: "project-ref" });
  }
  return specs;
}

function resolvePythonImport(specifier, root) {
  const parts = specifier.split(".");
  return [
    path.join(root, ...parts) + ".py",
    path.join(root, ...parts, "__init__.py"),
    path.join(root, "src", ...parts) + ".py",
    path.join(root, "src", ...parts, "__init__.py"),
  ];
}

function getExtensionsForStack(stack) {
  return EXTENSION_MAP[stack] || TS_EXTENSIONS;
}

export async function buildDependencyGraph(root, stack = "ts") {
  const files = await walkFiles(root);
  const extensions = getExtensionsForStack(stack);
  const sourceFiles = files.filter((file) => extensions.some((ext) => file.endsWith(ext)));
  const graph = { nodes: {}, edges: [] };
  const nodeSet = new Set();

  for (const file of sourceFiles) {
    const relPath = relative(root, file);
    graph.nodes[relPath] = { inDegree: 0, outDegree: 0 };
    nodeSet.add(relPath);
  }

  for (const file of sourceFiles) {
    const relPath = relative(root, file);
    const raw = await fs.readFile(file, "utf8");

    let importSpecs;
    switch (stack) {
      case "python":
        importSpecs = collectPythonImports(raw);
        break;
      case "java":
      case "kotlin":
        importSpecs = collectJavaImports(raw);
        break;
      case "swift":
        importSpecs = collectSwiftImports(raw);
        break;
      case "dotnet":
        importSpecs = collectDotnetImports(raw);
        break;
      default:
        importSpecs = collectTsImports(raw);
        break;
    }

    for (const { specifier, kind } of importSpecs) {
      let target = null;

      if (stack === "ts") {
        target = resolveImport(file, specifier, root);
      } else if (stack === "python") {
        const candidates = resolvePythonImport(specifier, root);
        for (const candidate of candidates) {
          const rel = relative(root, candidate);
          if (nodeSet.has(rel)) {
            target = rel;
            break;
          }
        }
      }

      if (!target || !graph.nodes[target]) continue;

      graph.edges.push({ from: relPath, to: target, kind });
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
    if (/\/?(src\/)?(index|main|app)\.(ts|tsx|js|jsx|py)$/.test(file)) {
      score += 10;
    }
    if (/(controller|service|module|route|page)\.(ts|tsx|js|jsx|py|java|kt|swift|cs)$/.test(file)) {
      score += 8;
    }
    if (/\/(index|public|exports)\.(ts|tsx|js|jsx)$/.test(file)) {
      score += 6;
    }
    if (/(config|env|constants|settings)\.(ts|tsx|js|jsx|py|java|kt|swift|cs)$/.test(file)) {
      score += 3;
    }
    if (/__init__\.py$/.test(file)) {
      score += 5;
    }
    if (/(Main|Application|Program|AppDelegate)\.(java|kt|cs|swift)$/.test(file)) {
      score += 10;
    }
    return { file, score };
  });

  return scored
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit)
    .map((item) => item.file);
}
