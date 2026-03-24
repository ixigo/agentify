import fs from "node:fs/promises";
import path from "node:path";

import { exists, relative, walkFiles } from "./fs.js";

function hasExtension(files, extensions) {
  return files.filter((file) => extensions.some((ext) => file.endsWith(ext))).length;
}

export async function detectStacks(root, config) {
  if (config.languages && config.languages !== "auto") {
    return [{ name: config.languages, confidence: 1 }];
  }

  const files = await walkFiles(root);
  const relFiles = files.map((file) => relative(root, file));

  const tsSignals = [
    await exists(path.join(root, "package.json")),
    await exists(path.join(root, "tsconfig.json")),
    await exists(path.join(root, "pnpm-workspace.yaml")),
    await exists(path.join(root, "package-lock.json")),
    await exists(path.join(root, "yarn.lock"))
  ].filter(Boolean).length + hasExtension(relFiles, [".ts", ".tsx", ".js", ".jsx"]);

  const pythonSignals = [
    await exists(path.join(root, "pyproject.toml")),
    await exists(path.join(root, "requirements.txt")),
    await exists(path.join(root, "setup.py"))
  ].filter(Boolean).length + hasExtension(relFiles, [".py"]);

  const dotnetSignals = [
    await exists(path.join(root, "global.json")),
    await exists(path.join(root, "Directory.Build.props"))
  ].filter(Boolean).length + hasExtension(relFiles, [".csproj", ".sln", ".cs"]);

  const maxSignals = Math.max(tsSignals, pythonSignals, dotnetSignals, 1);
  const stacks = [
    { name: "ts", confidence: tsSignals / maxSignals, raw: tsSignals },
    { name: "python", confidence: pythonSignals / maxSignals, raw: pythonSignals },
    { name: "dotnet", confidence: dotnetSignals / maxSignals, raw: dotnetSignals }
  ]
    .filter((item) => item.raw > 0)
    .sort((left, right) => right.confidence - left.confidence);

  if (stacks.length === 0) {
    return [{ name: "ts", confidence: 0.1 }];
  }

  return stacks.map(({ name, confidence }) => ({
    name,
    confidence: Number(confidence.toFixed(2))
  }));
}

async function readPackageJson(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

export async function detectTypeScriptModules(root, config) {
  const modules = [];
  const workspaceFile = path.join(root, "pnpm-workspace.yaml");
  const packageJson = await readPackageJson(path.join(root, "package.json"));
  const workspaceHints = new Set();

  if (await exists(workspaceFile)) {
    const raw = await fs.readFile(workspaceFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/-\s+(.+)/);
      if (match) {
        workspaceHints.add(match[1].replace(/["']/g, ""));
      }
    }
  }

  if (Array.isArray(packageJson?.workspaces)) {
    for (const entry of packageJson.workspaces) {
      workspaceHints.add(entry);
    }
  } else if (Array.isArray(packageJson?.workspaces?.packages)) {
    for (const entry of packageJson.workspaces.packages) {
      workspaceHints.add(entry);
    }
  }

  if (workspaceHints.size > 0 || config.moduleStrategy === "workspace") {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = path.join(root, entry.name, "package.json");
      if (await exists(packagePath)) {
        modules.push({
          id: entry.name,
          name: entry.name,
          rootPath: entry.name,
          stack: "ts"
        });
      }
    }
    if (modules.length > 0) {
      return modules;
    }
  }

  const srcPath = path.join(root, "src");
  if ((await exists(srcPath)) || config.moduleStrategy === "src-folder") {
    try {
      const entries = await fs.readdir(srcPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        modules.push({
          id: entry.name,
          name: entry.name,
          rootPath: `src/${entry.name}`,
          stack: "ts"
        });
      }
      if (modules.length > 0) {
        return modules;
      }
    } catch {
      // Fall through to top-level detection.
    }
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const indexCandidate = path.join(root, entry.name, "index.ts");
    const packageCandidate = path.join(root, entry.name, "package.json");
    if ((await exists(indexCandidate)) || (await exists(packageCandidate))) {
      modules.push({
        id: entry.name,
        name: entry.name,
        rootPath: entry.name,
        stack: "ts"
      });
    }
  }

  if (modules.length === 0) {
    modules.push({
      id: path.basename(root),
      name: path.basename(root),
      rootPath: ".",
      stack: "ts"
    });
  }

  return modules;
}

export async function detectPythonModules(root) {
  const candidates = [];
  const srcPath = path.join(root, "src");
  if (await exists(srcPath)) {
    const entries = await fs.readdir(srcPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (await exists(path.join(srcPath, entry.name, "__init__.py"))) {
        candidates.push({
          id: entry.name,
          name: entry.name,
          rootPath: `src/${entry.name}`,
          stack: "python"
        });
      }
    }
  }

  if (candidates.length > 0) {
    return candidates;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (await exists(path.join(root, entry.name, "__init__.py"))) {
      candidates.push({
        id: entry.name,
        name: entry.name,
        rootPath: entry.name,
        stack: "python"
      });
    }
  }

  return candidates.length > 0
    ? candidates
    : [{ id: path.basename(root), name: path.basename(root), rootPath: ".", stack: "python" }];
}

export async function detectDotnetModules(root) {
  const files = await walkFiles(root);
  const projects = files
    .filter((file) => file.endsWith(".csproj"))
    .map((file) => ({
      id: path.basename(file, ".csproj"),
      name: path.basename(file, ".csproj"),
      rootPath: relative(root, path.dirname(file)),
      stack: "dotnet"
    }));

  return projects.length > 0
    ? projects
    : [{ id: path.basename(root), name: path.basename(root), rootPath: ".", stack: "dotnet" }];
}

export async function detectModules(root, config, defaultStack) {
  switch (defaultStack) {
    case "python":
      return detectPythonModules(root, config);
    case "dotnet":
      return detectDotnetModules(root, config);
    case "ts":
    default:
      return detectTypeScriptModules(root, config);
  }
}
