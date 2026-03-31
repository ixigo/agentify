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
import { runSemanticRefresh } from "../src/core/semantic.js";

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
    "semantic.tsjs.enabled": true,
  });

  await runScan(root, config);
  await runDoc(root, config);

  const repoMap = await fs.readFile(path.join(root, "docs", "repo-map.md"), "utf8");
  const pageSource = await fs.readFile(path.join(root, "src", "app", "dashboard", "page.tsx"), "utf8");

  assert.match(repoMap, /## Semantic Projects/);
  assert.match(repoMap, /## Routes/);
  assert.match(repoMap, /\/dashboard/);
  assert.match(pageSource, /schema: semantic-v1/);
  assert.match(pageSource, /surface: route/);
  assert.match(pageSource, /role: page/);
  assert.match(pageSource, /project: tsconfig\.json/);
});
