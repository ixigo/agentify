import fs from "node:fs/promises";
import path from "node:path";

import {
  closeIndexDatabase,
  getRepoMeta,
  loadCommands,
  loadFiles,
  loadModuleDependencies,
  loadSemanticModuleDependencies,
  loadSemanticPlannerFacts,
  loadModules,
  loadSymbols,
  loadTests,
  openIndexDatabase,
} from "./db.js";
import { getChangedFiles } from "./git.js";
import { stripLeadingAgentifyHeader } from "./headers.js";

function bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_./-]+/g, "");
}

function tokenizeTask(task) {
  return Array.from(new Set(
    String(task || "")
      .split(/\s+/)
      .map(normalizeToken)
      .filter((token) => token.length >= 2)
  ));
}

function createPlannerBudget(config) {
  return {
    maxModules: config?.planner?.maxModules || 6,
    maxFiles: config?.planner?.maxFiles || 12,
    maxSymbols: config?.planner?.maxSymbols || 24,
    maxTests: config?.planner?.maxTests || 6,
    maxSourceBytes: config?.planner?.maxSourceBytes || 24000,
    maxInstructionBytes: config?.planner?.maxInstructionBytes || 6000,
  };
}

function pushReason(reasons, reason, points) {
  reasons.push({ reason, points });
}

function scoreModule(moduleInfo, taskText, tokens) {
  let score = 0;
  const reasons = [];
  const name = normalizeToken(moduleInfo.name);
  const rootPath = normalizeToken(moduleInfo.root_path);
  const packageName = normalizeToken(moduleInfo.package_name || "");

  for (const token of tokens) {
    if (name === token || packageName === token) {
      score += 120;
      pushReason(reasons, `direct module name match: ${token}`, 120);
    } else if (name.includes(token) || rootPath.includes(token) || packageName.includes(token)) {
      score += 50;
      pushReason(reasons, `module/path match: ${token}`, 50);
    }
  }

  if (taskText.includes(moduleInfo.root_path.toLowerCase())) {
    score += 90;
    pushReason(reasons, `task mentions module path ${moduleInfo.root_path}`, 90);
  }

  return { score, reasons };
}

function scoreFile(fileInfo, taskText, tokens, changedPaths, symbolMatchesByFile, moduleScoreById) {
  let score = 0;
  const reasons = [];
  const normalizedPath = normalizeToken(fileInfo.path);
  const basename = normalizeToken(path.basename(fileInfo.path));

  for (const token of tokens) {
    if (normalizedPath === token || basename === token) {
      score += 120;
      pushReason(reasons, `direct file match: ${token}`, 120);
    } else if (normalizedPath.includes(token) || basename.includes(token)) {
      score += 42;
      pushReason(reasons, `file/path match: ${token}`, 42);
    }
  }

  const symbolBoost = symbolMatchesByFile.get(fileInfo.path) || 0;
  if (symbolBoost > 0) {
    score += symbolBoost;
    pushReason(reasons, "matching symbols in file", symbolBoost);
  }
  if (fileInfo.is_key_file) {
    score += 28;
    pushReason(reasons, "key file", 28);
  }
  if (fileInfo.is_entrypoint) {
    score += 24;
    pushReason(reasons, "entrypoint", 24);
  }
  if (fileInfo.is_config) {
    score += 12;
    pushReason(reasons, "config file", 12);
  }
  if (fileInfo.is_test) {
    score -= 8;
  }
  if (changedPaths.has(fileInfo.path)) {
    score += 36;
    pushReason(reasons, "recently changed", 36);
  }
  if (taskText.includes(fileInfo.path.toLowerCase())) {
    score += 100;
    pushReason(reasons, `task mentions file path ${fileInfo.path}`, 100);
  }

  const moduleScore = fileInfo.module_id ? (moduleScoreById.get(fileInfo.module_id) || 0) : 0;
  if (moduleScore > 0) {
    const moduleBoost = Math.max(8, Math.min(30, Math.round(moduleScore / 6)));
    score += moduleBoost;
    pushReason(reasons, "inside a selected high-signal module", moduleBoost);
  }

  return { score, reasons };
}

