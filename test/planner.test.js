import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db.js";
import { buildExecutionPlan, renderExecutionPrompt } from "../src/core/planner.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

function assertExplainBreakdown(item) {
  assert.equal(item.score_breakdown.total, item.score);
  assert.equal(item.score_breakdown.unexplained, 0);
  for (const reason of item.reasons) {
    assert.match(reason.code, /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/);
    assert.match(reason.component, /^[a-z]+(?:_[a-z]+)*$/);
    assert.equal(typeof reason.points, "number");
  }
}

test("planner prioritizes extracted Python symbols", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-python-plan-"));
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"python-plan\"\n", "utf8");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "auth", "__init__.py"), "", "utf8");
  await fs.writeFile(
    path.join(root, "src", "auth", "service.py"),
    `class AuthService:\n    def parse_token(self, raw_token: str) -> str:\n        return raw_token.strip()\n\n\ndef normalize_token(raw_token: str) -> str:\n    return raw_token.lower()\n`,
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const plan = await buildExecutionPlan(root, config, "fix parse_token edge cases");

  assert.ok(plan.selected_symbols.some((symbolInfo) => symbolInfo.name === "parse_token"));
  assert.ok(plan.selected_files.some((fileInfo) => fileInfo.path === "src/auth/service.py"));
});

test("planner uses extracted Go symbols to select the right file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-go-query-"));
  await fs.writeFile(path.join(root, "go.mod"), "module example.com/agentify-go\n\ngo 1.22\n", "utf8");
  await fs.mkdir(path.join(root, "cmd", "server"), { recursive: true });
  await fs.writeFile(
    path.join(root, "cmd", "server", "auth.go"),
    `package server\n\nimport "strings"\n\ntype AuthService struct{}\n\nfunc ParseToken(raw string) string {\n\treturn strings.TrimSpace(raw)\n}\n`,
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const result = await buildExecutionPlan(root, config, "fix ParseToken trimming");

  assert.ok(result.selected_symbols.some((symbolInfo) => symbolInfo.name === "ParseToken"));
  assert.ok(result.selected_files.some((fileInfo) => fileInfo.path === "cmd/server/auth.go"));
});

test("index resolves Python relative imports to concrete files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-python-imports-"));
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"python-imports\"\n", "utf8");
  await fs.mkdir(path.join(root, "src", "demo", "api"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "demo", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "demo", "__init__.py"), "", "utf8");
  await fs.writeFile(path.join(root, "src", "demo", "api", "__init__.py"), "", "utf8");
  await fs.writeFile(path.join(root, "src", "demo", "auth", "__init__.py"), "", "utf8");
  await fs.writeFile(
    path.join(root, "src", "demo", "api", "handler.py"),
    "from ..auth.service import parse_token\n\n\ndef handle_login(raw_token: str) -> str:\n    return parse_token(raw_token)\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src", "demo", "auth", "service.py"),
    "def parse_token(raw_token: str) -> str:\n    return raw_token.strip()\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const db = openIndexDatabase(root);
  try {
    const imports = db.prepare(`
      SELECT from_path, to_path, specifier
      FROM imports
      WHERE from_path = ?
      ORDER BY import_id
    `).all("src/demo/api/handler.py");

    assert.ok(imports.some((entry) => entry.specifier === "..auth.service" && entry.to_path === "src/demo/auth/service.py"));
  } finally {
    closeIndexDatabase(db);
  }
});

test("planner pulls in Go dependency modules under tight module budgets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-go-neighbors-"));
  await fs.writeFile(path.join(root, "go.mod"), "module example.com/agentify-go\n\ngo 1.22\n", "utf8");
  await fs.mkdir(path.join(root, "cmd", "server"), { recursive: true });
  await fs.mkdir(path.join(root, "internal", "auth"), { recursive: true });
  await fs.mkdir(path.join(root, "pkg", "billing"), { recursive: true });
  await fs.mkdir(path.join(root, "pkg", "ui"), { recursive: true });
  await fs.writeFile(
    path.join(root, "cmd", "server", "handler.go"),
    `package main

import "example.com/agentify-go/internal/auth"

func HandleLogin(raw string) string {
	return auth.ParseToken(raw)
}
`,
    "utf8",
  );
  await fs.writeFile(path.join(root, "cmd", "server", "main.go"), "package main\n\nfunc main() {}\n", "utf8");
  await fs.writeFile(
    path.join(root, "internal", "auth", "token.go"),
    "package auth\n\nfunc ParseToken(raw string) string { return raw }\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "pkg", "billing", "client.go"),
    "package billing\n\nfunc Charge() error { return nil }\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "pkg", "ui", "view.go"),
    "package ui\n\nfunc Render() string { return \"ok\" }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  config.planner = {
    ...config.planner,
    maxModules: 2,
    maxFiles: 4,
  };
  await runScan(root, config);

  const plan = await buildExecutionPlan(root, config, "fix HandleLogin error handling");

  assert.ok(plan.selected_modules.some((moduleInfo) => moduleInfo.root_path === "cmd/server"));
  assert.ok(plan.selected_modules.some((moduleInfo) => moduleInfo.root_path === "internal/auth"));
  assert.ok(plan.selected_files.some((fileInfo) => fileInfo.path === "internal/auth/token.go"));
});

