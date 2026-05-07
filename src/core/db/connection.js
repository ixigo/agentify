import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import process from "node:process";

import { createSearchSchema, refreshSearchIndexIfNeeded } from "./search-store.js";
import { toJson } from "./utils.js";

const require = createRequire(import.meta.url);
const DB_SCHEMA_VERSION = "3.1";
const SNAPSHOT_DIR_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o600;

let driver = null;

function openWithBetterSqlite3(filename, options = {}) {
  const BetterSqlite3 = require("better-sqlite3");
  return {
    name: "better-sqlite3",
    db: new BetterSqlite3(filename, {
      readonly: Boolean(options.readOnly),
      fileMustExist: Boolean(options.readOnly),
    }),
  };
}

function openWithNodeSqlite(filename, options = {}) {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function wrappedEmitWarning(warning, ...args) {
    const message = typeof warning === "string" ? warning : warning?.message;
    const warningType = typeof args[0] === "string" ? args[0] : warning?.name;
    if (
      warningType === "ExperimentalWarning"
      && String(message || "").includes("SQLite is an experimental feature")
    ) {
      return;
    }
    return originalEmitWarning.call(process, warning, ...args);
  };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } finally {
    process.emitWarning = originalEmitWarning;
  }

  return {
    name: "node:sqlite",
    db: new DatabaseSync(filename, options.readOnly ? { readOnly: true } : {}),
  };
}

export function getIndexDbPath(root) {
  return path.join(root, ".agentify", "index.db");
}

