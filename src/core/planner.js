import fs from "node:fs/promises";
import path from "node:path";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { getRepoMeta } from "./db/metadata-store.js";
import {
  loadCommands,
  loadFiles,
  loadModuleDependencies,
  loadModules,
  loadSymbols,
  loadTests,
} from "./db/structural-store.js";
import { loadSemanticModuleDependencies, loadSemanticPlannerFacts } from "./db/semantic-store.js";
import { getChangedFiles } from "./git.js";
import { stripLeadingAgentifyHeader } from "./headers.js";
import { isSemanticEnabled } from "./semantic.js";

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

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function createExecutionBudget(config) {
  const planner = config?.planner || {};
  const maxAdditionalReadsBeforeEdit = planner.maxAdditionalReadsBeforeEdit ?? planner.max_additional_reads_before_edit;
  const maxWidenings = planner.maxWidenings ?? planner.max_widenings;
  const editAfterSelectedContextUnlessBlocked = planner.editAfterSelectedContextUnlessBlocked ?? planner.edit_after_selected_context_unless_blocked;
  return normalizeExecutionBudget({
    max_additional_reads_before_edit: maxAdditionalReadsBeforeEdit,
    max_widenings: maxWidenings,
    edit_after_selected_context_unless_blocked: editAfterSelectedContextUnlessBlocked,
  });
}

function normalizeExecutionBudget(executionBudget = {}) {
  return {
    max_additional_reads_before_edit: nonNegativeInteger(executionBudget.max_additional_reads_before_edit, 4),
    max_widenings: nonNegativeInteger(executionBudget.max_widenings, 1),
    edit_after_selected_context_unless_blocked: executionBudget.edit_after_selected_context_unless_blocked !== false,
  };
}

export const PLAN_EXPLAIN_COMPONENTS = Object.freeze([
  "lexical_token_match",
  "dependency_proximity",
  "semantic_contribution",
  "recency_changed_file_boost",
  "structural_signal",
]);

const PLAN_EXPLAIN_COMPONENT_LABELS = Object.freeze({
  lexical_token_match: "lexical/token match",
  dependency_proximity: "dependency proximity",
  semantic_contribution: "semantic contribution",
  recency_changed_file_boost: "recency/changed-file boost",
  structural_signal: "structural signal",
});