test("planner uses a read-only index and warns providers away from nested Agentify commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-plan-readonly-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    "export function describeEntryPoint() { return 'app'; }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const dbPath = path.join(root, ".agents", "index.db");
  const dbDir = path.join(root, ".agents");
  await fs.chmod(dbPath, 0o444);
  await fs.chmod(dbDir, 0o555);

  try {
    const plan = await buildExecutionPlan(root, config, "summarize the app entry point");
    assert.ok(plan.selected_files.some((fileInfo) => fileInfo.path === "src/app.ts"));
    assert.match(plan.prompt, /Do not invoke nested `agentify plan`, `agentify query`, or raw SQLite inspection/);
    assert.match(plan.prompt, /AGENTIFY\.md/);
  } finally {
    await fs.chmod(dbDir, 0o755);
    await fs.chmod(dbPath, 0o644);
  }
});

test("planner surfaces explicit discovery budget and edit-start contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-plan-execution-budget-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "runner.ts"),
    "export function runTask() { return 'ok'; }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  config.planner = {
    ...config.planner,
    maxAdditionalReadsBeforeEdit: 2,
    maxWidenings: 0,
    editAfterSelectedContextUnlessBlocked: true,
  };
  await runScan(root, config);

  const plan = await buildExecutionPlan(root, config, "fix runTask error handling");

  assert.deepEqual(plan.execution_budget, {
    max_additional_reads_before_edit: 2,
    max_widenings: 0,
    edit_after_selected_context_unless_blocked: true,
  });
  assert.ok(plan.constraints.some((constraint) => constraint.includes("at most 2 additional file or doc reads and 0 widening step(s)")));
  assert.match(plan.prompt, /Discovery budget before the first edit: at most 2 additional file or doc reads, and at most 0 widening step\(s\)/);
  assert.match(plan.prompt, /INSUFFICIENT_CONTEXT: blocker=<specific missing fact>; needed=<specific file, symbol, or doc>; reads_used=<n>; widenings_used=<n>/);
  assert.match(plan.prompt, /Edit after selected context unless blocked: true/);
});

test("planner explain mode emits stable reason codes and complete score breakdowns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-plan-explain-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "auth", "service.js"),
    "export function loginUser(rawToken) {\n  return rawToken.trim();\n}\n",
    "utf8",
  );
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);
  await fs.appendFile(path.join(root, "src", "auth", "service.js"), "\nexport const loginVersion = 1;\n", "utf8");

  const plan = await buildExecutionPlan(root, config, "fix loginUser in src/auth/service.js", { explain: true });
  const file = plan.selected_files.find((fileInfo) => fileInfo.path === "src/auth/service.js");
  const symbol = plan.selected_symbols.find((symbolInfo) => symbolInfo.name === "loginUser");

  assert.equal(plan.explain.schema_version, 1);
  assert.ok(plan.explain.components.some((component) => component.code === "lexical_token_match"));
  assert.ok(file);
  assert.ok(symbol);

  for (const item of [...plan.selected_modules, ...plan.selected_files, ...plan.selected_symbols]) {
    assertExplainBreakdown(item);
  }

  assert.equal(file.score_breakdown.components.recency_changed_file_boost, 36);
  assert.ok(file.reasons.some((reason) => reason.code === "recency.file.changed_file"));
  assert.ok(file.reasons.some((reason) => reason.code === "dependency.file.selected_module_proximity"));
  assert.ok(symbol.reasons.some((reason) => reason.code === "structural.symbol.exported"));
});

test("renderExecutionPrompt uses discovery budget defaults when older plans omit them", () => {
  const prompt = renderExecutionPrompt({
    task: "update docs",
    confidence: 0.5,
    prompt_bytes: 0,
    selected_modules: [],
    selected_symbols: [],
    selected_files: [],
    related_tests: [],
    verification_commands: [],
  });

  assert.match(prompt, /Discovery budget before the first edit: at most 4 additional file or doc reads, and at most 1 widening step\(s\)/);
  assert.match(prompt, /INSUFFICIENT_CONTEXT: blocker=<specific missing fact>/);
});