function createIndexSnapshot(dbPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-index-"));
  const snapshotPath = path.join(tempDir, "index.db");

  try {
    fs.chmodSync(tempDir, SNAPSHOT_DIR_MODE);
    fs.copyFileSync(dbPath, snapshotPath);
    fs.chmodSync(snapshotPath, SNAPSHOT_FILE_MODE);

    for (const suffix of ["-wal", "-shm"]) {
      const sourcePath = `${dbPath}${suffix}`;
      if (fs.existsSync(sourcePath)) {
        const snapshotSidecarPath = `${snapshotPath}${suffix}`;
        fs.copyFileSync(sourcePath, snapshotSidecarPath);
        fs.chmodSync(snapshotSidecarPath, SNAPSHOT_FILE_MODE);
      }
    }

    return { tempDir, snapshotPath };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function getErrorReason(error) {
  return error instanceof Error && error.message
    ? `: ${error.message}`
    : "";
}

function createInvalidIndexDatabaseError(dbPath, cause) {
  const error = new Error(
    `invalid index database at ${dbPath}${getErrorReason(cause)}. Rebuild the index with "agentify scan" or "agentify up".`
  );
  error.code = "AGENTIFY_INDEX_DATABASE_INVALID";
  error.cause = cause;
  return error;
}

function shouldUseReadOnlySnapshotFallback(error) {
  const message = error instanceof Error ? error.message : "";
  return error?.code === "SQLITE_READONLY"
    || error?.errcode === 1544
    || /attempt to write a readonly database|read-?only database/i.test(message);
}

function openDatabaseFile(dbPath, options = {}) {
  let implementation = driver;
  let db = null;

  if (implementation?.name === "better-sqlite3") {
    try {
      db = openWithBetterSqlite3(dbPath, options).db;
    } catch {
      implementation = null;
    }
  }

  if (!db && implementation?.name === "node:sqlite") {
    try {
      db = openWithNodeSqlite(dbPath, options).db;
    } catch {
      implementation = null;
    }
  }

  if (!db) {
    try {
      const opened = openWithBetterSqlite3(dbPath, options);
      implementation = { name: opened.name };
      db = opened.db;
    } catch {
      const opened = openWithNodeSqlite(dbPath, options);
      implementation = { name: opened.name };
      db = opened.db;
    }
  }

  driver = implementation;
  return { db, implementation };
}

function configureIndexConnection(db, implementation, { readOnly }) {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  if (readOnly) {
    const row = db.prepare("SELECT value_json FROM repo_meta WHERE key = 'schema_version' LIMIT 1").get();
    if (!row) {
      throw new Error("index database is missing schema_version metadata");
    }
    const schemaVersion = JSON.parse(row.value_json);
    if (schemaVersion !== DB_SCHEMA_VERSION) {
      throw new Error(`index database schema version ${schemaVersion} is not supported; expected ${DB_SCHEMA_VERSION}`);
    }
    return;
  }

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      stack TEXT NOT NULL,
      package_name TEXT,
      slug TEXT NOT NULL,
      doc_path TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      entry_files_json TEXT NOT NULL,
      key_files_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      module_id TEXT,
      language TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      is_test INTEGER NOT NULL DEFAULT 0,
      is_config INTEGER NOT NULL DEFAULT 0,
      is_entrypoint INTEGER NOT NULL DEFAULT 0,
      is_key_file INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS symbols (
      symbol_id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id TEXT,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
      FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS imports (
      import_id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_path TEXT NOT NULL,
      to_path TEXT,
      specifier TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_module_id TEXT,
      to_module_id TEXT,
      FOREIGN KEY (from_path) REFERENCES files(path) ON DELETE CASCADE,
      FOREIGN KEY (from_module_id) REFERENCES modules(id) ON DELETE CASCADE,
      FOREIGN KEY (to_module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tests (
      test_id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      module_id TEXT,
      framework TEXT NOT NULL,
      related_path TEXT,
      FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE,
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS commands (
      command_id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id TEXT,
      command_type TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_key TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL,
      scope TEXT,
      fingerprint TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      indexed_at TEXT NOT NULL,
      head_commit TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      module_count INTEGER NOT NULL,
      symbol_count INTEGER NOT NULL,
      import_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_projects (
      project_id TEXT PRIMARY KEY,
      config_path TEXT,
      project_root TEXT NOT NULL,
      inferred INTEGER NOT NULL DEFAULT 0,
      analyzer_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      status TEXT NOT NULL,
      coverage_ratio REAL NOT NULL DEFAULT 1,
      file_count INTEGER NOT NULL DEFAULT 0,
      symbol_count INTEGER NOT NULL DEFAULT 0,
      surface_count INTEGER NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      content_fingerprint TEXT NOT NULL,
      public_fingerprint TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS semantic_project_files (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      domain TEXT NOT NULL,
      is_header_target INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, file_path),
      FOREIGN KEY (project_id) REFERENCES semantic_projects(project_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS semantic_external_packages (
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, package_name),
      FOREIGN KEY (project_id) REFERENCES semantic_projects(project_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS semantic_symbols (
      symbol_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      export_name TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      is_exported INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      domain TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES semantic_projects(project_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS semantic_surfaces (
      surface_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      symbol_id TEXT,
      kind TEXT NOT NULL,
      role TEXT NOT NULL,
      surface_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      domain TEXT NOT NULL,
      is_header_target INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES semantic_projects(project_id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES semantic_symbols(symbol_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_symbol_edges (
      edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      from_symbol_id TEXT,
      to_symbol_id TEXT,
      from_file_path TEXT,
      to_file_path TEXT,
      to_external_package TEXT,
      edge_kind TEXT NOT NULL,
      edge_domain TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY (project_id) REFERENCES semantic_projects(project_id) ON DELETE CASCADE,
      FOREIGN KEY (from_symbol_id) REFERENCES semantic_symbols(symbol_id) ON DELETE SET NULL,
      FOREIGN KEY (to_symbol_id) REFERENCES semantic_symbols(symbol_id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_modules_root_path ON modules(root_path);
    CREATE INDEX IF NOT EXISTS idx_files_module_id ON files(module_id);
    CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
    CREATE INDEX IF NOT EXISTS idx_symbols_module_id ON symbols(module_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_imports_from_module_id ON imports(from_module_id);
    CREATE INDEX IF NOT EXISTS idx_imports_to_module_id ON imports(to_module_id);
    CREATE INDEX IF NOT EXISTS idx_tests_module_id ON tests(module_id);
    CREATE INDEX IF NOT EXISTS idx_commands_module_id ON commands(module_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_projects_status ON semantic_projects(status);
    CREATE INDEX IF NOT EXISTS idx_semantic_project_files_file_path ON semantic_project_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_semantic_symbols_file_path ON semantic_symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_semantic_symbols_project_id ON semantic_symbols(project_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_surfaces_file_path ON semantic_surfaces(file_path);
    CREATE INDEX IF NOT EXISTS idx_semantic_surfaces_kind ON semantic_surfaces(kind);
    CREATE INDEX IF NOT EXISTS idx_semantic_edges_project_id ON semantic_symbol_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_edges_to_symbol_id ON semantic_symbol_edges(to_symbol_id, edge_kind);
    CREATE INDEX IF NOT EXISTS idx_semantic_edges_from_file_path ON semantic_symbol_edges(from_file_path);
    CREATE INDEX IF NOT EXISTS idx_semantic_edges_to_file_path ON semantic_symbol_edges(to_file_path);
  `);
  createSearchSchema(db);

  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
    .run("schema_version", toJson(DB_SCHEMA_VERSION));
  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
    .run("db_driver", toJson(implementation.name));
  if (!readOnly) {
    refreshSearchIndexIfNeeded(db);
  }
}

function openReadOnlyIndexDatabase(sourceDbPath, options) {
  try {
    const opened = openDatabaseFile(sourceDbPath, options);
    try {
      configureIndexConnection(opened.db, opened.implementation, { readOnly: true });
      return opened.db;
    } catch (error) {
      opened.db.close();
      if (shouldUseReadOnlySnapshotFallback(error)) {
        throw error;
      }
      throw createInvalidIndexDatabaseError(sourceDbPath, error);
    }
  } catch (openError) {
    if (openError?.code === "AGENTIFY_INDEX_DATABASE_INVALID") {
      throw openError;
    }

    let snapshot;
    try {
      snapshot = createIndexSnapshot(sourceDbPath);
      const opened = openDatabaseFile(snapshot.snapshotPath, { ...options, readOnly: false });
      try {
        configureIndexConnection(opened.db, opened.implementation, { readOnly: true });
      } catch (error) {
        opened.db.close();
        throw error;
      }
      opened.db.__agentifyTempDir = snapshot.tempDir;
      return opened.db;
    } catch (error) {
      if (snapshot) {
        fs.rmSync(snapshot.tempDir, { recursive: true, force: true });
      }
      throw createInvalidIndexDatabaseError(sourceDbPath, error);
    }
  }
}

export function openIndexDatabase(root, options = {}) {
  const sourceDbPath = getIndexDbPath(root);
  const readOnly = Boolean(options.readOnly);

  if (readOnly) {
    if (!fs.existsSync(sourceDbPath)) {
      throw new Error(`missing index database at ${sourceDbPath}`);
    }
    return openReadOnlyIndexDatabase(sourceDbPath, options);
  }

  fs.mkdirSync(path.dirname(sourceDbPath), { recursive: true });
  const opened = openDatabaseFile(sourceDbPath, options);
  configureIndexConnection(opened.db, opened.implementation, { readOnly: false });

  return opened.db;
}

export function closeIndexDatabase(db) {
  db.close();
  if (db?.__agentifyTempDir) {
    fs.rmSync(db.__agentifyTempDir, { recursive: true, force: true });
  }
}

export function inTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
