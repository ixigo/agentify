import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { runDoc, runScan } from "../src/core/commands.js";
import {
  closeIndexDatabase,
  listSemanticProjects,
  loadSemanticReactSurfaces,
  loadSemanticRouteSurfaces,
  openIndexDatabase,
} from "../src/core/db.js";
import { buildExecutionPlan } from "../src/core/planner.js";
import { queryDeps, queryOwner, querySearch } from "../src/core/query.js";
import { runSemanticRefresh } from "../src/core/semantic.js";
import { setSilent } from "../src/core/ui.js";

async function writeSemanticFixture(root) {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "semantic-fixture",
  }, null, 2));
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      jsx: "react-jsx",
      allowJs: true,
      module: "esnext",
      moduleResolution: "bundler",
      target: "es2022",
    },
    include: ["src/**/*"],
  }, null, 2));
  await fs.mkdir(path.join(root, "src", "app", "dashboard"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "auth", "useAuth.tsx"),
    "export function useAuth() { return true; }\n"
  );
  await fs.writeFile(
    path.join(root, "src", "app", "dashboard", "page.tsx"),
    [
      "import { useAuth } from '../../auth/useAuth';",
      "",
      "export default function DashboardPage() {",
      "  useAuth();",
      "  return <main>Dashboard</main>;",
      "}",
      "",
    ].join("\n")
  );
}

async function writeLayeredSemanticFixture(root) {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "semantic-layered-fixture",
  }, null, 2));
  await fs.writeFile(path.join(root, "tsconfig.base.json"), JSON.stringify({
    compilerOptions: {
      jsx: "react-jsx",
      allowJs: true,
      module: "esnext",
      moduleResolution: "bundler",
      target: "es2022",
      baseUrl: ".",
    },
  }, null, 2));
  await fs.writeFile(path.join(root, "tsconfig.app.json"), JSON.stringify({
    extends: "./tsconfig.base.json",
    include: ["src/**/*"],
    exclude: ["src/**/*.browser.test.tsx", "src/**/*.test.ts"],
  }, null, 2));
  await fs.writeFile(path.join(root, "tsconfig.test.browser.json"), JSON.stringify({
    extends: "./tsconfig.app.json",
    include: ["vitest.browser.setup.ts", "src/**/*", "src/**/*.browser.test.tsx", "test-extend.ts"],
    exclude: [],
    compilerOptions: {
      types: ["vitest/globals", "@vitest/browser"],
    },
  }, null, 2));
  await fs.writeFile(path.join(root, "tsconfig.test.unit.json"), JSON.stringify({
    extends: "./tsconfig.base.json",
    include: ["src/**/*.test.ts"],
    compilerOptions: {
      types: ["vitest/globals", "node"],
    },
  }, null, 2));
  await fs.mkdir(path.join(root, "src", "app", "dashboard"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(root, "vitest.browser.setup.ts"), "export const browserSetup = true;\n");
  await fs.writeFile(path.join(root, "test-extend.ts"), "export {};\n");
  await fs.writeFile(
    path.join(root, "src", "auth", "useAuth.tsx"),
    "export function useAuth() { return true; }\n"
  );
  await fs.writeFile(
    path.join(root, "src", "app", "dashboard", "page.tsx"),
    [
      "import { useAuth } from '../../auth/useAuth';",
      "",
      "export default function DashboardPage() {",
      "  useAuth();",
      "  return <main>Dashboard</main>;",
      "}",
      "",
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "src", "app", "dashboard", "page.browser.test.tsx"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import DashboardPage from './page';",
      "",
      "describe('DashboardPage', () => {",
      "  it('loads', () => {",
      "    expect(DashboardPage).toBeDefined();",
      "  });",
      "});",
      "",
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "src", "auth", "useAuth.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { useAuth } from './useAuth';",
      "",
      "describe('useAuth', () => {",
      "  it('returns true', () => {",
      "    expect(useAuth()).toBe(true);",
      "  });",
      "});",
      "",
    ].join("\n")
  );
}

test("semantic refresh indexes TS/JS projects and surfaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-semantic-refresh-"));
  await writeSemanticFixture(root);
  const config = await loadConfig(root, {
    provider: "local",
    dryRun: false,
    "semantic.tsjs.enabled": true,
  });

  await runSemanticRefresh(root, config, { silent: true, skipOutput: true });

  const db = openIndexDatabase(root);
  try {
    const projects = listSemanticProjects(db);
    const routes = loadSemanticRouteSurfaces(db);
    const reactSurfaces = loadSemanticReactSurfaces(db);

    assert.equal(projects.length, 1);
    assert.equal(projects[0].status, "ready");
    assert.match(routes[0].surface_key, /\/dashboard/);
    assert.ok(reactSurfaces.some((surface) => surface.display_name === "useAuth"));
  } finally {
    closeIndexDatabase(db);
  }
});

