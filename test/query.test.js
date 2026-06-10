import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db/connection.js";
import { replaceSemanticProjectSnapshot } from "../src/core/db/semantic-store.js";
import { queryCallers, queryDef, queryImpacts, queryRefs, querySearch } from "../src/core/query.js";

test("querySearch reads an existing index when the database is read-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-readonly-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "station.ts"),
    "export function findMetroStation(query) { return query.trim(); }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const dbPath = path.join(root, ".agentify", "index.db");
  const dbDir = path.join(root, ".agentify");
  await fs.chmod(dbPath, 0o444);
  await fs.chmod(dbDir, 0o555);

  try {
    const result = await querySearch(root, "station");
    assert.ok(result.files.some((fileInfo) => fileInfo.path === "src/station.ts"));
  } finally {
    await fs.chmod(dbDir, 0o755);
    await fs.chmod(dbPath, 0o644);
  }
});

async function writeSemanticQueryFixture(root) {
  const db = openIndexDatabase(root);
  try {
    replaceSemanticProjectSnapshot(db, {
      project: {
        project_id: "config:tsconfig.json",
        config_path: "tsconfig.json",
        project_root: ".",
        inferred: 0,
        analyzer_version: "test",
        schema_version: "semantic-tsjs-1",
        status: "ready",
        coverage_ratio: 1,
        file_count: 6,
        symbol_count: 6,
        surface_count: 0,
        edge_count: 3,
        content_fingerprint: "content",
        public_fingerprint: "public",
        refreshed_at: "2026-05-04T00:00:00.000Z",
      },
      files: [
        {
          project_id: "config:tsconfig.json",
          file_path: "src/auth/useAuth.ts",
          domain: "runtime",
          is_header_target: 1,
        },
        {
          project_id: "config:tsconfig.json",
          file_path: "src/app/dashboard/page.tsx",
          domain: "runtime",
          is_header_target: 1,
        },
        {
          project_id: "config:tsconfig.json",
          file_path: "src/app/settings/page.tsx",
          domain: "runtime",
          is_header_target: 1,
        },
        { project_id: "config:tsconfig.json", file_path: "src/types/user.ts", domain: "runtime", is_header_target: 1 },
        { project_id: "config:tsconfig.json", file_path: "src/a/format.ts", domain: "runtime", is_header_target: 1 },
        { project_id: "config:tsconfig.json", file_path: "src/b/format.ts", domain: "runtime", is_header_target: 1 },
      ],
      symbols: [
        {
          symbol_id: "sym-use-auth",
          project_id: "config:tsconfig.json",
          file_path: "src/auth/useAuth.ts",
          name: "useAuth",
          display_name: "useAuth",
          kind: "function",
          export_name: "useAuth",
          start_line: 1,
          end_line: 3,
          is_exported: 1,
          is_default: 0,
          domain: "runtime",
        },
        {
          symbol_id: "sym-dashboard",
          project_id: "config:tsconfig.json",
          file_path: "src/app/dashboard/page.tsx",
          name: "DashboardPage",
          display_name: "DashboardPage",
          kind: "function",
          export_name: "default",
          start_line: 3,
          end_line: 7,
          is_exported: 1,
          is_default: 1,
          domain: "runtime",
        },
        {
          symbol_id: "sym-settings",
          project_id: "config:tsconfig.json",
          file_path: "src/app/settings/page.tsx",
          name: "SettingsPage",
          display_name: "SettingsPage",
          kind: "function",
          export_name: "default",
          start_line: 3,
          end_line: 7,
          is_exported: 1,
          is_default: 1,
          domain: "runtime",
        },
        {
          symbol_id: "sym-user",
          project_id: "config:tsconfig.json",
          file_path: "src/types/user.ts",
          name: "User",
          display_name: "User",
          kind: "type",
          export_name: "User",
          start_line: 1,
          end_line: 4,
          is_exported: 1,
          is_default: 0,
          domain: "runtime",
        },
        {
          symbol_id: "sym-format-a",
          project_id: "config:tsconfig.json",
          file_path: "src/a/format.ts",
          name: "formatValue",
          display_name: "formatValue",
          kind: "function",
          export_name: "formatValue",
          start_line: 1,
          end_line: 1,
          is_exported: 1,
          is_default: 0,
          domain: "runtime",
        },
        {
          symbol_id: "sym-format-b",
          project_id: "config:tsconfig.json",
          file_path: "src/b/format.ts",
          name: "formatValue",
          display_name: "formatValue",
          kind: "function",
          export_name: "formatValue",
          start_line: 1,
          end_line: 1,
          is_exported: 1,
          is_default: 0,
          domain: "runtime",
        },
      ],
      surfaces: [],
      symbolEdges: [
        {
          project_id: "config:tsconfig.json",
          from_symbol_id: "sym-dashboard",
          to_symbol_id: "sym-use-auth",
          from_file_path: "src/app/dashboard/page.tsx",
          to_file_path: "src/auth/useAuth.ts",
          edge_kind: "calls",
          edge_domain: "runtime",
          confidence: 0.9,
          source: "test",
        },
        {
          project_id: "config:tsconfig.json",
          from_symbol_id: "sym-settings",
          to_symbol_id: "sym-dashboard",
          from_file_path: "src/app/settings/page.tsx",
          to_file_path: "src/app/dashboard/page.tsx",
          edge_kind: "renders",
          edge_domain: "runtime",
          confidence: 0.9,
          source: "test",
        },
        {
          project_id: "config:tsconfig.json",
          from_symbol_id: "sym-dashboard",
          to_symbol_id: "sym-user",
          from_file_path: "src/app/dashboard/page.tsx",
          to_file_path: "src/types/user.ts",
          edge_kind: "references",
          edge_domain: "type",
          confidence: 0.8,
          source: "test",
        },
      ],
    });
  } finally {
    closeIndexDatabase(db);
  }
}

test("semantic LSP query commands resolve definitions, refs, callers, and impacts deterministically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-lsp-"));
  await writeSemanticQueryFixture(root);

  const definition = await queryDef(root, "useAuth");
  const references = await queryRefs(root, "User");
  const callers = await queryCallers(root, "useAuth");
  const impacts = await queryImpacts(root, "src/auth/useAuth.ts", { depth: 3 });
  const repeatedImpacts = await queryImpacts(root, "src/auth/useAuth.ts", { depth: 3 });
  const ambiguous = await queryDef(root, "formatValue");

  assert.equal(definition.ambiguous, false);
  assert.equal(definition.definitions[0].file_path, "src/auth/useAuth.ts");
  assert.equal(references.references[0].from.name, "DashboardPage");
  assert.equal(references.references[0].edge_kind, "references");
  assert.equal(callers.callers[0].name, "DashboardPage");
  assert.deepEqual(
    impacts.impacts.map((impact) => [impact.file_path, impact.depth]),
    [
      ["src/app/dashboard/page.tsx", 1],
      ["src/app/settings/page.tsx", 2],
    ],
  );
  assert.deepEqual(repeatedImpacts, impacts);
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(
    ambiguous.definitions.map((item) => item.file_path),
    ["src/a/format.ts", "src/b/format.ts"],
  );
});
