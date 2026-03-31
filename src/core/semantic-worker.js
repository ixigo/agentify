import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function normalize(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function isRepoOwned(root, filePath) {
  const resolved = path.resolve(filePath);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  return resolved.startsWith(rootPrefix) && !resolved.includes(`${path.sep}node_modules${path.sep}`);
}

function isTsJsFile(filePath) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) && !filePath.endsWith(".d.ts");
}

function isSupportPath(filePath) {
  return /(^|\/)(__tests__|__mocks__|fixtures?|examples?|stories)\//i.test(filePath)
    || /\.(test|spec|stories)\.[^.]+$/i.test(filePath);
}

function shouldTreatAsOwned(filePath) {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  if (/(^|\/)(dist|build|coverage|generated|__generated__)\//i.test(filePath)) {
    return false;
  }
  return true;
}

function createCompilerOptions(root) {
  return {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    baseUrl: root,
  };
}

function parseProject(root, project) {
  if (project.inferred || !project.configPath) {
    return {
      options: createCompilerOptions(root),
      fileNames: project.filePaths.map((filePath) => path.join(root, filePath)),
    };
  }

  const configPath = path.join(root, project.configPath);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const allowedFiles = new Set((project.filePaths || []).map((filePath) => normalize(filePath)));
  return {
    options: {
      ...parsed.options,
      allowJs: parsed.options.allowJs ?? true,
      checkJs: parsed.options.checkJs ?? true,
      jsx: parsed.options.jsx ?? ts.JsxEmit.ReactJSX,
      baseUrl: parsed.options.baseUrl || root,
    },
    fileNames: parsed.fileNames
      .filter((filePath) => isRepoOwned(root, filePath) && isTsJsFile(filePath))
      .filter(shouldTreatAsOwned)
      .filter((filePath) => allowedFiles.size === 0 || allowedFiles.has(normalize(path.relative(root, filePath)))),
  };
}

function pathHash(...parts) {
  return sha1(parts.join(":"));
}