function pushReason(reasons, reason, points, metadata = {}) {
  reasons.push({
    reason,
    points,
    code: metadata.code,
    component: metadata.component || "structural_signal",
    detail: metadata.detail || null,
    legacy: metadata.legacy !== false,
  });
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
      pushReason(reasons, `direct module name match: ${token}`, 120, {
        code: "lexical.module.direct_name_match",
        component: "lexical_token_match",
        detail: { token },
      });
    } else if (name.includes(token) || rootPath.includes(token) || packageName.includes(token)) {
      score += 50;
      pushReason(reasons, `module/path match: ${token}`, 50, {
        code: "lexical.module.path_match",
        component: "lexical_token_match",
        detail: { token },
      });
    }
  }

  if (taskText.includes(moduleInfo.root_path.toLowerCase())) {
    score += 90;
    pushReason(reasons, `task mentions module path ${moduleInfo.root_path}`, 90, {
      code: "lexical.module.path_mentioned",
      component: "lexical_token_match",
      detail: { path: moduleInfo.root_path },
    });
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
      pushReason(reasons, `direct file match: ${token}`, 120, {
        code: "lexical.file.direct_path_match",
        component: "lexical_token_match",
        detail: { token },
      });
    } else if (normalizedPath.includes(token) || basename.includes(token)) {
      score += 42;
      pushReason(reasons, `file/path match: ${token}`, 42, {
        code: "lexical.file.path_match",
        component: "lexical_token_match",
        detail: { token },
      });
    }
  }

  const symbolBoosts = symbolMatchesByFile.get(fileInfo.path) || { structural: 0, semantic: 0 };
  const symbolBoost = symbolBoosts.structural + symbolBoosts.semantic;
  if (symbolBoost > 0) {
    score += symbolBoost;
    if (symbolBoosts.structural > 0) {
      pushReason(reasons, "matching symbols in file", symbolBoosts.structural, {
        code: "structural.file.matching_symbols",
        component: "structural_signal",
      });
    }
    if (symbolBoosts.semantic > 0) {
      pushReason(reasons, "matching symbols in file", symbolBoosts.semantic, {
        code: "semantic.file.matching_symbols",
        component: "semantic_contribution",
      });
    }
  }
  if (fileInfo.is_key_file) {
    score += 28;
    pushReason(reasons, "key file", 28, {
      code: "structural.file.key_file",
      component: "structural_signal",
    });
  }
  if (fileInfo.is_entrypoint) {
    score += 24;
    pushReason(reasons, "entrypoint", 24, {
      code: "structural.file.entrypoint",
      component: "structural_signal",
    });
  }
  if (fileInfo.is_config) {
    score += 12;
    pushReason(reasons, "config file", 12, {
      code: "structural.file.config_file",
      component: "structural_signal",
    });
  }
  if (fileInfo.is_test) {
    score -= 8;
    pushReason(reasons, "test file penalty", -8, {
      code: "structural.file.test_penalty",
      component: "structural_signal",
      legacy: false,
    });
  }
  if (changedPaths.has(fileInfo.path)) {
    score += 36;
    pushReason(reasons, "recently changed", 36, {
      code: "recency.file.changed_file",
      component: "recency_changed_file_boost",
      detail: { path: fileInfo.path },
    });
  }
  if (taskText.includes(fileInfo.path.toLowerCase())) {
    score += 100;
    pushReason(reasons, `task mentions file path ${fileInfo.path}`, 100, {
      code: "lexical.file.path_mentioned",
      component: "lexical_token_match",
      detail: { path: fileInfo.path },
    });
  }

  const moduleScore = fileInfo.module_id ? (moduleScoreById.get(fileInfo.module_id) || 0) : 0;
  if (moduleScore > 0) {
    const moduleBoost = Math.max(8, Math.min(30, Math.round(moduleScore / 6)));
    score += moduleBoost;
    pushReason(reasons, "inside a selected high-signal module", moduleBoost, {
      code: "dependency.file.selected_module_proximity",
      component: "dependency_proximity",
      detail: { module_id: fileInfo.module_id },
    });
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
  const semanticSymbol = symbolInfo.source && symbolInfo.source !== "structural";
  const matchComponent = semanticSymbol ? "semantic_contribution" : "lexical_token_match";
  const codePrefix = semanticSymbol ? "semantic.symbol" : "lexical.symbol";
  for (const token of tokens) {
    for (const term of terms) {
      if (term === token) {
        score += 130;
        pushReason(reasons, `direct symbol match: ${token}`, 130, {
          code: `${codePrefix}.direct_name_match`,
          component: matchComponent,
          detail: { token },
        });
        break;
      }
      if (term.includes(token) || token.includes(term)) {
        score += 60;
        pushReason(reasons, `symbol match: ${token}`, 60, {
          code: `${codePrefix}.name_match`,
          component: matchComponent,
          detail: { token },
        });
        break;
      }
    }
  }
  if (taskText.includes(String(symbolInfo.name || "").toLowerCase()) || taskText.includes(String(symbolInfo.alias || "").toLowerCase())) {
    score += 90;
    pushReason(reasons, `task mentions symbol ${symbolInfo.name}`, 90, {
      code: `${codePrefix}.mentioned`,
      component: matchComponent,
      detail: { name: symbolInfo.name },
    });
  }
  if (symbolInfo.exported) {
    score += 12;
    pushReason(reasons, "exported symbol", 12, {
      code: "structural.symbol.exported",
      component: "structural_signal",
      legacy: false,
    });
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
      pushReason(neighbor.reasons, `dependency of matched module ${moduleInfo.id}`, points, {
        code: "dependency.module.depends_on_matched_module",
        component: "dependency_proximity",
        detail: { module_id: moduleInfo.id },
      });
    }

    for (const neighborId of depInfo.usedBy) {
      const neighbor = moduleById.get(neighborId);
      if (!neighbor) {
        continue;
      }
      const points = Math.max(10, Math.min(22, Math.round(moduleInfo.score * 0.12)));
      neighbor.score += points;
      pushReason(neighbor.reasons, `used by matched module ${moduleInfo.id}`, points, {
        code: "dependency.module.used_by_matched_module",
        component: "dependency_proximity",
        detail: { module_id: moduleInfo.id },
      });
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
  const executionBudget = normalizeExecutionBudget(plan.execution_budget);
  const editStartRule = executionBudget.edit_after_selected_context_unless_blocked
    ? "After checking the selected context, start editing unless you can name a concrete blocker that prevents a correct edit."
    : "Use judgment on when to start editing, while still respecting the discovery limits below.";
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

  return `You are working in a repository prepared by Agentify. Use the selected context first and start editing once that context is enough for a correct change.

Execution rules:
- Prefer the selected file slices and generated markdown docs before running new discovery commands.
- Do not invoke nested \`agentify plan\`, \`agentify query\`, or raw SQLite inspection from inside the provider session unless the selected context is insufficient; those host-side artifacts may be unavailable in sandboxed providers.
- Discovery budget before the first edit: at most ${executionBudget.max_additional_reads_before_edit} additional file or doc reads, and at most ${executionBudget.max_widenings} widening step(s) outside the selected context.
- ${editStartRule}
- Before each widening step, declare \`INSUFFICIENT_CONTEXT: blocker=<specific missing fact>; needed=<specific file, symbol, or doc>; reads_used=<n>; widenings_used=<n>\`.
- If you still need more context within the budget, read \`AGENTIFY.md\`, \`docs/repo-map.md\`, and \`docs/modules/*.md\` before widening further.

Task:
${plan.task}

Planner summary:
- Confidence: ${plan.confidence}
- Modules selected: ${plan.selected_modules.length}
- Files selected: ${plan.selected_files.length}
- Symbols selected: ${plan.selected_symbols.length}
- Prompt bytes: ${plan.prompt_bytes}
- Max additional reads before edit: ${executionBudget.max_additional_reads_before_edit}
- Max widenings: ${executionBudget.max_widenings}
- Edit after selected context unless blocked: ${executionBudget.edit_after_selected_context_unless_blocked}

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

function legacyReason(reason) {
  return {
    reason: reason.reason,
    points: reason.points,
  };
}

function stripExplainReasonMetadata(item) {
  return {
    ...item,
    reasons: item.reasons
      .filter((reason) => reason.legacy !== false)
      .map(legacyReason),
  };
}

function createEmptyComponentTotals() {
  return Object.fromEntries(PLAN_EXPLAIN_COMPONENTS.map((component) => [component, 0]));
}

function toExplainReason(reason) {
  const result = {
    code: reason.code,
    component: reason.component,
    points: reason.points,
    reason: reason.reason,
  };
  if (reason.detail && Object.keys(reason.detail).length > 0) {
    result.detail = reason.detail;
  }
  return result;
}

function addScoreBreakdown(item) {
  const components = createEmptyComponentTotals();
  const reasons = item.reasons.map(toExplainReason);
  for (const reason of reasons) {
    components[reason.component] = (components[reason.component] || 0) + reason.points;
  }
  const componentTotal = Object.values(components).reduce((sum, points) => sum + points, 0);
  return {
    ...item,
    reasons,
    score_breakdown: {
      total: item.score,
      components,
      unexplained: item.score - componentTotal,
    },
  };
}

function preparePlanForOutput(plan, { explain = false } = {}) {
  if (explain) {
    return {
      ...plan,
      explain: {
        schema_version: 1,
        reason_code_format: "namespace.entity.reason",
        components: PLAN_EXPLAIN_COMPONENTS.map((component) => ({
          code: component,
          label: PLAN_EXPLAIN_COMPONENT_LABELS[component],
        })),
      },
      selected_modules: plan.selected_modules.map(addScoreBreakdown),
      selected_files: plan.selected_files.map(addScoreBreakdown),
      selected_symbols: plan.selected_symbols.map(addScoreBreakdown),
    };
  }

  return {
    ...plan,
    selected_modules: plan.selected_modules.map(stripExplainReasonMetadata),
    selected_files: plan.selected_files.map(stripExplainReasonMetadata),
    selected_symbols: plan.selected_symbols.map(stripExplainReasonMetadata),
  };
}

function formatSignedPoints(points) {
  return points >= 0 ? `+${points}` : String(points);
}

function renderScoreComponents(scoreBreakdown) {
  return PLAN_EXPLAIN_COMPONENTS
    .map((component) => `${PLAN_EXPLAIN_COMPONENT_LABELS[component]}=${scoreBreakdown.components[component]}`)
    .join(", ");
}

function renderExplanationItem(label, title, item) {
  const lines = [
    `- ${label}: ${title}`,
    `  score: ${item.score}; ${renderScoreComponents(item.score_breakdown)}`,
  ];
  if (item.score_breakdown.unexplained !== 0) {
    lines.push(`  unexplained: ${item.score_breakdown.unexplained}`);
  }
  for (const reason of item.reasons) {
    lines.push(`  ${formatSignedPoints(reason.points)} ${reason.code} (${PLAN_EXPLAIN_COMPONENT_LABELS[reason.component]}): ${reason.reason}`);
  }
  return lines.join("\n");
}

export function renderPlanExplanation(plan) {
  const lines = [
    "Agentify plan explanation",
    `Task: ${plan.task}`,
    `Confidence: ${plan.confidence}`,
    `Reason schema: v${plan.explain?.schema_version || 1} (${plan.explain?.reason_code_format || "namespace.entity.reason"})`,
    "",
    "Modules:",
  ];

  if (plan.selected_modules.length === 0) {
    lines.push("- none");
  } else {
    for (const item of plan.selected_modules) {
      lines.push(renderExplanationItem("module", `${item.id} (${item.root_path})`, item));
    }
  }

  lines.push("", "Files:");
  if (plan.selected_files.length === 0) {
    lines.push("- none");
  } else {
    for (const item of plan.selected_files) {
      lines.push(renderExplanationItem("file", item.path, item));
    }
  }

  lines.push("", "Symbols:");
  if (plan.selected_symbols.length === 0) {
    lines.push("- none");
  } else {
    for (const item of plan.selected_symbols) {
      lines.push(renderExplanationItem("symbol", `${item.name} (${item.kind}) in ${item.file_path}`, item));
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function buildExecutionPlan(root, config, task, options = {}) {
  const budgets = createPlannerBudget(config);
  const executionBudget = createExecutionBudget(config);
  const taskText = String(task || "").trim();
  const normalizedTask = taskText.toLowerCase();
  const tokens = tokenizeTask(taskText);
  const changedFiles = await getChangedFiles(root);
  const changedPaths = new Set(changedFiles.map((item) => item.path));
  const db = openIndexDatabase(options.artifactRoot || root, { readOnly: true });

  try {
    const meta = getRepoMeta(db);
    const modules = loadModules(db);
    const files = loadFiles(db);
    const structuralSymbols = loadSymbols(db).map((symbolInfo) => ({
      ...symbolInfo,
      alias: null,
      source: "structural",
    }));
    const semanticEnabled = isSemanticEnabled(config);
    const semanticSymbols = semanticEnabled
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
      const current = symbolMatchesByFile.get(symbolInfo.file_path) || { structural: 0, semantic: 0 };
      const key = symbolInfo.source && symbolInfo.source !== "structural" ? "semantic" : "structural";
      current[key] += Math.min(symbolInfo.score, 90);
      symbolMatchesByFile.set(symbolInfo.file_path, current);
    }

    const moduleDependencyMap = new Map();
    const baseModuleScores = modules
      .map((moduleInfo) => {
        const base = scoreModule(moduleInfo, normalizedTask, tokens);
        const matchingModuleSymbols = symbolScores.filter((symbolInfo) => symbolInfo.module_id === moduleInfo.id);
        const structuralSymbolBoost = matchingModuleSymbols
          .filter((symbolInfo) => !symbolInfo.source || symbolInfo.source === "structural")
          .reduce((sum, symbolInfo) => sum + Math.min(symbolInfo.score, 50), 0);
        const semanticSymbolBoost = matchingModuleSymbols
          .filter((symbolInfo) => symbolInfo.source && symbolInfo.source !== "structural")
          .reduce((sum, symbolInfo) => sum + Math.min(symbolInfo.score, 50), 0);
        const symbolBoost = structuralSymbolBoost + semanticSymbolBoost;
        const structuralDep = loadModuleDependencies(db, moduleInfo.id);
        const semanticDep = semanticEnabled
          ? loadSemanticModuleDependencies(db, moduleInfo.id)
          : { dependsOn: [], usedBy: [] };
        const dep = {
          dependsOn: Array.from(new Set([...(structuralDep.dependsOn || []), ...(semanticDep.dependsOn || [])])),
          usedBy: Array.from(new Set([...(structuralDep.usedBy || []), ...(semanticDep.usedBy || [])])),
        };
        moduleDependencyMap.set(moduleInfo.id, dep);
        const score = base.score + symbolBoost;
        const reasons = [...base.reasons];
        if (structuralSymbolBoost > 0) {
          pushReason(reasons, "matching symbols inside module", structuralSymbolBoost, {
            code: "structural.module.matching_symbols",
            component: "structural_signal",
          });
        }
        if (semanticSymbolBoost > 0) {
          pushReason(reasons, "matching symbols inside module", semanticSymbolBoost, {
            code: "semantic.module.matching_symbols",
            component: "semantic_contribution",
          });
        }
        if (changedFiles.some((fileInfo) => fileInfo.path && isPathInsideModule(fileInfo.path, moduleInfo.root_path))) {
          pushReason(reasons, "module contains changed files", 24, {
            code: "recency.module.contains_changed_files",
            component: "recency_changed_file_boost",
          });
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
      execution_budget: executionBudget,
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
        `Before the first edit, use at most ${executionBudget.max_additional_reads_before_edit} additional file or doc reads and ${executionBudget.max_widenings} widening step(s).`,
        "If the selected context is insufficient, declare the specific blocker before widening.",
      ],
    };

    const outputPlan = preparePlanForOutput(plan, { explain: options.explain === true });
    let prompt = renderExecutionPrompt({
      ...outputPlan,
      prompt_bytes: 0,
    });
    outputPlan.prompt_bytes = bytes(prompt);
    prompt = renderExecutionPrompt(outputPlan);
    outputPlan.prompt = prompt;
    outputPlan.prompt_bytes = bytes(prompt);
    return outputPlan;
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
