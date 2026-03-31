import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { detectModules, detectStacks } from "./detect.js";
import { exists, relative, walkFiles } from "./fs.js";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".cs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".rs",
  ".go",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toSlug(value) {
  return String(value || "module")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "ts";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".py":
      return "python";
    case ".cs":
      return "dotnet";
    case ".java":
      return "java";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return "text";
  }
}

function isTestFile(filePath) {
  return /(^|\/)(test|tests|__tests__)\//i.test(filePath) || /\.(test|spec)\.[^.]+$/i.test(filePath);
}

function isConfigFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  return base === "package.json"
    || base === "tsconfig.json"
    || /^tsconfig\..+\.json$/.test(base)
    || base === "pnpm-workspace.yaml"
    || base === "turbo.json"
    || base === ".agentify.yaml"
    || base === "pyproject.toml"
    || base === "cargo.toml"
    || base === "package.swift"
    || /(config|settings|env)\./.test(base);
}

function isModulePath(filePath, moduleRoot) {
  if (!moduleRoot || moduleRoot === ".") {
    return true;
  }
  return filePath === moduleRoot || filePath.startsWith(`${moduleRoot}/`);
}

function selectEntrypoints(files, stack) {
  const patterns =
    stack === "python"
      ? [/__main__\.py$/, /main\.py$/]
      : stack === "dotnet"
        ? [/Program\.cs$/]
      : stack === "java"
          ? [/Main\.java$/, /Application\.java$/, /MainActivity\.java$/]
          : stack === "kotlin"
            ? [/Main\.kt$/, /Application\.kt$/, /MainActivity\.kt$/]
            : stack === "go"
              ? [/cmd\/[^/]+\/main\.go$/, /main\.go$/]
              : stack === "rust"
                ? [/src\/main\.rs$/, /src\/lib\.rs$/, /src\/bin\/.+\.rs$/]
            : stack === "swift"
              ? [/main\.swift$/, /AppDelegate\.swift$/, /SceneDelegate\.swift$/, /.+App\.swift$/]
              : [/src\/index\.(ts|tsx|js|jsx|mjs|cjs)$/, /src\/main\.(ts|tsx|js|jsx|mjs|cjs)$/, /app\.(ts|tsx|js|jsx|mjs|cjs)$/, /server\.(ts|tsx|js|jsx|mjs|cjs)$/];

  return files.filter((file) => patterns.some((pattern) => pattern.test(file))).slice(0, 12);
}

function computeModuleFingerprint(fileRows) {
  return sha256(fileRows.map((row) => `${row.path}:${row.fingerprint}`).sort().join("\n"));
}

