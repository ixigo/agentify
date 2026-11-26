import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveLocalAgentifyPaths } from "../project-store.js";
import { createSearchSchema, refreshSearchIndexIfNeeded } from "./search-store.js";
import { toJson } from "./utils.js";

const require = createRequire(import.meta.url);
// 3.2 adds the symbol_refs table (real TS/JS call-site references, plan task
// 2.1). A version-mismatched database is treated as disposable and rebuilt
// (see assertWritableIndexIsUsable / configureIndexConnection), so an index
// built before this table existed is transparently regenerated on next open.
const DB_SCHEMA_VERSION = "3.2";
const SNAPSHOT_DIR_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o600;

let driver = null;

// Tri-state cache for the better-sqlite3 binding probe: null = not yet probed,
// true = usable, false = must not be loaded in-process.
let betterSqlite3Usable = null;

// A mismatched native binding can abort the process with SIGSEGV on
// `new Database()` instead of throwing — e.g. better-sqlite3 13's prebuilt
// binary targets Node-API 10, which Node only supports from 22.14, so on an
// older 22.x it segfaults (exit 139) before any JS error is raised. No
// try/catch can recover from that, and it would take down `agentify install`
// with it. So probe the binding once in a short-lived child process: a crash
// there is observed as a non-zero exit, and the in-process open is skipped in
// favour of the node:sqlite fallback. On the healthy path this costs a single
// child spawn, cached for the rest of the process, and only on the index code
// path (never on the file-based context/hook hot path).
function isBetterSqlite3Usable() {
  if (betterSqlite3Usable !== null) {
    return betterSqlite3Usable;
  }

  try {
    const entry = require.resolve("better-sqlite3");
    const probe = `new (require(${JSON.stringify(entry)}))(":memory:").close()`;
    const result = spawnSync(process.execPath, ["--no-warnings", "-e", probe], {
      stdio: "ignore",
      timeout: 10000,
    });
    betterSqlite3Usable = result.status === 0 && !result.error && !result.signal;
  } catch {
    // Not resolvable/installed: treat as unusable and let node:sqlite take over.
    betterSqlite3Usable = false;
  }

  return betterSqlite3Usable;
}

function openWithBetterSqlite3(filename, options = {}) {
  if (!isBetterSqlite3Usable()) {
    throw new Error("better-sqlite3 native binding is not usable in this runtime");
  }
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
  if (root && typeof root === "object" && typeof root.indexDb === "string") {
    return root.indexDb;
  }
  return resolveLocalAgentifyPaths(root).indexDb;
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

    CREATE TABLE IF NOT EXISTS symbol_refs (
      ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_name TEXT NOT NULL,
      from_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      kind TEXT NOT NULL,
      FOREIGN KEY (from_path) REFERENCES files(path) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS index_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      indexed_at TEXT NOT NULL,
      head_commit TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      module_count INTEGER NOT NULL,
      symbol_count INTEGER NOT NULL,
      import_count INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_modules_root_path ON modules(root_path);
    CREATE INDEX IF NOT EXISTS idx_files_module_id ON files(module_id);
    CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
    CREATE INDEX IF NOT EXISTS idx_symbols_module_id ON symbols(module_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_refs(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_imports_from_module_id ON imports(from_module_id);
    CREATE INDEX IF NOT EXISTS idx_imports_to_module_id ON imports(to_module_id);
    CREATE INDEX IF NOT EXISTS idx_tests_module_id ON tests(module_id);
    CREATE INDEX IF NOT EXISTS idx_commands_module_id ON commands(module_id);
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

export function removeIndexDatabaseFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function assertWritableIndexIsUsable(db) {
  const check = db.prepare("PRAGMA quick_check(1)").get();
  const result = check ? Object.values(check)[0] : null;
  if (result !== "ok") {
    throw new Error(`index database failed integrity check: ${result || "unknown"}`);
  }
  const hasRepoMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_meta'").get();
  if (!hasRepoMeta) {
    return;
  }
  const row = db.prepare("SELECT value_json FROM repo_meta WHERE key = 'schema_version' LIMIT 1").get();
  if (!row) {
    return;
  }
  const schemaVersion = JSON.parse(row.value_json);
  if (schemaVersion !== DB_SCHEMA_VERSION) {
    throw new Error(`index database schema version ${schemaVersion} does not match ${DB_SCHEMA_VERSION}`);
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
  let opened;
  try {
    opened = openDatabaseFile(sourceDbPath, options);
    assertWritableIndexIsUsable(opened.db);
  } catch {
    // The index is derived data: rather than wedging on a corrupt file or a
    // database written by an older schema, start the file over and let the
    // caller (scan/update) repopulate it.
    if (opened) {
      try {
        opened.db.close();
      } catch {
        // Already unusable; removal below is what matters.
      }
    }
    removeIndexDatabaseFiles(sourceDbPath);
    opened = openDatabaseFile(sourceDbPath, options);
  }
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