function scoreSymbol(symbolInfo, taskText, tokens) {
  let score = 0;
  const reasons = [];
  const terms = Array.from(new Set([
    normalizeToken(symbolInfo.name),
    normalizeToken(symbolInfo.alias || ""),
  ].filter(Boolean)));
  for (const token of tokens) {
    for (const term of terms) {
      if (term === token) {
        score += 130;
        pushReason(reasons, `direct symbol match: ${token}`, 130);
        break;
      }
      if (term.includes(token) || token.includes(term)) {
        score += 60;
        pushReason(reasons, `symbol match: ${token}`, 60);
        break;
      }
    }
  }
  if (taskText.includes(String(symbolInfo.name || "").toLowerCase()) || taskText.includes(String(symbolInfo.alias || "").toLowerCase())) {
    score += 90;
    pushReason(reasons, `task mentions symbol ${symbolInfo.name}`, 90);
  }
  if (symbolInfo.exported) {
    score += 12;
  }
  return { score, reasons };
}

function computeConfidence(selectedModules, selectedFiles, selectedSymbols) {
  const moduleScore = selectedModules.reduce((sum, item) => sum + item.score, 0);
  const fileScore = selectedFiles.reduce((sum, item) => sum + item.score, 0);
  const symbolScore = selectedSymbols.reduce((sum, item) => sum + item.score, 0);
  const raw = moduleScore * 0.35 + fileScore * 0.45 + symbolScore * 0.2;
  return Number(Math.max(0.1, Math.min(0.99, raw / 500)).toFixed(2));
}

function applyDependencyBoosts(moduleScores, dependencyMap) {
  const moduleById = new Map(moduleScores.map((moduleInfo) => [moduleInfo.id, moduleInfo]));
  const directMatches = moduleScores.filter((moduleInfo) => moduleInfo.score > 0);

  for (const moduleInfo of directMatches) {
    const depInfo = dependencyMap.get(moduleInfo.id) || { dependsOn: [], usedBy: [] };

    for (const neighborId of depInfo.dependsOn) {
      const neighbor = moduleById.get(neighborId);
      if (!neighbor) {
        continue;
      }
      const points = Math.max(14, Math.min(34, Math.round(moduleInfo.score * 0.18)));
      neighbor.score += points;
      pushReason(neighbor.reasons, `dependency of matched module ${moduleInfo.id}`, points);
    }

    for (const neighborId of depInfo.usedBy) {
      const neighbor = moduleById.get(neighborId);
      if (!neighbor) {
        continue;
      }
      const points = Math.max(10, Math.min(22, Math.round(moduleInfo.score * 0.12)));
      neighbor.score += points;
      pushReason(neighbor.reasons, `used by matched module ${moduleInfo.id}`, points);
    }
  }

  return moduleScores;
}

async function readFileExcerpt(root, filePath, symbols, budgetBytes) {
  const absolutePath = path.join(root, filePath);
  let content = stripLeadingAgentifyHeader(await fs.readFile(absolutePath, "utf8"));

  if (symbols.length > 0) {
    const lines = content.split(/\r?\n/);
    const first = Math.max(1, Math.min(...symbols.map((item) => item.start_line)) - 8);
    const last = Math.min(lines.length, Math.max(...symbols.map((item) => item.end_line)) + 20);
    content = lines.slice(first - 1, last).join("\n");
  }

  if (bytes(content) <= budgetBytes) {
    return content;
  }

  let end = content.length;
  while (end > 0) {
    const candidate = `${content.slice(0, end).trimEnd()}\n...`;
    if (bytes(candidate) <= budgetBytes) {
      return candidate;
    }
    end -= 1;
  }

  return "";
}

function dedupeCommands(commands) {
  const seen = new Set();
  const result = [];
  for (const commandInfo of commands) {
    const key = `${commandInfo.command}:${commandInfo.args.join(" ")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(commandInfo);
  }
  return result;
}

export function renderExecutionPrompt(plan) {
  const moduleLines = plan.selected_modules.length > 0
    ? plan.selected_modules.map((item) => `- ${item.id} (${item.root_path})`).join("\n")
    : "- none";
  const symbolLines = plan.selected_symbols.length > 0
    ? plan.selected_symbols.map((item) => `- ${item.name} (${item.kind}) in ${item.file_path}`).join("\n")
    : "- none";
  const fileBlocks = plan.selected_files.length > 0
    ? plan.selected_files.map((item) => `FILE: ${item.path}\nREASONS: ${item.reasons.map((reason) => reason.reason).join("; ")}\n\`\`\`\n${item.excerpt}\n\`\`\``).join("\n\n")
    : "No source files selected.";
  const testLines = plan.related_tests.length > 0
    ? plan.related_tests.map((item) => `- ${item.file_path}${item.related_path ? ` (targets ${item.related_path})` : ""}`).join("\n")
    : "- none";
  const commandLines = plan.verification_commands.length > 0
    ? plan.verification_commands.map((item) => `- ${item.command} ${item.args.join(" ")}`.trim()).join("\n")
    : "- none";

  return `You are working in a repository prepared by Agentify. Use the selected context first and avoid broad repo scans unless the context is clearly insufficient.

Task:
${plan.task}

Planner summary:
- Confidence: ${plan.confidence}
- Modules selected: ${plan.selected_modules.length}
- Files selected: ${plan.selected_files.length}
- Symbols selected: ${plan.selected_symbols.length}
- Prompt bytes: ${plan.prompt_bytes}

Likely modules:
${moduleLines}

Relevant symbols:
${symbolLines}

Related tests:
${testLines}

Verification commands:
${commandLines}

Selected file slices:
${fileBlocks}`;
}

