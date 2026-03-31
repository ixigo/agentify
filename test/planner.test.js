import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db.js";
import { buildExecutionPlan } from "../src/core/planner.js";

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
