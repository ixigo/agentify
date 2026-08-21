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
      // Call-site rows (schema 3.2): TS-defined symbols answer refs/callers
      // from these; a TS symbol with none returns an EMPTY call-site answer.
      symbol_refs: [
        { symbol_name: "User", from_path: "src/app/dashboard/page.tsx", line: 4, kind: "reference" },
        { symbol_name: "useAuth", from_path: "src/app/dashboard/page.tsx", line: 9, kind: "call" },
        // A same-named call in a file that does NOT import the defining file
        // (an unrelated local `useAuth`): must be scoped OUT of callers.
        { symbol_name: "useAuth", from_path: "src/b/format.ts", line: 2, kind: "call" },
        // A property invocation (`session.useAuth()`) in an importing file:
        // receiver bindings are not resolved, so method-call rows must never
        // count as callers (PR #373 review: set.add() vs an imported add) —
        // they surface through refs instead.
        { symbol_name: "useAuth", from_path: "src/app/dashboard/page.tsx", line: 14, kind: "method-call" },
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

  // TS-defined symbols answer at call-site granularity from symbol_refs,
  // scoped to files that import (or contain) a definition.
  assert.equal(references.granularity, "call-site");
  assert.equal(references.references.length, 1);
  assert.equal(references.references[0].kind, "reference");
  assert.equal(references.references[0].file_path, "src/app/dashboard/page.tsx");
  assert.equal(references.references[0].line, 4);

  assert.equal(callers.granularity, "call-site");
  assert.equal(callers.callers.length, 1, "scoped-out same-name call and method-call must not count as callers");
  assert.equal(callers.callers[0].file_path, "src/app/dashboard/page.tsx");
  assert.equal(callers.callers[0].kind, "call");
  assert.equal(callers.callers[0].line, 9);

  // The property invocation still surfaces through refs, labeled method-call.
  const useAuthRefs = await queryRefs(root, "useAuth");
  assert.ok(useAuthRefs.references.some((ref) => ref.kind === "method-call" && ref.line === 14));

  // A TS-defined symbol the AST never saw referenced returns an EMPTY
  // call-site answer — never its module's importers (review finding).
  const unreferenced = await queryCallers(root, "DashboardPage");
  assert.equal(unreferenced.granularity, "call-site");
  assert.deepEqual(unreferenced.callers, []);

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

async function scanRepo(root) {
  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);
}

test("callers/refs report real TS call sites — same-file exports have distinct callers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-callsite-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "lib.ts"),
    "export function foo() { return 1; }\nexport function bar() { return 2; }\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src", "usesFoo.ts"),
    "import { foo } from \"./lib\";\nexport function runFoo() {\n  return foo();\n}\n",
    "utf8",
  );
  // References foo (const held = foo — NOT a call) and calls bar().
  await fs.writeFile(
    path.join(root, "src", "usesBar.ts"),
    "import { bar, foo } from \"./lib\";\nexport function runBar() {\n  const held = foo;\n  return bar() + (held ? 0 : 1);\n}\n",
    "utf8",
  );
  await scanRepo(root);

  const fooCallers = await queryCallers(root, "foo");
  const barCallers = await queryCallers(root, "bar");

  // The regression this task fixes: callers of foo differ from callers of bar
  // even though both are exported from the same file.
  assert.equal(fooCallers.granularity, "call-site");
  assert.equal(barCallers.granularity, "call-site");
  assert.ok(fooCallers.callers.every((row) => row.kind === "call"));
  assert.deepEqual(
    fooCallers.callers.map((row) => [row.file_path, row.line]),
    [["src/usesFoo.ts", 3]],
  );
  assert.deepEqual(
    barCallers.callers.map((row) => [row.file_path, row.line]),
    [["src/usesBar.ts", 4]],
  );

  // Kind separation: the `const held = foo` use is a reference, not a call. It
  // shows up in refs but never in callers.
  const fooRefs = await queryRefs(root, "foo");
  assert.equal(fooRefs.granularity, "call-site");
  const referenceUse = fooRefs.references.find(
    (row) => row.kind === "reference" && row.file_path === "src/usesBar.ts" && row.line === 3,
  );
  assert.ok(referenceUse, "the non-call use of foo appears in refs");
  assert.ok(
    !fooCallers.callers.some((row) => row.file_path === "src/usesBar.ts" && row.line === 3),
    "the non-call use of foo must NOT appear in callers",
  );
});

test("callers/refs fall back to file-import edges for non-TS languages, honestly labeled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-query-fallback-"));
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"demo\"\n", "utf8");
  await fs.writeFile(
    path.join(root, "b.py"),
    "def thing():\n    return 1\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "a.py"),
    "from b import thing\n\n\ndef run():\n    return thing()\n",
    "utf8",
  );
  await scanRepo(root);

  const refs = await queryRefs(root, "thing");
  const callers = await queryCallers(root, "thing");

  assert.equal(refs.granularity, "file-import");
  assert.equal(callers.granularity, "file-import");
  assert.match(refs.note, /file-level import edges/i);
  // The importing file is reported (file-level), and no per-call line number.
  assert.ok(refs.references.some((row) => row.file_path === "a.py"));
  assert.ok(refs.references.every((row) => row.line === undefined));
  assert.ok(callers.callers.some((row) => row.file_path === "a.py"));
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