export async function buildExecutionPlan(root, config, task, options = {}) {
  const budgets = createPlannerBudget(config);
  const taskText = String(task || "").trim();
  const normalizedTask = taskText.toLowerCase();
  const tokens = tokenizeTask(taskText);
  const changedFiles = await getChangedFiles(root);
  const changedPaths = new Set(changedFiles.map((item) => item.path));
  const db = openIndexDatabase(options.artifactRoot || root);

  try {
    const meta = getRepoMeta(db);
    const modules = loadModules(db);
    const files = loadFiles(db);
    const structuralSymbols = loadSymbols(db).map((symbolInfo) => ({
      ...symbolInfo,
      alias: null,
      source: "structural",
    }));
    const semanticSymbols = config.semantic?.tsjs?.enabled
      ? loadSemanticPlannerFacts(db).map((symbolInfo) => ({
          symbol_id: symbolInfo.semantic_id,
          module_id: symbolInfo.module_id || null,
          file_path: symbolInfo.file_path,
          name: symbolInfo.name,
          kind: symbolInfo.kind,
          exported: symbolInfo.exported,
          start_line: symbolInfo.start_line,
          end_line: symbolInfo.end_line,
          alias: symbolInfo.alias || null,
          source: symbolInfo.source,
        }))
      : [];
    const semanticCoveredFiles = new Set(semanticSymbols.map((symbolInfo) => symbolInfo.file_path));
    const symbols = [
      ...structuralSymbols.filter((symbolInfo) => !semanticCoveredFiles.has(symbolInfo.file_path)),
      ...semanticSymbols,
    ];
    const tests = loadTests(db);
    const commands = loadCommands(db);

    const symbolScores = symbols
      .map((symbolInfo) => ({ ...symbolInfo, ...scoreSymbol(symbolInfo, normalizedTask, tokens) }))
      .filter((symbolInfo) => symbolInfo.score > 0)
      .sort((left, right) => right.score - left.score || left.file_path.localeCompare(right.file_path))
      .slice(0, budgets.maxSymbols);

    const symbolMatchesByFile = new Map();
    for (const symbolInfo of symbolScores) {
      symbolMatchesByFile.set(
        symbolInfo.file_path,
        (symbolMatchesByFile.get(symbolInfo.file_path) || 0) + Math.min(symbolInfo.score, 90)
      );
    }

    const moduleDependencyMap = new Map();
    const baseModuleScores = modules
      .map((moduleInfo) => {
        const base = scoreModule(moduleInfo, normalizedTask, tokens);
        const symbolBoost = symbolScores
          .filter((symbolInfo) => symbolInfo.module_id === moduleInfo.id)
          .reduce((sum, symbolInfo) => sum + Math.min(symbolInfo.score, 50), 0);
        const structuralDep = loadModuleDependencies(db, moduleInfo.id);
        const semanticDep = config.semantic?.tsjs?.enabled
          ? loadSemanticModuleDependencies(db, moduleInfo.id)
          : { dependsOn: [], usedBy: [] };
        const dep = {
          dependsOn: Array.from(new Set([...(structuralDep.dependsOn || []), ...(semanticDep.dependsOn || [])])),
          usedBy: Array.from(new Set([...(structuralDep.usedBy || []), ...(semanticDep.usedBy || [])])),
        };
        moduleDependencyMap.set(moduleInfo.id, dep);
        const score = base.score + symbolBoost;
        const reasons = [...base.reasons];
        if (symbolBoost > 0) {
          pushReason(reasons, "matching symbols inside module", symbolBoost);
        }
        if (changedFiles.some((fileInfo) => fileInfo.path && isPathInsideModule(fileInfo.path, moduleInfo.root_path))) {
          pushReason(reasons, "module contains changed files", 24);
          return {
            ...moduleInfo,
            score: score + 24,
            reasons,
            depends_on: dep.dependsOn,
            used_by: dep.usedBy,
          };
        }
        return {
          ...moduleInfo,
          score,
          reasons,
          depends_on: dep.dependsOn,
          used_by: dep.usedBy,
        };
      })
      .map((moduleInfo) => ({ ...moduleInfo, direct_score: moduleInfo.score }));

    const moduleScores = applyDependencyBoosts(baseModuleScores, moduleDependencyMap)
      .filter((moduleInfo) => moduleInfo.score > 0 || modules.length <= budgets.maxModules)
      .sort((left, right) => right.score - left.score || left.root_path.localeCompare(right.root_path))
      .slice(0, budgets.maxModules);

    const moduleIds = new Set(moduleScores.map((item) => item.id));
    const selectedModuleScores = new Map(moduleScores.map((item) => [item.id, item.score]));
    const fileScores = files
      .filter((fileInfo) => fileInfo.module_id === null || moduleIds.has(fileInfo.module_id))
      .map((fileInfo) => ({
        ...fileInfo,
        ...scoreFile(fileInfo, normalizedTask, tokens, changedPaths, symbolMatchesByFile, selectedModuleScores),
      }))
      .filter((fileInfo) => fileInfo.score > 0 || fileInfo.is_key_file || fileInfo.is_entrypoint)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    const selectedFiles = [];
    let usedSourceBytes = 0;
    for (const fileInfo of fileScores) {
      if (selectedFiles.length >= budgets.maxFiles) {
        break;
      }
      const relatedSymbols = symbolScores.filter((symbolInfo) => symbolInfo.file_path === fileInfo.path);
      const remainingBudget = budgets.maxSourceBytes - usedSourceBytes;
      if (remainingBudget <= 0) {
        break;
      }
      try {
        const excerpt = await readFileExcerpt(root, fileInfo.path, relatedSymbols, Math.min(remainingBudget, config?.budgets?.perFile || 8000));
        if (!excerpt) {
          continue;
        }
        const excerptBytes = bytes(excerpt);
        selectedFiles.push({
          ...fileInfo,
          excerpt,
          excerpt_bytes: excerptBytes,
          reasons: fileInfo.reasons,
        });
        usedSourceBytes += excerptBytes;
      } catch {
        // Ignore unreadable files.
      }
    }

    const selectedFilePaths = new Set(selectedFiles.map((item) => item.path));
    const selectedTests = tests
      .filter((testInfo) => {
        if (testInfo.module_id && moduleIds.has(testInfo.module_id)) {
          return true;
        }
        return testInfo.related_path && selectedFilePaths.has(testInfo.related_path);
      })
      .slice(0, budgets.maxTests);

    const verificationCommands = dedupeCommands(
      commands.filter((commandInfo) => !commandInfo.module_id || moduleIds.has(commandInfo.module_id))
    ).slice(0, 6);

    const selectedSymbols = symbolScores.filter((symbolInfo) => selectedFilePaths.has(symbolInfo.file_path));
    const confidence = computeConfidence(moduleScores, selectedFiles, selectedSymbols);
    const plan = {
      task: taskText,
      repo: {
        name: meta.repo_name || path.basename(root),
        root,
        default_stack: meta.default_stack || "ts",
        head_commit: meta.head_commit || "unknown",
        generated_at: meta.generated_at || null,
      },
      budgets,
      confidence,
      selected_modules: moduleScores,
      selected_files: selectedFiles,
      selected_symbols: selectedSymbols,
      related_tests: selectedTests,
      verification_commands: verificationCommands,
      changed_files: changedFiles,
      constraints: [
        "Prefer editing the selected modules and files before widening context.",
        "Run the listed verification commands after changes when relevant.",
        "If the selected context is insufficient, widen carefully instead of rescanning the whole repo first.",
      ],
    };

    let prompt = renderExecutionPrompt({
      ...plan,
      prompt_bytes: 0,
    });
    plan.prompt_bytes = bytes(prompt);
    prompt = renderExecutionPrompt(plan);
    plan.prompt = prompt;
    plan.prompt_bytes = bytes(prompt);
    return plan;
  } finally {
    closeIndexDatabase(db);
  }
}

function isPathInsideModule(filePath, moduleRoot) {
  if (!moduleRoot || moduleRoot === ".") {
    return true;
  }
  return filePath === moduleRoot || filePath.startsWith(`${moduleRoot}/`);
}
