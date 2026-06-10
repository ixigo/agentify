import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { runScan } from "../src/core/commands.js";
import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, openIndexDatabase } from "../src/core/db/connection.js";
import {
  loadFiles,
  loadModules,
  loadSymbols,
  searchIndex,
  writeRepositoryIndex,
} from "../src/core/db/structural-store.js";

const require = createRequire(import.meta.url);

function octalMode(stats) {
  return (stats.mode & 0o777).toString(8);
}

function explainDetails(db, sql, ...params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    .map((row) => String(row.detail || ""))
    .join("\n");
}

test("openIndexDatabase read-only opens source database without snapshot when possible", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-readonly-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "station.ts"),
    "export function findMetroStation(query) { return query.trim(); }\n",
    "utf8",
  );

  const config = await loadConfig(root, { provider: "local", dryRun: false });
  await runScan(root, config);

  const db = openIndexDatabase(root, { readOnly: true });
  try {
    assert.equal(db.__agentifyTempDir, undefined);
    const row = db.prepare("SELECT COUNT(*) AS count FROM files").get();
    assert.ok(row.count > 0);
  } finally {
    closeIndexDatabase(db);
  }
});

test("openIndexDatabase read-only fallback snapshots valid databases without initializing them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-readonly-fallback-"));
  const writeDb = openIndexDatabase(root);
  try {
    writeDb.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
      .run("fixture_marker", JSON.stringify("source"));
  } finally {
    closeIndexDatabase(writeDb);
  }

  const dbPath = path.join(root, ".agentify", "index.db");
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    sqlite = null;
  }
  const OriginalDatabaseSync = sqlite?.DatabaseSync;
  const betterSqlitePath = require.resolve("better-sqlite3");
  const betterSqliteCache = require.cache[betterSqlitePath];
  const originalBetterSqlite = betterSqliteCache?.exports;

  // Simulate the narrow case where the source cannot be opened read-only but its copied snapshot can be read.
  if (sqlite) {
    sqlite.DatabaseSync = function DatabaseSync(filename, options) {
      if (filename === dbPath && options?.readOnly) {
        throw new Error("simulated node:sqlite source open failure");
      }
      return new OriginalDatabaseSync(filename, options);
    };
  }
  if (betterSqliteCache) {
    betterSqliteCache.exports = function BetterSqlite3(filename, options) {
      if (filename === dbPath && options?.readonly) {
        throw new Error("simulated better-sqlite3 source open failure");
      }
      return new originalBetterSqlite(filename, options);
    };
  }

  let db;
  let tempDir;
  try {
    db = openIndexDatabase(root, { readOnly: true });
    tempDir = db.__agentifyTempDir;
    assert.ok(tempDir);
    const marker = db.prepare("SELECT value_json FROM repo_meta WHERE key = ?")
      .get("fixture_marker");
    assert.equal(marker.value_json, JSON.stringify("source"));

    const snapshotPath = path.join(tempDir, "index.db");
    assert.equal(octalMode(await fs.stat(tempDir)), "700");
    assert.equal(octalMode(await fs.stat(snapshotPath)), "600");

    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${snapshotPath}${suffix}`;
      const exists = await fs.access(sidecarPath).then(() => true).catch(() => false);
      if (exists) {
        assert.equal(octalMode(await fs.stat(sidecarPath)), "600");
      }
    }
  } finally {
    if (sqlite) {
      sqlite.DatabaseSync = OriginalDatabaseSync;
    }
    if (betterSqliteCache) {
      betterSqliteCache.exports = originalBetterSqlite;
    }
    if (db) {
      closeIndexDatabase(db);
    }
  }

  await assert.rejects(() => fs.access(tempDir));
});

test("openIndexDatabase read-only rejects blank index database instead of initializing a snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-readonly-"));
  const dbDir = path.join(root, ".agentify");
  const dbPath = path.join(dbDir, "index.db");
  await fs.mkdir(dbDir, { recursive: true });
  await fs.writeFile(dbPath, "");

  assert.throws(
    () => openIndexDatabase(root, { readOnly: true }),
    /invalid index database at .*index\.db: no such table: repo_meta/,
  );

  assert.equal((await fs.stat(dbPath)).size, 0);
});

test("openIndexDatabase read-only rejects corrupt index database instead of initializing a snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-readonly-"));
  const dbDir = path.join(root, ".agentify");
  await fs.mkdir(dbDir, { recursive: true });
  await fs.writeFile(path.join(dbDir, "index.db"), "not sqlite", "utf8");

  assert.throws(
    () => openIndexDatabase(root, { readOnly: true }),
    /invalid index database at .*index\.db: file is not a database/,
  );
});

test("openIndexDatabase read-only rejects unsupported index schema version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-readonly-"));
  const db = openIndexDatabase(root);
  try {
    db.prepare("UPDATE repo_meta SET value_json = ? WHERE key = 'schema_version'")
      .run(JSON.stringify("0.1"));
  } finally {
    closeIndexDatabase(db);
  }

  assert.throws(
    () => openIndexDatabase(root, { readOnly: true }),
    /invalid index database at .*index\.db: index database schema version 0\.1 is not supported; expected 3\.1/,
  );
});

test("structural store writes and searches repository index data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-db-structural-"));
  const db = openIndexDatabase(root);
  try {
    writeRepositoryIndex(db, {
      repo: {
        name: "fixture",
        root,
        detected_stacks: ["ts"],
        default_stack: "ts",
        package_manager: "pnpm",
      },
      generated_at: "2026-04-27T00:00:00.000Z",
      modules: [{
        id: "app",
        name: "App",
        root_path: "src",
        stack: "ts",
        package_name: "fixture",
        slug: "app",
        doc_path: "docs/modules/app.md",
        fingerprint: "module-fingerprint",
        entry_files: ["src/index.ts"],
        key_files: ["src/index.ts"],
      }],
      files: [
        {
          path: "src/index.ts",
          module_id: "app",
          language: "typescript",
          size_bytes: 42,
          fingerprint: "file-fingerprint",
          is_test: 0,
          is_config: 0,
          is_entrypoint: 1,
          is_key_file: 1,
        },
        {
          path: "src/index.test.ts",
          module_id: "app",
          language: "typescript",
          size_bytes: 21,
          fingerprint: "test-fingerprint",
          is_test: 1,
          is_config: 0,
          is_entrypoint: 0,
          is_key_file: 0,
        },
      ],
      symbols: [{
        module_id: "app",
        file_path: "src/index.ts",
        name: "startApp",
        kind: "function",
        exported: 1,
        start_line: 1,
        end_line: 3,
      }],
      imports: [],
      tests: [{
        file_path: "src/index.test.ts",
        module_id: "app",
        framework: "node:test",
        related_path: "src/index.ts",
      }],
      commands: [{
        module_id: "app",
        command_type: "test",
        command: "pnpm",
        args: ["test"],
      }],
    }, { headCommit: "abc123", provider: "local" });

    assert.equal(loadModules(db)[0].id, "app");
    assert.equal(loadFiles(db, "app").length, 2);
    assert.equal(loadSymbols(db, "app")[0].name, "startApp");
    assert.equal(searchIndex(db, "start").symbols[0].name, "startApp");
    assert.equal(searchIndex(db, "APP").symbols[0].name, "startApp");

    const plan = explainDetails(db, `
      SELECT name, kind, file_path, module_id, exported
      FROM query_search_fts search
      JOIN symbols ON symbols.symbol_id = CAST(search.entity_id AS INTEGER)
      WHERE search.entity_type = 'symbol'
        AND search.search_text LIKE ? ESCAPE '\\'
      ORDER BY file_path, start_line
      LIMIT ?
    `, "%start%", 20);
    assert.match(plan, /VIRTUAL TABLE/i);
    assert.doesNotMatch(plan, /SCAN symbols/i);
  } finally {
    closeIndexDatabase(db);
  }
});