test("doc uses semantic repo map and deterministic semantic headers when enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-semantic-doc-"));
  await writeSemanticFixture(root);
  const config = await loadConfig(root, {
    provider: "local",
    dryRun: false,
    headers: true,
    "semantic.tsjs.enabled": true,
  });

  await runScan(root, config);
  await runDoc(root, config);

  const repoMap = await fs.readFile(path.join(root, "docs", "repo-map.md"), "utf8");
  const pageSource = await fs.readFile(path.join(root, "src", "app", "dashboard", "page.tsx"), "utf8");
  const appDoc = await fs.readFile(path.join(root, "docs", "modules", "app.md"), "utf8");

  assert.match(repoMap, /## Semantic Projects/);
  assert.match(repoMap, /## Routes/);
  assert.match(repoMap, /\/dashboard/);
  assert.match(pageSource, /schema: semantic-v1/);
  assert.match(pageSource, /surface: route/);
  assert.match(pageSource, /role: page/);
  assert.match(pageSource, /project: tsconfig\.json/);
  assert.match(appDoc, /## Semantic Surfaces/);
  assert.match(appDoc, /DashboardPage|\/dashboard/);
});

test("planner and query surface semantic TS/JS facts when enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-semantic-query-plan-"));
  await writeSemanticFixture(root);
  const config = await loadConfig(root, {
    provider: "local",
    dryRun: false,
    "semantic.tsjs.enabled": true,
  });

  await runScan(root, config);
  await runSemanticRefresh(root, config, { silent: true, skipOutput: true });

  const plan = await buildExecutionPlan(root, config, "fix /dashboard route auth flow");
  const search = await querySearch(root, "dashboard");
  const owner = await queryOwner(root, "src/app/dashboard/page.tsx");
  const deps = await queryDeps(root, "app");

  assert.ok(plan.selected_files.some((fileInfo) => fileInfo.path === "src/app/dashboard/page.tsx"));
  assert.ok(plan.selected_symbols.some((symbolInfo) => String(symbolInfo.name).includes("/dashboard")));
  assert.ok(search.semantic_surfaces.some((surface) => surface.surface_key === "/dashboard"));
  assert.ok(owner.semantic.surfaces.some((surface) => surface.surface_key === "/dashboard"));
  assert.ok(Array.isArray(deps.semantic_depends_on));
});

test("semantic refresh skips unchanged layered projects and avoids duplicate runtime surfaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-semantic-layered-"));
  await writeLayeredSemanticFixture(root);
  const config = await loadConfig(root, {
    provider: "local",
    dryRun: false,
    "semantic.tsjs.enabled": true,
  });

  const first = await runSemanticRefresh(root, config, { silent: true, skipOutput: true });
  const second = await runSemanticRefresh(root, config, { silent: true, skipOutput: true });

  const db = openIndexDatabase(root);
  try {
    const projects = listSemanticProjects(db);
    const routeSurfaces = loadSemanticRouteSurfaces(db).filter((surface) => surface.surface_key === "/dashboard");
    const reactSurfaces = loadSemanticReactSurfaces(db).filter((surface) => surface.display_name === "useAuth");

    assert.ok(first.refreshed_projects.length >= 2);
    assert.equal(second.refreshed_projects.length, 0);
    assert.ok(second.skipped_projects.length >= 2);
    assert.ok(projects.every((project) => project.config_path !== "tsconfig.base.json"));
    assert.equal(routeSurfaces.length, 1);
    assert.equal(reactSurfaces.length, 1);
  } finally {
    closeIndexDatabase(db);
  }
});

test("doc --json emits a single payload when semantic refresh is enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-semantic-doc-json-"));
  await writeSemanticFixture(root);
  const config = await loadConfig(root, {
    provider: "local",
    dryRun: false,
    json: true,
    "semantic.tsjs.enabled": true,
  });
  config._suppressProgress = true;

  const output = [];
  const originalLog = console.log;
  setSilent(true);
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runScan(root, config, { skipOutput: true });
    await runDoc(root, config);
  } finally {
    console.log = originalLog;
    setSilent(false);
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "doc");
});