function lineNumber(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function symbolIdentity(projectId, filePath, name, kind, startLine, endLine) {
  return `sym_${pathHash(projectId, filePath, name, kind, String(startLine), String(endLine))}`;
}

function inferRouteSurface(filePath) {
  const normalized = normalize(filePath);
  const segments = normalized.split("/");
  const appIndex = segments.findIndex((segment) => segment === "app");
  const pagesIndex = segments.findIndex((segment) => segment === "pages");
  const baseName = path.basename(normalized).replace(/\.[^.]+$/, "");

  if (path.basename(normalized).startsWith("middleware.")) {
    return {
      kind: "route",
      role: "middleware",
      surfaceKey: "/",
      displayName: "middleware",
      isHeaderTarget: true,
    };
  }

  if (appIndex >= 0) {
    const routeSegments = segments.slice(appIndex + 1, -1)
      .filter((segment) => !segment.startsWith("(") && !segment.startsWith("@"));
    let surfaceKey = `/${routeSegments.join("/")}`.replace(/\/+/g, "/");
    if (surfaceKey === "/") {
      surfaceKey = "/";
    }
    const roleMap = {
      page: "page",
      layout: "layout",
      loading: "loading",
      error: "error",
      template: "template",
      default: "default",
      route: "route-handler",
      "not-found": "not-found",
    };
    if (roleMap[baseName]) {
      return {
        kind: "route",
        role: roleMap[baseName],
        surfaceKey,
        displayName: surfaceKey,
        isHeaderTarget: true,
      };
    }
  }

  if (pagesIndex >= 0) {
    const routeSegments = segments.slice(pagesIndex + 1);
    const withoutExt = routeSegments.join("/").replace(/\.[^.]+$/, "");
    if (withoutExt.startsWith("api/")) {
      return {
        kind: "route",
        role: "api-handler",
        surfaceKey: `/${withoutExt}`.replace(/\/index$/, "").replace(/\/+/g, "/"),
        displayName: withoutExt,
        isHeaderTarget: true,
      };
    }
    if (["_app", "_document", "_error"].includes(baseName)) {
      return {
        kind: "route",
        role: baseName.slice(1),
        surfaceKey: "/",
        displayName: baseName,
        isHeaderTarget: true,
      };
    }
    return {
      kind: "route",
      role: "page",
      surfaceKey: `/${withoutExt}`.replace(/\/index$/, "").replace(/\/+/g, "/"),
      displayName: withoutExt,
      isHeaderTarget: true,
    };
  }

  return null;
}

function createProjectSurface(projectId, filePath, kind, role, surfaceKey, displayName, symbolId, isHeaderTarget) {
  return {
    surface_id: `surface_${pathHash(projectId, kind, surfaceKey || filePath, role || "", symbolId || "", filePath)}`,
    project_id: projectId,
    file_path: filePath,
    symbol_id: symbolId || null,
    kind,
    role: role || kind,
    surface_key: surfaceKey || displayName || filePath,
    display_name: displayName || surfaceKey || filePath,
    domain: isSupportPath(filePath) ? "support" : "runtime",
    is_header_target: isHeaderTarget ? 1 : 0,
  };
}

function collectProjectFiles(root, parsed) {
  return parsed.fileNames
    .filter((filePath) => isRepoOwned(root, filePath))
    .map((filePath) => normalize(path.relative(root, filePath)))
    .filter((filePath) => isTsJsFile(filePath))
    .filter(shouldTreatAsOwned)
    .sort();
}

function isExportedDeclaration(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
    || (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0;
}

function isSourceFileWithJsx(sourceFile) {
  return sourceFile.languageVariant === ts.LanguageVariant.JSX || /\.(tsx|jsx)$/.test(sourceFile.fileName);
}

function declarationKind(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "const";
  if (ts.isVariableDeclaration(node)) return "const";
  return "symbol";
}

function symbolNameFromNode(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function isReactComponentName(name) {
  return /^[A-Z]/.test(name);
}

function isHookName(name) {
  return /^use[A-Z]/.test(name);
}

function createEdge(projectId, params) {
  return {
    project_id: projectId,
    from_symbol_id: params.fromSymbolId || null,
    to_symbol_id: params.toSymbolId || null,
    from_file_path: params.fromFilePath || null,
    to_file_path: params.toFilePath || null,
    to_external_package: params.toExternalPackage || null,
    edge_kind: params.kind,
    edge_domain: params.domain,
    confidence: params.confidence ?? 1,
    source: params.source || "typescript-language-service",
    metadata_json: params.metadata ? JSON.stringify(params.metadata) : null,
  };
}

function externalPackageName(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

function resolveModuleTarget(root, sourceFile, specifier, options) {
  if (!specifier) {
    return null;
  }

  try {
    const resolved = ts.resolveModuleName(
      specifier,
      sourceFile.fileName,
      options,
      ts.sys
    ).resolvedModule;
    if (!resolved?.resolvedFileName) {
      return null;
    }
    if (!isRepoOwned(root, resolved.resolvedFileName)) {
      return null;
    }
    const relativePath = normalize(path.relative(root, resolved.resolvedFileName));
    if (!shouldTreatAsOwned(relativePath) || relativePath.endsWith(".d.ts")) {
      return null;
    }
    return relativePath;
  } catch {
    return null;
  }
}

function declarationKey(node, sourceFile) {
  return `${normalize(sourceFile.fileName)}:${node.getStart(sourceFile)}:${node.getEnd()}`;
}

function getResolvedDeclarations(symbol) {
  if (!symbol) {
    return [];
  }
  const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? null : symbol;
  const declarations = target?.declarations || [];
  return declarations;
}

function resolveAliasedDeclarations(checker, symbol) {
  if (!symbol) {
    return [];
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol.declarations || [];
  }
  try {
    const aliased = checker.getAliasedSymbol(symbol);
    return aliased?.declarations || [];
  } catch {
    return [];
  }
}

function enclosingSymbolId(stack) {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

async function main() {
  const root = process.argv[2];
  const payload = JSON.parse(process.argv[3] || "{}");
  const project = payload.project;
  const analyzerVersion = payload.analyzerVersion || "semantic-tsjs-v1";
  const parsed = parseProject(root, project);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const repoFiles = collectProjectFiles(root, parsed);
  const declarationToSymbolId = new Map();
  const exportsByFile = new Map();
  const symbols = [];
  const surfaces = [];
  const symbolEdges = [];
  const externalPackages = new Set();
  const routeSurfaceKeys = new Set();
  const supportEdgeDedup = new Set();
  const projectId = project.id;

  for (const filePath of repoFiles) {
    const sourceFile = program.getSourceFile(path.join(root, filePath));
    if (!sourceFile) {
      continue;
    }

    const routeSurface = inferRouteSurface(filePath);
    if (routeSurface) {
      const routeKey = `${routeSurface.kind}:${routeSurface.surfaceKey}:${routeSurface.role}:${filePath}`;
      if (!routeSurfaceKeys.has(routeKey)) {
        routeSurfaceKeys.add(routeKey);
        surfaces.push(createProjectSurface(
          projectId,
          filePath,
          routeSurface.kind,
          routeSurface.role,
          routeSurface.surfaceKey,
          routeSurface.displayName,
          null,
          routeSurface.isHeaderTarget
        ));
      }
    }

    const fileExports = new Set();

    function pushSymbol(node, exported = false) {
      const name = symbolNameFromNode(node);
      if (!name) {
        return;
      }
      const kind = declarationKind(node);
      const startLine = lineNumber(sourceFile, node.getStart(sourceFile));
      const endLine = lineNumber(sourceFile, node.getEnd());
      const symbolId = symbolIdentity(projectId, filePath, name, kind, startLine, endLine);
      declarationToSymbolId.set(declarationKey(node, sourceFile), symbolId);
      symbols.push({
        symbol_id: symbolId,
        project_id: projectId,
        file_path: filePath,
        name,
        display_name: name,
        kind,
        export_name: exported ? name : null,
        start_line: startLine,
        end_line: endLine,
        is_exported: exported ? 1 : 0,
        is_default: (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0 ? 1 : 0,
        domain: isSupportPath(filePath) ? "support" : "runtime",
      });
      if (exported) {
        fileExports.add(name);
      }

      if (exported) {
        const fileHasJsx = isSourceFileWithJsx(sourceFile);
        const nameIsComponent = isReactComponentName(name);
        const role = isHookName(name)
          ? "hook"
          : /Context$/.test(name)
            ? "context"
            : /Provider$/.test(name)
              ? "provider"
              : fileHasJsx && nameIsComponent
                ? "component"
                : null;
        if (role) {
          surfaces.push(createProjectSurface(
            projectId,
            filePath,
            role === "component" ? "react-component" : `react-${role}`,
            role,
            name,
            name,
            symbolId,
            true
          ));
        }
      }
    }

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        pushSymbol(statement, isExportedDeclaration(statement));
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        pushSymbol(statement, isExportedDeclaration(statement));
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        pushSymbol(statement, isExportedDeclaration(statement));
      } else if (ts.isVariableStatement(statement)) {
        const exported = isExportedDeclaration(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            pushSymbol(declaration, exported);
          }
        }
      }
    }

    exportsByFile.set(filePath, Array.from(fileExports));
  }

  for (const filePath of repoFiles) {
    const sourceFile = program.getSourceFile(path.join(root, filePath));
    if (!sourceFile) {
      continue;
    }

    const symbolStack = [];

    function resolveTargetSymbolId(node) {
      const symbol = checker.getSymbolAtLocation(node);
      const declarations = resolveAliasedDeclarations(checker, symbol).concat(getResolvedDeclarations(symbol));
      for (const declaration of declarations) {
        const declarationSource = declaration.getSourceFile();
        const declarationFile = normalize(path.relative(root, declarationSource.fileName));
        const key = declarationKey(declaration, declarationSource);
        const symbolId = declarationToSymbolId.get(key);
        if (symbolId) {
          return { symbolId, filePath: declarationFile };
        }
      }
      return null;
    }

    function addEdge(params) {
      const dedupeKey = JSON.stringify([
        params.kind,
        params.domain,
        params.fromSymbolId || null,
        params.toSymbolId || null,
        params.fromFilePath || null,
        params.toFilePath || null,
        params.toExternalPackage || null,
        params.metadata || null,
      ]);
      if (supportEdgeDedup.has(dedupeKey)) {
        return;
      }
      supportEdgeDedup.add(dedupeKey);
      symbolEdges.push(createEdge(projectId, params));
    }

    function withDeclaration(node, fn) {
      const key = declarationKey(node, sourceFile);
      const symbolId = declarationToSymbolId.get(key);
      if (symbolId) {
        symbolStack.push(symbolId);
      }
      fn();
      if (symbolId) {
        symbolStack.pop();
      }
    }

    function visit(node) {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
        withDeclaration(node, () => ts.forEachChild(node, visit));
        return;
      }

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;
        const domain = node.isTypeOnly ? "type" : "runtime";
        const internalTarget = resolveModuleTarget(root, sourceFile, specifier, parsed.options);
        if (internalTarget) {
          addEdge({
            fromSymbolId: enclosingSymbolId(symbolStack),
            fromFilePath: filePath,
            toFilePath: internalTarget,
            kind: ts.isExportDeclaration(node) ? "re-exports" : "imports",
            domain,
            confidence: 0.98,
            metadata: specifier ? { specifier } : null,
          });
        }
        const targetPackage = externalPackageName(specifier);
        if (targetPackage) {
          externalPackages.add(targetPackage);
          addEdge({
            fromSymbolId: enclosingSymbolId(symbolStack),
            fromFilePath: filePath,
            toExternalPackage: targetPackage,
            kind: ts.isExportDeclaration(node) ? "re-exports" : "imports-package",
            domain,
            confidence: 0.95,
            metadata: specifier ? { specifier } : null,
          });
        }
      }

      if (ts.isCallExpression(node)) {
        const target = resolveTargetSymbolId(node.expression);
        if (target) {
          addEdge({
            fromSymbolId: enclosingSymbolId(symbolStack),
            toSymbolId: target.symbolId,
            fromFilePath: filePath,
            toFilePath: target.filePath,
            kind: "calls",
            domain: "runtime",
            confidence: 0.9,
          });
        } else if (ts.isIdentifier(node.expression)) {
          const pkg = externalPackageName(node.expression.text);
          if (pkg) {
            addEdge({
              fromSymbolId: enclosingSymbolId(symbolStack),
              fromFilePath: filePath,
              toExternalPackage: pkg,
              kind: "calls-package",
              domain: "runtime",
              confidence: 0.5,
            });
          }
        }
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const target = resolveTargetSymbolId(node.tagName);
        if (target) {
          addEdge({
            fromSymbolId: enclosingSymbolId(symbolStack),
            toSymbolId: target.symbolId,
            fromFilePath: filePath,
            toFilePath: target.filePath,
            kind: "renders",
            domain: "runtime",
            confidence: 0.9,
          });
        }
      }

      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const target = resolveTargetSymbolId(node.typeName);
        if (target) {
          addEdge({
            fromSymbolId: enclosingSymbolId(symbolStack),
            toSymbolId: target.symbolId,
            fromFilePath: filePath,
            toFilePath: target.filePath,
            kind: "references",
            domain: "type",
            confidence: 0.8,
          });
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  const fileCount = repoFiles.length;
  const contentEntries = [];
  for (const filePath of repoFiles) {
    const content = await fs.readFile(path.join(root, filePath), "utf8");
    contentEntries.push(`${filePath}:${crypto.createHash("sha256").update(content).digest("hex")}`);
  }

  const publicEntries = [
    ...symbols.filter((symbol) => symbol.is_exported).map((symbol) => `export:${symbol.file_path}:${symbol.export_name}:${symbol.kind}`),
    ...surfaces.map((surface) => `surface:${surface.kind}:${surface.surface_key}:${surface.role}:${surface.file_path}`),
  ];

  process.stdout.write(`${JSON.stringify({
    project: {
      project_id: projectId,
      config_path: project.configPath || null,
      project_root: project.projectRoot || ".",
      inferred: project.inferred ? 1 : 0,
      analyzer_version: analyzerVersion,
      schema_version: "semantic-tsjs-1",
      status: "ready",
      coverage_ratio: 1,
      file_count: fileCount,
      symbol_count: symbols.length,
      surface_count: surfaces.length,
      edge_count: symbolEdges.length,
      content_fingerprint: crypto.createHash("sha256").update(contentEntries.sort().join("\n")).digest("hex"),
      public_fingerprint: crypto.createHash("sha256").update(publicEntries.sort().join("\n")).digest("hex"),
      refreshed_at: new Date().toISOString(),
      last_error: null,
    },
    files: repoFiles.map((filePath) => ({
      project_id: projectId,
      file_path: filePath,
      domain: isSupportPath(filePath) ? "support" : "runtime",
      is_header_target: surfaces.some((surface) => surface.file_path === filePath && surface.is_header_target)
        || exportsByFile.get(filePath)?.length > 0
        ? 1
        : 0,
    })),
    externalPackages: Array.from(externalPackages).sort().map((packageName) => ({
      project_id: projectId,
      package_name: packageName,
      usage_count: symbolEdges.filter((edge) => edge.to_external_package === packageName).length,
    })),
    symbols,
    surfaces,
    symbolEdges,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
