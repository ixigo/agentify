import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db/connection.js";
import { writeRepositoryIndex } from "../src/core/db/structural-store.js";
import {
  queryCallers,
  queryDef,
  queryImpacts,
  queryRefs,
  querySearch,
} from "../src/core/query.js";

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

function file(pathValue) {
  return {
    path: pathValue,
    module_id: null,
    language: "typescript",
    size_bytes: 64,
    fingerprint: `fp-${pathValue}`,
    is_test: 0,
    is_config: 0,
    is_entrypoint: 0,
    is_key_file: 0,
  };
}

function symbol(filePath, name, kind = "function", exported = 1) {
  return {
    module_id: null,
    file_path: filePath,
    name,
    kind,
    exported,
    start_line: 1,
    end_line: 3,
  };
}

function importEdge(fromPath, toPath, specifier, kind = "esm") {
  return {
    from_path: fromPath,
    to_path: toPath,
    specifier,
    kind,
    from_module_id: null,
    to_module_id: null,
  };
}

async function writeStructuralQueryFixture(root) {
  const db = openIndexDatabase(root);
  try {
    writeRepositoryIndex(db, {
      repo: {
        name: "fixture",
        root,
        detected_stacks: ["ts"],
        default_stack: "ts",
        package_manager: "npm",
      },
      generated_at: "2026-05-04T00:00:00.000Z",
      modules: [],
      files: [
        file("src/auth/useAuth.ts"),
        file("src/app/dashboard/page.tsx"),
        file("src/app/settings/page.tsx"),
        file("src/types/user.ts"),
        file("src/a/format.ts"),
        file("src/b/format.ts"),
      ],
      symbols: [
        symbol("src/auth/useAuth.ts", "useAuth"),
        symbol("src/app/dashboard/page.tsx", "DashboardPage"),
        symbol("src/app/settings/page.tsx", "SettingsPage"),
        symbol("src/types/user.ts", "User", "type"),
        symbol("src/a/format.ts", "formatValue"),
        symbol("src/b/format.ts", "formatValue"),
      ],
      imports: [
        importEdge("src/app/dashboard/page.tsx", "src/auth/useAuth.ts", "../../auth/useAuth"),
        importEdge("src/app/settings/page.tsx", "src/app/dashboard/page.tsx", "../dashboard/page"),
        importEdge("src/app/dashboard/page.tsx", "src/types/user.ts", "../../types/user"),
      ],
      tests: [],
      commands: [],
    }, { headCommit: "fixturehead", provider: "local" });
  } finally {
    closeIndexDatabase(db);
  }
}

test("structural query commands resolve definitions, refs, callers, and impacts deterministically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-structural-"));
  await writeStructuralQueryFixture(root);

  const definition = await queryDef(root, "useAuth");
  const references = await queryRefs(root, "User");
  const callers = await queryCallers(root, "useAuth");
  const impacts = await queryImpacts(root, "src/auth/useAuth.ts", { depth: 3 });
  const repeatedImpacts = await queryImpacts(root, "src/auth/useAuth.ts", { depth: 3 });
  const ambiguous = await queryDef(root, "formatValue");

  assert.equal(definition.symbol, "useAuth");
  assert.equal(definition.ambiguous, false);
  assert.equal(definition.definitions.length, 1);
  assert.equal(definition.definitions[0].file_path, "src/auth/useAuth.ts");
  assert.equal(definition.definitions[0].name, "useAuth");
  assert.equal(definition.definitions[0].exported, 1);

  // References are structural import edges into the defining file.
  assert.equal(references.references.length, 1);
  assert.equal(references.references[0].kind, "import:esm");
  assert.equal(references.references[0].file_path, "src/app/dashboard/page.tsx");
  assert.equal(references.references[0].imports, "src/types/user.ts");
  assert.equal(references.references[0].specifier, "../../types/user");

  assert.equal(callers.callers[0].file_path, "src/app/dashboard/page.tsx");
  assert.equal(callers.callers[0].kind, "import:esm");

  assert.deepEqual(impacts.impacts.map((impact) => [impact.file_path, impact.depth]), [
    ["src/app/dashboard/page.tsx", 1],
    ["src/app/settings/page.tsx", 2],
  ]);
  const firstVia = impacts.impacts[0].via[0];
  assert.equal(firstVia.kind, "import:esm");
  assert.equal(firstVia.from_file_path, "src/app/dashboard/page.tsx");
  assert.equal(firstVia.to_file_path, "src/auth/useAuth.ts");
  assert.equal(firstVia.specifier, "../../auth/useAuth");
  assert.deepEqual(repeatedImpacts, impacts);

  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.definitions.map((item) => item.file_path), [
    "src/a/format.ts",
    "src/b/format.ts",
  ]);
});

test("querySearch no longer returns semantic entities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-search-"));
  await writeStructuralQueryFixture(root);

  const result = await querySearch(root, "useAuth");
  assert.equal(result.term, "useAuth");
  assert.ok(Array.isArray(result.symbols));
  assert.ok(Array.isArray(result.files));
  assert.ok(Array.isArray(result.modules));
  assert.equal(result.semantic_entities, undefined);
  assert.equal(result.semantic_surfaces, undefined);
});