function globToRegExp(pattern) {
  const escaped = String(pattern || "")
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped.replace(/\/+$/, "")}$`);
}

async function readJsonIfExists(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

async function readTextIfExists(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return "";
  }
}

async function loadWorkspacePatterns(root) {
  const patterns = new Set();
  const packageJson = await readJsonIfExists(path.join(root, "package.json"));
  const workspaceRaw = await readTextIfExists(path.join(root, "pnpm-workspace.yaml"));

  for (const line of workspaceRaw.split(/\r?\n/)) {
    const match = line.match(/-\s+(.+)/);
    if (match) {
      patterns.add(match[1].trim().replace(/["']/g, "").replace(/\/+$/, ""));
    }
  }

  if (Array.isArray(packageJson?.workspaces)) {
    for (const item of packageJson.workspaces) {
      patterns.add(String(item).replace(/\/+$/, ""));
    }
  } else if (Array.isArray(packageJson?.workspaces?.packages)) {
    for (const item of packageJson.workspaces.packages) {
      patterns.add(String(item).replace(/\/+$/, ""));
    }
  }

  return Array.from(patterns).filter(Boolean);
}

async function detectTypeScriptModules(root, config, relFiles) {
  const patterns = await loadWorkspacePatterns(root);
  const packageFiles = relFiles.filter((file) => file === "package.json" || file.endsWith("/package.json"));
  const modules = [];

  if (patterns.length > 0 || config.moduleStrategy === "workspace") {
    const regexes = patterns.map(globToRegExp);
    for (const file of packageFiles) {
      const moduleRoot = path.dirname(file);
      if (moduleRoot === ".") {
        continue;
      }
      if (regexes.length > 0 && !regexes.some((regex) => regex.test(moduleRoot))) {
        continue;
      }
      const pkg = await readJsonIfExists(path.join(root, file));
      modules.push({
        id: (pkg?.name || moduleRoot).replace(/^@/, "").replace(/[\/@]/g, "-"),
        name: pkg?.name || path.basename(moduleRoot),
        rootPath: moduleRoot,
        stack: "ts",
        packageName: pkg?.name || null,
      });
    }
  }

  if (modules.length > 0) {
    return modules.sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  const fallbackModules = await detectModules(root, config, "ts");
  return fallbackModules.map((moduleInfo) => ({
    ...moduleInfo,
    packageName: null,
  }));
}

function findOwningModule(filePath, modules) {
  const sorted = [...modules].sort((left, right) => right.rootPath.length - left.rootPath.length);
  for (const moduleInfo of sorted) {
    if (isModulePath(filePath, moduleInfo.rootPath)) {
      return moduleInfo;
    }
  }
  return null;
}

function detectPackageManager(rootFiles, rootPackageJson) {
  const declared = typeof rootPackageJson?.packageManager === "string"
    ? rootPackageJson.packageManager.split("@")[0]
    : null;
  if (declared) {
    return declared;
  }
  if (rootFiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (rootFiles.includes("yarn.lock")) return "yarn";
  if (rootFiles.includes("bun.lock") || rootFiles.includes("bun.lockb")) return "bun";
  return "npm";
}

function buildScriptCommand(packageManager, moduleRoot, scriptName) {
  if (packageManager === "pnpm") {
    return moduleRoot === "."
      ? { command: "pnpm", args: [scriptName] }
      : { command: "pnpm", args: ["--dir", moduleRoot, scriptName] };
  }
  if (packageManager === "yarn") {
    return moduleRoot === "."
      ? { command: "yarn", args: [scriptName] }
      : { command: "yarn", args: ["--cwd", moduleRoot, scriptName] };
  }
  if (packageManager === "bun") {
    return moduleRoot === "."
      ? { command: "bun", args: [scriptName] }
      : { command: "bun", args: ["--cwd", moduleRoot, scriptName] };
  }
  return moduleRoot === "."
    ? { command: "npm", args: ["run", scriptName] }
    : { command: "npm", args: ["--prefix", moduleRoot, "run", scriptName] };
}

function scriptKindForPath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function collectExportedSymbols(sourceFile) {
  const symbols = [];

  function lineNumber(position) {
    return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  }

  function pushSymbol(node, name, kind, exported = false) {
    symbols.push({
      name,
      kind,
      exported,
      startLine: lineNumber(node.getStart(sourceFile)),
      endLine: lineNumber(node.getEnd()),
    });
  }

  function isExported(node) {
    return Array.isArray(node.modifiers)
      && node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword);
  }

  for (const node of sourceFile.statements) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      continue;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "function", isExported(node));
      continue;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "class", isExported(node));
      continue;
    }
    if (ts.isInterfaceDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "type", isExported(node));
      continue;
    }
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "type", isExported(node));
      continue;
    }
    if (ts.isEnumDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "const", isExported(node));
      continue;
    }
    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          pushSymbol(node, declaration.name.text, "const", exported);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(node)) {
      pushSymbol(node, "default", "module", true);
      continue;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        pushSymbol(node, element.name.text, "module", true);
      }
    }
  }

  return symbols;
}

function collectTsSpecifiers(sourceFile) {
  const imports = [];

  function pushSpecifier(specifier, kind) {
    if (typeof specifier === "string" && specifier.trim()) {
      imports.push({ specifier: specifier.trim(), kind });
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        pushSpecifier(node.moduleSpecifier.text, ts.isImportDeclaration(node) ? "import" : "export");
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        pushSpecifier(node.moduleReference.expression.text, "import");
      }
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression)
        && node.expression.text === "require"
        && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
      ) {
        pushSpecifier(node.arguments[0].text, "require");
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function normalizeResolvedPath(root, resolvedFileName) {
  const normalized = path.resolve(resolvedFileName);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!normalized.startsWith(rootPrefix)) {
    return null;
  }

  if (normalized.includes(`${path.sep}node_modules${path.sep}`)) {
    return null;
  }

  return relative(root, normalized);
}

function createTypeScriptCompilerOptions(root) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      baseUrl: root,
    };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      baseUrl: root,
    };
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  return {
    ...parsed.options,
    allowJs: parsed.options.allowJs ?? true,
    baseUrl: parsed.options.baseUrl || root,
  };
}

function resolveTsImport(root, compilerOptions, fromFile, specifier) {
  try {
    const resolved = ts.resolveModuleName(
      specifier,
      path.join(root, fromFile),
      compilerOptions,
      ts.sys
    ).resolvedModule;

    if (!resolved?.resolvedFileName) {
      return null;
    }

    const rel = normalizeResolvedPath(root, resolved.resolvedFileName);
    if (!rel) {
      return null;
    }

    if (rel.endsWith(".d.ts")) {
      return null;
    }

    return rel;
  } catch {
    return null;
  }
}

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function startsWithUppercase(value) {
  return /^[A-Z]/.test(String(value || ""));
}

function collectRegexSymbols(text, matchers) {
  const symbols = [];
  for (const matcher of matchers) {
    for (const match of text.matchAll(matcher.pattern)) {
      const symbol = matcher.map(match, text);
      if (!symbol?.name) {
        continue;
      }
      symbols.push(symbol);
    }
  }
  return symbols;
}

function collectGenericSymbols(language, text) {
  switch (language) {
    case "python":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "function",
              exported: !match[1].startsWith("_"),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(|:)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "class",
              exported: !match[1].startsWith("_"),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    case "go":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*func\s*(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "function",
              exported: startsWithUppercase(match[1]),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|map|chan|\[\]|func|\w+)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "type",
              exported: startsWithUppercase(match[1]),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(?:const|var)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "const",
              exported: startsWithUppercase(match[1]),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    case "rust":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[2],
              kind: "function",
              exported: Boolean(match[1]),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[2],
              kind: "type",
              exported: Boolean(match[1]),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[2],
              kind: "const",
              exported: Boolean(match[1]),
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    case "java":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*(?:public\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "class",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(?:public|protected|private)\s+(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "function",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    case "kotlin":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*(?:public|internal|private)?\s*(?:data\s+class|sealed\s+class|enum\s+class|class|interface|object)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "class",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(?:public|internal|private)?\s*fun\s+([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "function",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    case "dotnet":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*(?:public|internal|protected|private)?\s*(?:sealed\s+|static\s+|partial\s+)?(?:class|interface|enum|record|struct|delegate)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "class",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(?:public|internal|protected|private)\s+(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "function",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    case "swift":
      return collectRegexSymbols(text, [
        {
          pattern: /^\s*(?:public|open|internal|private)?\s*(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "class",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
        {
          pattern: /^\s*(?:public|open|internal|private)?\s*func\s+([A-Za-z_]\w*)\s*\(/gm,
          map(match, source) {
            return {
              name: match[1],
              kind: "function",
              exported: true,
              startLine: lineNumberForOffset(source, match.index),
              endLine: lineNumberForOffset(source, match.index + match[0].length),
            };
          },
        },
      ]);
    default:
      return [];
  }
}

function collectGenericImports(language, text) {
  const imports = [];
  if (language === "python") {
    for (const match of text.matchAll(/^import\s+([^\n]+)/gm)) {
      const specifiers = match[1]
        .split(",")
        .map((item) => item.trim().replace(/\s+as\s+\w+$/i, ""))
        .filter(Boolean);
      for (const specifier of specifiers) {
        imports.push({ specifier, kind: "import", members: [] });
      }
    }
    for (const match of text.matchAll(/^from\s+([.\w]+)\s+import\s+([^\n]+)/gm)) {
      const members = match[2]
        .replace(/[()]/g, "")
        .split(",")
        .map((item) => item.trim().replace(/\s+as\s+\w+$/i, ""))
        .filter(Boolean);
      imports.push({ specifier: match[1], kind: "import-from", members });
    }
    return imports;
  }
  if (language === "go") {
    for (const match of text.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    for (const match of text.matchAll(/^\s*"([^"]+)"/gm)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    return imports;
  }
  if (language === "rust") {
    for (const match of text.matchAll(/^\s*use\s+([^;]+);/gm)) {
      imports.push({ specifier: match[1].trim(), kind: "use" });
    }
    for (const match of text.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) {
      imports.push({ specifier: match[1], kind: "mod" });
    }
    return imports;
  }
  if (language === "java" || language === "kotlin") {
    for (const match of text.matchAll(/^import\s+(?:static\s+)?([\w.]+)/gm)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    return imports;
  }
  if (language === "dotnet") {
    for (const match of text.matchAll(/^using\s+([\w.]+)\s*;/gm)) {
      imports.push({ specifier: match[1], kind: "using" });
    }
    return imports;
  }
  if (language === "swift") {
    for (const match of text.matchAll(/^import\s+(\w+)/gm)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  }
  return imports;
}

async function readGoModuleName(root) {
  const raw = await readTextIfExists(path.join(root, "go.mod"));
  const match = raw.match(/^\s*module\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function normalizeRepoPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function stripLeadingSourceRoot(filePath) {
  const normalized = normalizeRepoPath(filePath);
  return normalized.startsWith("src/") ? normalized.slice(4) : normalized;
}

function pythonModuleNameForFile(filePath) {
  const normalized = stripLeadingSourceRoot(filePath);
  const withoutExt = normalized.replace(/\.py$/i, "");
  if (withoutExt.endsWith("/__init__")) {
    return withoutExt.slice(0, -"/__init__".length).replace(/\//g, ".");
  }
  return withoutExt.replace(/\//g, ".");
}

function pythonPackageNameForFile(filePath) {
  const moduleName = pythonModuleNameForFile(filePath);
  if (normalizeRepoPath(filePath).endsWith("/__init__.py") || path.posix.basename(filePath) === "__init__.py") {
    return moduleName;
  }
  const segments = moduleName.split(".").filter(Boolean);
  return segments.slice(0, -1).join(".");
}

function buildPythonModuleMap(repoFiles) {
  const moduleMap = new Map();
  for (const filePath of repoFiles) {
    if (!filePath.endsWith(".py")) {
      continue;
    }
    const moduleName = pythonModuleNameForFile(filePath);
    if (moduleName && !moduleMap.has(moduleName)) {
      moduleMap.set(moduleName, filePath);
    }
  }
  return moduleMap;
}

function resolvePythonImport(specifier, fromFile, repoFileSet, pythonModuleMap, members = []) {
  const relativeMatch = String(specifier || "").match(/^(\.+)(.*)$/);
  let resolvedModule = String(specifier || "").trim();

  if (relativeMatch) {
    const dots = relativeMatch[1].length;
    const tail = relativeMatch[2].replace(/^\./, "");
    const packageSegments = pythonPackageNameForFile(fromFile).split(".").filter(Boolean);
    const baseSegments = dots > 1
      ? packageSegments.slice(0, Math.max(0, packageSegments.length - (dots - 1)))
      : packageSegments;
    resolvedModule = [...baseSegments, ...tail.split(".").filter(Boolean)].join(".");
  }

  const candidates = [];
  if (resolvedModule) {
    candidates.push(resolvedModule);
  }
  for (const member of members) {
    if (!member || member === "*") {
      continue;
    }
    candidates.push(resolvedModule ? `${resolvedModule}.${member}` : member);
  }

  for (const candidate of candidates) {
    const direct = pythonModuleMap.get(candidate);
    if (direct && repoFileSet.has(direct)) {
      return direct;
    }
  }

  return null;
}

function chooseCanonicalFile(files) {
  return [...files]
    .filter((file) => !file.endsWith("_test.go"))
    .sort((left, right) => {
      const leftBase = path.posix.basename(left, path.posix.extname(left));
      const rightBase = path.posix.basename(right, path.posix.extname(right));
      const leftPriority = leftBase === "index" || leftBase === "main" || leftBase === "lib" ? -1 : 0;
      const rightPriority = rightBase === "index" || rightBase === "main" || rightBase === "lib" ? -1 : 0;
      return leftPriority - rightPriority || left.localeCompare(right);
    })[0] || null;
}

function buildGoPackageMap(repoFiles, moduleName) {
  const filesByDirectory = new Map();
  for (const filePath of repoFiles) {
    if (!filePath.endsWith(".go") || filePath.endsWith("_test.go")) {
      continue;
    }
    const dir = path.posix.dirname(filePath);
    const current = filesByDirectory.get(dir) || [];
    current.push(filePath);
    filesByDirectory.set(dir, current);
  }

  const packageMap = new Map();
  for (const [dir, files] of filesByDirectory.entries()) {
    const canonical = chooseCanonicalFile(files);
    if (!canonical) {
      continue;
    }
    packageMap.set(dir, canonical);
    if (moduleName) {
      const importPath = dir === "." ? moduleName : `${moduleName}/${dir}`;
      packageMap.set(importPath, canonical);
    }
  }
  return packageMap;
}

function resolveGoImport(specifier, goPackageMap) {
  if (!specifier) {
    return null;
  }
  return goPackageMap.get(specifier) || null;
}

function extractPackageScope(language, text) {
  if (language === "java" || language === "kotlin") {
    return text.match(/^\s*package\s+([\w.]+)\s*;?/m)?.[1] || null;
  }
  if (language === "dotnet") {
    return text.match(/^\s*namespace\s+([\w.]+)\s*[;{]/m)?.[1] || null;
  }
  return null;
}

function buildQualifiedTypeIndex(symbolRows, packageScopesByFile) {
  const index = new Map();
  const packageIndex = new Map();

  for (const [filePath, scope] of packageScopesByFile.entries()) {
    if (!scope) {
      continue;
    }
    const files = packageIndex.get(scope) || [];
    files.push(filePath);
    packageIndex.set(scope, files);
  }

  for (const symbolInfo of symbolRows) {
    if (!["class", "type"].includes(symbolInfo.kind)) {
      continue;
    }
    const scope = packageScopesByFile.get(symbolInfo.file_path);
    if (!scope) {
      continue;
    }
    const fqn = `${scope}.${symbolInfo.name}`;
    const files = index.get(fqn) || [];
    files.push(symbolInfo.file_path);
    index.set(fqn, files);
  }

  return { qualifiedTypes: index, packageIndex };
}

function resolveScopedImport(specifier, typeSymbolIndex, qualifiedTypeIndex, packageIndex) {
  if (!specifier) {
    return null;
  }

  if (specifier.endsWith(".*")) {
    const packageMatch = packageIndex.get(specifier.slice(0, -2)) || [];
    return packageMatch.sort()[0] || null;
  }

  const qualifiedMatches = qualifiedTypeIndex.get(specifier) || [];
  if (qualifiedMatches.length > 0) {
    return qualifiedMatches.sort()[0];
  }

  const symbolName = specifier.split(".").at(-1);
  const matches = typeSymbolIndex.get(symbolName) || [];
  return matches.length > 0 ? [...matches].sort()[0] : null;
}

function rustModuleSegmentsForFile(filePath) {
  const normalized = normalizeRepoPath(filePath);
  const srcIndex = normalized.indexOf("/src/");
  const withinSrc = srcIndex >= 0
    ? normalized.slice(srcIndex + 5)
    : normalized.startsWith("src/")
      ? normalized.slice(4)
      : normalized;

  if (withinSrc === "lib.rs" || withinSrc === "main.rs") {
    return [];
  }
  if (withinSrc.endsWith("/mod.rs")) {
    return withinSrc.slice(0, -"/mod.rs".length).split("/").filter(Boolean);
  }
  return withinSrc.replace(/\.rs$/i, "").split("/").filter(Boolean);
}

function buildRustCrateIndex(repoFileSet, modules) {
  const crateIndex = new Map();
  for (const moduleInfo of modules) {
    if (moduleInfo.stack !== "rust" || !moduleInfo.packageName) {
      continue;
    }
    const rootPath = normalizeRepoPath(moduleInfo.rootPath);
    const base = rootPath === "." ? "src" : `${rootPath}/src`;
    const entryFile = [`${base}/lib.rs`, `${base}/main.rs`].find((candidate) => repoFileSet.has(candidate)) || null;
    crateIndex.set(moduleInfo.packageName, { rootPath, entryFile });
  }
  return crateIndex;
}

function resolveRustModulePath(basePath, segments, repoFileSet) {
  for (let length = segments.length; length >= 1; length -= 1) {
    const prefix = segments.slice(0, length);
    const candidates = [
      `${basePath}/${prefix.join("/")}.rs`,
      `${basePath}/${prefix.join("/")}/mod.rs`,
    ];
    const match = candidates.find((candidate) => repoFileSet.has(candidate));
    if (match) {
      return match;
    }
  }
  return null;
}

function resolveRustImport(specifier, kind, fromFile, repoFileSet, rustCrateIndex) {
  if (kind === "mod") {
    const baseDir = path.posix.dirname(normalizeRepoPath(fromFile));
    const candidates = [
      `${baseDir}/${specifier}.rs`,
      `${baseDir}/${specifier}/mod.rs`,
    ];
    return candidates.find((candidate) => repoFileSet.has(candidate)) || null;
  }

  const normalized = String(specifier || "")
    .replace(/\s+as\s+\w+$/i, "")
    .replace(/::\{[^}]+\}/g, "")
    .replace(/[{}]/g, "");
  const parts = normalized.split("::").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  if (normalized.startsWith("crate::")) {
    return resolveRustModulePath("src", parts.slice(1), repoFileSet);
  }

  if (normalized.startsWith("self::")) {
    const baseSegments = rustModuleSegmentsForFile(fromFile);
    return resolveRustModulePath("src", [...baseSegments, ...parts.slice(1)], repoFileSet);
  }

  if (normalized.startsWith("super::")) {
    const baseSegments = rustModuleSegmentsForFile(fromFile);
    const parentSegments = baseSegments.slice(0, -1);
    return resolveRustModulePath("src", [...parentSegments, ...parts.slice(1)], repoFileSet);
  }

  const crateMatch = rustCrateIndex.get(parts[0]);
  if (crateMatch) {
    if (parts.length === 1) {
      return crateMatch.entryFile;
    }
    const crateBase = crateMatch.rootPath === "." ? "src" : `${crateMatch.rootPath}/src`;
    return resolveRustModulePath(crateBase, parts.slice(1), repoFileSet) || crateMatch.entryFile;
  }

  return resolveRustModulePath("src", parts, repoFileSet);
}

function buildSwiftModuleIndex(repoFileSet, modules) {
  const moduleIndex = new Map();
  for (const moduleInfo of modules) {
    if (moduleInfo.stack !== "swift") {
      continue;
    }
    const rootPath = normalizeRepoPath(moduleInfo.rootPath);
    const candidate = Array.from(repoFileSet)
      .filter((filePath) => filePath.startsWith(`${rootPath}/`) && filePath.endsWith(".swift"))
      .sort()[0];
    if (candidate) {
      moduleIndex.set(moduleInfo.name, candidate);
      if (moduleInfo.packageName) {
        moduleIndex.set(moduleInfo.packageName, candidate);
      }
    }
  }
  return moduleIndex;
}

function resolveGenericImport(language, importInfo, fromFile, repoFileSet, resolutionContext) {
  if (language === "python") {
    return resolvePythonImport(
      importInfo.specifier,
      fromFile,
      repoFileSet,
      resolutionContext.pythonModuleMap,
      importInfo.members || []
    );
  }
  if (language === "rust") {
    return resolveRustImport(
      importInfo.specifier,
      importInfo.kind,
      fromFile,
      repoFileSet,
      resolutionContext.rustCrateIndex
    );
  }
  if (language === "go") {
    return resolveGoImport(importInfo.specifier, resolutionContext.goPackageMap);
  }
  if (language === "java" || language === "kotlin" || language === "dotnet") {
    return resolveScopedImport(
      importInfo.specifier,
      resolutionContext.typeSymbolIndex,
      resolutionContext.qualifiedTypeIndex,
      resolutionContext.packageIndex
    );
  }
  if (language === "swift") {
    return resolutionContext.swiftModuleIndex.get(importInfo.specifier) || null;
  }
  return null;
}

function inferTestFramework(packageJson) {
  const deps = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {}),
  };
  if (deps.vitest) return "vitest";
  if (deps.jest) return "jest";
  if (deps.mocha) return "mocha";
  if (deps["@playwright/test"]) return "playwright";
  return "node:test";
}

function inferRelatedPath(testPath, repoFileSet) {
  const direct = testPath
    .replace(/__tests__\//g, "")
    .replace(/\.test(?=\.)/g, "")
    .replace(/\.spec(?=\.)/g, "");
  if (repoFileSet.has(direct)) {
    return direct;
  }

  const baseName = path.basename(direct);
  const parentDir = path.dirname(direct);
  const sibling = path.join(parentDir.replace(/\/tests?$/i, ""), baseName).split(path.sep).join("/");
  return repoFileSet.has(sibling) ? sibling : null;
}

function rankKeyFiles(fileRows, entryFiles, importRows) {
  const nodeStats = new Map();

  function ensure(pathKey) {
    if (!nodeStats.has(pathKey)) {
      nodeStats.set(pathKey, { inDegree: 0, outDegree: 0 });
    }
    return nodeStats.get(pathKey);
  }

  for (const row of fileRows) {
    ensure(row.path);
  }
  for (const row of importRows) {
    if (!row.to_path) {
      continue;
    }
    ensure(row.from_path).outDegree += 1;
    ensure(row.to_path).inDegree += 1;
  }

  return fileRows
    .filter((row) => isSourceFile(row.path) && !row.is_test)
    .map((row) => {
      const stats = ensure(row.path);
      let score = stats.inDegree * 3 + stats.outDegree;
      if (entryFiles.includes(row.path)) score += 40;
      if (/\/(index|public|exports)\./.test(row.path)) score += 18;
      if (/(controller|service|module|route|page|handler|store)\./.test(row.path)) score += 10;
      if (/(config|settings|constants|env)\./.test(row.path)) score += 6;
      if (row.path.split("/").length <= 2) score += 4;
      return { path: row.path, score };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 15)
    .map((row) => row.path);
}

async function buildModuleCommands(root, rootFiles, moduleInfo) {
  const rootPackageJson = await readJsonIfExists(path.join(root, "package.json"));
  const packageJson = await readJsonIfExists(path.join(root, moduleInfo.rootPath, "package.json"))
    || (moduleInfo.rootPath === "." ? rootPackageJson : null);
  if (!packageJson?.scripts) {
    return [];
  }

  const packageManager = detectPackageManager(rootFiles, rootPackageJson);
  const commands = [];
  for (const commandType of ["test", "build", "lint"]) {
    if (!packageJson.scripts[commandType]) {
      continue;
    }
    const scriptCommand = buildScriptCommand(packageManager, moduleInfo.rootPath, commandType);
    commands.push({
      module_id: moduleInfo.id,
      command_type: commandType,
      command: scriptCommand.command,
      args: scriptCommand.args,
    });
  }
  return commands;
}

export async function buildRepositoryIndex(root, config) {
  const generatedAt = new Date().toISOString();
  const stacks = await detectStacks(root, config);
  const defaultStack = stacks[0]?.name || "ts";
  const filePaths = (await walkFiles(root, { respectIgnore: true })).map((file) => relative(root, file));
  const repoFiles = filePaths.sort();
  const repoFileSet = new Set(repoFiles);

  const detectedModules = defaultStack === "ts"
    ? await detectTypeScriptModules(root, config, repoFiles)
    : await detectModules(root, config, defaultStack);

  const moduleRows = detectedModules.map((moduleInfo) => ({
    ...moduleInfo,
    slug: toSlug(moduleInfo.name),
  }));

  const compilerOptions = createTypeScriptCompilerOptions(root);
  const fileRows = [];
  const symbolRows = [];
  const importRows = [];
  const testRows = [];
  const commandRows = [];
  const moduleFiles = new Map(moduleRows.map((moduleInfo) => [moduleInfo.id, []]));
  const packageScopesByFile = new Map();
  const rootPackageJson = await readJsonIfExists(path.join(root, "package.json"));

  for (const filePath of repoFiles) {
    const absolutePath = path.join(root, filePath);
    const stat = await fs.stat(absolutePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const moduleInfo = findOwningModule(filePath, moduleRows);
    const language = getLanguage(filePath);

    const row = {
      path: filePath,
      module_id: moduleInfo?.id || null,
      language,
      size_bytes: stat.size,
      fingerprint: sha256(content),
      is_test: isTestFile(filePath) ? 1 : 0,
      is_config: isConfigFile(filePath) ? 1 : 0,
      is_entrypoint: 0,
      is_key_file: 0,
    };
    fileRows.push(row);

    if (moduleInfo) {
      moduleFiles.get(moduleInfo.id).push(row);
    }

    const packageScope = extractPackageScope(language, content);
    if (packageScope) {
      packageScopesByFile.set(filePath, packageScope);
    }

    if (TS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForPath(filePath)
      );
      for (const spec of collectTsSpecifiers(sourceFile)) {
        const toPath = resolveTsImport(root, compilerOptions, filePath, spec.specifier);
        const toModule = toPath ? findOwningModule(toPath, moduleRows) : null;
        importRows.push({
          from_path: filePath,
          to_path: toPath,
          specifier: spec.specifier,
          kind: spec.kind,
          from_module_id: moduleInfo?.id || null,
          to_module_id: toModule?.id || null,
        });
      }

      for (const symbol of collectExportedSymbols(sourceFile)) {
        symbolRows.push({
          module_id: moduleInfo?.id || null,
          file_path: filePath,
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported ? 1 : 0,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
        });
      }
    } else if (isSourceFile(filePath)) {
      for (const spec of collectGenericImports(language, content)) {
        importRows.push({
          from_path: filePath,
          to_path: null,
          specifier: spec.specifier,
          kind: spec.kind,
          from_module_id: moduleInfo?.id || null,
          to_module_id: null,
          members: spec.members || [],
        });
      }

      for (const symbol of collectGenericSymbols(language, content)) {
        symbolRows.push({
          module_id: moduleInfo?.id || null,
          file_path: filePath,
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported ? 1 : 0,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
        });
      }
    }

    if (row.is_test) {
      const relatedPath = inferRelatedPath(filePath, repoFileSet);
      testRows.push({
        file_path: filePath,
        module_id: moduleInfo?.id || null,
        framework: inferTestFramework(rootPackageJson),
        related_path: relatedPath,
      });
    }
  }

  const typeSymbolIndex = new Map();
  for (const symbolInfo of symbolRows) {
    if (!["class", "type"].includes(symbolInfo.kind)) {
      continue;
    }
    const existing = typeSymbolIndex.get(symbolInfo.name) || [];
    existing.push(symbolInfo.file_path);
    typeSymbolIndex.set(symbolInfo.name, existing);
  }

  const { qualifiedTypes, packageIndex } = buildQualifiedTypeIndex(symbolRows, packageScopesByFile);
  const resolutionContext = {
    pythonModuleMap: buildPythonModuleMap(repoFiles),
    goPackageMap: buildGoPackageMap(repoFiles, await readGoModuleName(root)),
    typeSymbolIndex,
    qualifiedTypeIndex: qualifiedTypes,
    packageIndex,
    rustCrateIndex: buildRustCrateIndex(repoFileSet, moduleRows),
    swiftModuleIndex: buildSwiftModuleIndex(repoFileSet, moduleRows),
  };

  const fileRowsByPath = new Map(fileRows.map((fileInfo) => [fileInfo.path, fileInfo]));
  for (const importInfo of importRows) {
    if (importInfo.to_path) {
      continue;
    }
    const fromLanguage = fileRowsByPath.get(importInfo.from_path)?.language;
    const toPath = resolveGenericImport(fromLanguage, importInfo, importInfo.from_path, repoFileSet, resolutionContext);
    if (!toPath) {
      continue;
    }
    importInfo.to_path = toPath;
    importInfo.to_module_id = findOwningModule(toPath, moduleRows)?.id || null;
  }

  for (const moduleInfo of moduleRows) {
    const currentFiles = moduleFiles.get(moduleInfo.id) || [];
    const sourcePaths = currentFiles
      .filter((row) => isSourceFile(row.path))
      .map((row) => row.path);
    const entryFiles = selectEntrypoints(sourcePaths, moduleInfo.stack);
    const moduleImportRows = importRows.filter((row) => row.from_module_id === moduleInfo.id);
    const keyFiles = rankKeyFiles(currentFiles, entryFiles, moduleImportRows);
    const fingerprint = computeModuleFingerprint(currentFiles);

    moduleInfo.entry_files = entryFiles;
    moduleInfo.key_files = keyFiles;
    moduleInfo.doc_path = `docs/modules/${moduleInfo.slug}.md`;
    moduleInfo.fingerprint = fingerprint;

    for (const row of currentFiles) {
      if (entryFiles.includes(row.path)) {
        row.is_entrypoint = 1;
      }
      if (keyFiles.includes(row.path)) {
        row.is_key_file = 1;
      }
    }

    const commands = await buildModuleCommands(root, repoFiles, moduleInfo);
    commandRows.push(...commands);
  }

  return {
    schema_version: "2.0",
    generated_at: generatedAt,
    repo: {
      name: path.basename(root),
      root,
      detected_stacks: stacks,
      default_stack: defaultStack,
      package_manager: detectPackageManager(repoFiles, rootPackageJson),
    },
    modules: moduleRows.map((moduleInfo) => ({
      id: moduleInfo.id,
      name: moduleInfo.name,
      root_path: moduleInfo.rootPath,
      stack: moduleInfo.stack,
      package_name: moduleInfo.packageName || null,
      slug: moduleInfo.slug,
      doc_path: moduleInfo.doc_path,
      fingerprint: moduleInfo.fingerprint,
      entry_files: moduleInfo.entry_files,
      key_files: moduleInfo.key_files,
    })),
    files: fileRows,
    symbols: symbolRows,
    imports: importRows,
    tests: testRows,
    commands: commandRows,
  };
}
