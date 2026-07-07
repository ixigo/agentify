import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildRiskReport } from "./risk.js";
import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadCommands, loadFiles, loadModules, loadTests } from "./db/structural-store.js";
import { resolveAgentifyPaths } from "./project-store.js";

const TEST_SCHEMA_VERSION = "test-select-v1";

function normalizePath(filePath) {
  return String(filePath || "").split(path.sep).join("/").replace(/^\.\//, "");
}

function shellQuote(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// npm swallows args unless separated with `--`; pnpm/yarn/bun forward them.
function appendFileArgs(command, args, testFiles) {
  const extra = command === "npm" ? ["--", ...testFiles] : [...testFiles];
  return [...args, ...extra];
}

async function readTestScript(root, moduleRoot) {
  try {
    const raw = await fs.readFile(path.join(root, moduleRoot || ".", "package.json"), "utf8");
    const script = JSON.parse(raw)?.scripts?.test;
    return typeof script === "string" ? script.trim() : null;
  } catch {
    return null;
  }
}

// `node --test <dir>` treats appended file paths as extra entry points and
// crashes on directory arguments, so scripts based on node's test runner are
// bypassed and the runner invoked directly with just the selected files.
// Other runners (jest, vitest, mocha) treat extra positional args as filters,
// where appending is safe.
function buildRunnerArgs(script, commandInfo, testFiles) {
  if (script && /^node\s+(--[\w-]+(=\S+)?\s+)*--test(\s|$)/.test(script)) {
    return { command: "node", args: ["--test", ...testFiles] };
  }
  return {
    command: commandInfo.command,
    args: appendFileArgs(commandInfo.command, commandInfo.args, testFiles),
  };
}

export async function buildTestSelection(root, options = {}) {
  const report = await buildRiskReport(root, options);

  const agentifyPaths = options.artifactPaths || await resolveAgentifyPaths(root, options.config || {});
  const db = openIndexDatabase(agentifyPaths, { readOnly: true });
  let tests;
  let files;
  let commands;
  let modules;
  try {
    tests = loadTests(db);
    files = loadFiles(db);
    commands = loadCommands(db);
    modules = loadModules(db);
  } finally {
    closeIndexDatabase(db);
  }
  const moduleRootById = new Map(modules.map((moduleInfo) => [moduleInfo.id, moduleInfo.root_path]));

  const changedSet = new Set(report.changed_files.map((item) => item.path));
  const impactedByPath = new Map(report.impacted.files.map((item) => [item.path, item]));
  const filesByPath = new Map(files.map((item) => [normalizePath(item.path), item]));

  const selected = new Map();
  function addTest(filePath, moduleId, reason) {
    const normalized = normalizePath(filePath);
    if (!normalized) {
      return;
    }
    const existing = selected.get(normalized);
    if (existing) {
      if (!existing.reasons.includes(reason)) {
        existing.reasons.push(reason);
      }
      return;
    }
    selected.set(normalized, {
      path: normalized,
      module_id: moduleId || filesByPath.get(normalized)?.module_id || null,
      reasons: [reason],
    });
  }

  for (const testInfo of tests) {
    const testPath = normalizePath(testInfo.file_path);
    const relatedPath = normalizePath(testInfo.related_path);
    if (changedSet.has(testPath)) {
      addTest(testPath, testInfo.module_id, "test file changed");
    } else if (impactedByPath.has(testPath)) {
      addTest(testPath, testInfo.module_id, "imports changed code");
    }
    if (relatedPath && (changedSet.has(relatedPath) || impactedByPath.has(relatedPath))) {
      addTest(testPath, testInfo.module_id, `covers ${relatedPath}`);
    }
  }

  // Impacted files flagged as tests but missing from the tests table.
  for (const impacted of report.impacted.files) {
    const fileInfo = filesByPath.get(impacted.path);
    if (fileInfo?.is_test && !selected.has(impacted.path)) {
      addTest(impacted.path, fileInfo.module_id, impacted.distance === 0 ? "test file changed" : "imports changed code");
    }
  }

  const selectedTests = [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));

  const testCommandsByModule = new Map();
  for (const commandInfo of commands) {
    if (commandInfo.command_type === "test") {
      testCommandsByModule.set(commandInfo.module_id, commandInfo);
    }
  }

  const groups = new Map();
  for (const testInfo of selectedTests) {
    const commandInfo = testCommandsByModule.get(testInfo.module_id) || testCommandsByModule.get(null) || null;
    const key = commandInfo ? `${commandInfo.command} ${JSON.stringify(commandInfo.args)}` : "(no runner)";
    if (!groups.has(key)) {
      groups.set(key, { commandInfo, module_id: testInfo.module_id, test_files: [] });
    }
    groups.get(key).test_files.push(testInfo.path);
  }

  const runGroups = (await Promise.all([...groups.values()].map(async (group) => {
    if (!group.commandInfo) {
      return {
        module_id: group.module_id,
        command: null,
        args: [],
        command_line: null,
        test_files: group.test_files,
        note: "No indexed test command for this module; run these files with your test runner.",
      };
    }
    const script = await readTestScript(root, moduleRootById.get(group.commandInfo.module_id) ?? ".");
    const runner = buildRunnerArgs(script, group.commandInfo, group.test_files);
    return {
      module_id: group.commandInfo.module_id,
      command: runner.command,
      args: runner.args,
      command_line: [runner.command, ...runner.args].map(shellQuote).join(" "),
      test_files: group.test_files,
    };
  }))).sort((left, right) => String(left.module_id).localeCompare(String(right.module_id)));

  const notes = [];
  if (report.changed_files.length === 0) {
    notes.push("No changed files detected; nothing to select.");
  } else if (selectedTests.length === 0) {
    notes.push("Changes detected but no related test files found in the index. Consider running the full suite.");
    for (const recommendation of report.prioritized_test_commands.slice(0, 3)) {
      notes.push(`Fallback: ${recommendation.command_line}`);
    }
  }

  return {
    schema_version: TEST_SCHEMA_VERSION,
    command: "test",
    since: options.since || null,
    changed_file_count: report.changed_files.length,
    impacted_file_count: report.impacted.files.length,
    selected_tests: selectedTests,
    run_groups: runGroups,
    risk: report.risk,
    notes,
  };
}

export async function runTestSelection(root, selection, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const results = [];
  for (const group of selection.run_groups) {
    if (!group.command) {
      results.push({ module_id: group.module_id, skipped: true, reason: group.note });
      continue;
    }
    const exitCode = await new Promise((resolve) => {
      const child = spawnImpl(group.command, group.args, {
        cwd: root,
        stdio: options.stdio || "inherit",
        shell: false,
      });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
    results.push({ module_id: group.module_id, command_line: group.command_line, exit_code: exitCode });
  }
  return {
    results,
    passed: results.every((item) => item.skipped || item.exit_code === 0),
  };
}

export function renderTestSelection(selection) {
  const lines = [];
  lines.push(`Selected tests: ${selection.selected_tests.length} file(s) from ${selection.changed_file_count} changed file(s)`);
  if (selection.since) {
    lines.push(`Since: ${selection.since}`);
  }
  if (selection.selected_tests.length > 0) {
    lines.push("");
    for (const testInfo of selection.selected_tests) {
      lines.push(`- ${testInfo.path} (${testInfo.reasons.join("; ")})`);
    }
  }
  if (selection.run_groups.length > 0) {
    lines.push("", "Run:");
    for (const group of selection.run_groups) {
      lines.push(group.command_line ? `- ${group.command_line}` : `- ${group.test_files.join(" ")} (${group.note})`);
    }
  }
  for (const note of selection.notes || []) {
    lines.push("", `Note: ${note}`);
  }
  return lines.join("\n");
}
