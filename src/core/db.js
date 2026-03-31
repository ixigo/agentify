import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DB_SCHEMA_VERSION = "2.0";

let driver = null;

function openWithBetterSqlite3(filename) {
  const BetterSqlite3 = require("better-sqlite3");
  return {
    name: "better-sqlite3",
    db: new BetterSqlite3(filename),
  };
}

function openWithNodeSqlite(filename) {
  const { DatabaseSync } = require("node:sqlite");
  return {
    name: "node:sqlite",
    db: new DatabaseSync(filename),
  };
}

function normalizeRow(row) {
  return row ? { ...row } : null;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(value, fallback = null) {
  if (typeof value !== "string" || value === "") {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getIndexDbPath(root) {
  return path.join(root, ".agents", "index.db");
}

export function openIndexDatabase(root) {
  const dbPath = getIndexDbPath(root);
  let implementation = driver;
  let db = null;

  if (implementation?.name === "better-sqlite3") {
    try {
      db = openWithBetterSqlite3(dbPath).db;
    } catch {
      implementation = null;
    }
  }

  if (!db && implementation?.name === "node:sqlite") {
    db = openWithNodeSqlite(dbPath).db;
  }

  if (!db) {
    try {
      const opened = openWithBetterSqlite3(dbPath);
      implementation = { name: opened.name };
      db = opened.db;
    } catch {
      const opened = openWithNodeSqlite(dbPath);
      implementation = { name: opened.name };
      db = opened.db;
    }
  }

  driver = implementation;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

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

    CREATE INDEX IF NOT EXISTS idx_modules_root_path ON modules(root_path);
    CREATE INDEX IF NOT EXISTS idx_files_module_id ON files(module_id);
    CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
    CREATE INDEX IF NOT EXISTS idx_symbols_module_id ON symbols(module_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_imports_from_module_id ON imports(from_module_id);
    CREATE INDEX IF NOT EXISTS idx_imports_to_module_id ON imports(to_module_id);
    CREATE INDEX IF NOT EXISTS idx_tests_module_id ON tests(module_id);
    CREATE INDEX IF NOT EXISTS idx_commands_module_id ON commands(module_id);
  `);

  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
    .run("schema_version", toJson(DB_SCHEMA_VERSION));
  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
    .run("db_driver", toJson(implementation.name));

  return db;
}

export function closeIndexDatabase(db) {
  db.close();
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

export function clearIndexedState(db) {
  db.exec(`
    DELETE FROM commands;
    DELETE FROM tests;
    DELETE FROM imports;
    DELETE FROM symbols;
    DELETE FROM files;
    DELETE FROM modules;
    DELETE FROM index_events;
  `);
}

export function setRepoMeta(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
    .run(key, toJson(value));
}

export function getRepoMetaValue(db, key, fallback = null) {
  const row = normalizeRow(
    db.prepare("SELECT value_json FROM repo_meta WHERE key = ?").get(key)
  );
  return row ? fromJson(row.value_json, fallback) : fallback;
}

export function getRepoMeta(db) {
  const rows = normalizeRows(db.prepare("SELECT key, value_json FROM repo_meta").all());
  const meta = {};
  for (const row of rows) {
    meta[row.key] = fromJson(row.value_json);
  }
  return meta;
}

export function upsertArtifact(db, {
  key,
  type,
  scope = null,
  fingerprint = null,
  payload,
  updatedAt,
}) {
  db.prepare(`
    INSERT OR REPLACE INTO artifacts (
      artifact_key,
      artifact_type,
      scope,
      fingerprint,
      payload_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(key, type, scope, fingerprint, toJson(payload), updatedAt);
}

export function getArtifact(db, key) {
  const row = normalizeRow(
    db.prepare(`
      SELECT artifact_key, artifact_type, scope, fingerprint, payload_json, updated_at
      FROM artifacts
      WHERE artifact_key = ?
    `).get(key)
  );

  if (!row) {
    return null;
  }

  return {
    key: row.artifact_key,
    type: row.artifact_type,
    scope: row.scope,
    fingerprint: row.fingerprint,
    payload: fromJson(row.payload_json, null),
    updatedAt: row.updated_at,
  };
}

export function listArtifacts(db, type = null) {
  const rows = type
    ? normalizeRows(
        db.prepare(`
          SELECT artifact_key, artifact_type, scope, fingerprint, payload_json, updated_at
          FROM artifacts
          WHERE artifact_type = ?
          ORDER BY artifact_key
        `).all(type)
      )
    : normalizeRows(
        db.prepare(`
          SELECT artifact_key, artifact_type, scope, fingerprint, payload_json, updated_at
          FROM artifacts
          ORDER BY artifact_key
        `).all()
      );

  return rows.map((row) => ({
    key: row.artifact_key,
    type: row.artifact_type,
    scope: row.scope,
    fingerprint: row.fingerprint,
    payload: fromJson(row.payload_json, null),
    updatedAt: row.updated_at,
  }));
}

export function removeArtifact(db, key) {
  db.prepare("DELETE FROM artifacts WHERE artifact_key = ?").run(key);
}

export function loadModules(db) {
  return normalizeRows(db.prepare(`
    SELECT
      m.id,
      m.name,
      m.root_path,
      m.stack,
      m.package_name,
      m.slug,
      m.doc_path,
      m.fingerprint,
      m.entry_files_json,
      m.key_files_json,
      COUNT(DISTINCT f.path) AS file_count,
      COUNT(DISTINCT s.symbol_id) AS symbol_count
    FROM modules m
    LEFT JOIN files f ON f.module_id = m.id
    LEFT JOIN symbols s ON s.module_id = m.id
    GROUP BY
      m.id,
      m.name,
      m.root_path,
      m.stack,
      m.package_name,
      m.slug,
      m.doc_path,
      m.fingerprint,
      m.entry_files_json,
      m.key_files_json
    ORDER BY m.root_path
  `).all()).map((row) => ({
    ...row,
    entry_files: fromJson(row.entry_files_json, []),
    key_files: fromJson(row.key_files_json, []),
  }));
}

export function writeRepositoryIndex(db, snapshot, { headCommit, provider }) {
  clearIndexedState(db);
  setRepoMeta(db, "repo_name", snapshot.repo.name);
  setRepoMeta(db, "repo_root", snapshot.repo.root);
  setRepoMeta(db, "detected_stacks", snapshot.repo.detected_stacks);
  setRepoMeta(db, "default_stack", snapshot.repo.default_stack);
  setRepoMeta(db, "package_manager", snapshot.repo.package_manager || "npm");
  setRepoMeta(db, "generated_at", snapshot.generated_at);
  setRepoMeta(db, "head_commit", headCommit);
  setRepoMeta(db, "provider", provider);
  setRepoMeta(db, "module_count", snapshot.modules.length);
  setRepoMeta(db, "file_count", snapshot.files.length);
  setRepoMeta(db, "symbol_count", snapshot.symbols.length);
  setRepoMeta(db, "import_count", snapshot.imports.length);

  const insertModule = db.prepare(`
    INSERT INTO modules (
      id,
      name,
      root_path,
      stack,
      package_name,
      slug,
      doc_path,
      fingerprint,
      entry_files_json,
      key_files_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const moduleInfo of snapshot.modules) {
    insertModule.run(
      moduleInfo.id,
      moduleInfo.name,
      moduleInfo.root_path,
      moduleInfo.stack,
      moduleInfo.package_name || null,
      moduleInfo.slug,
      moduleInfo.doc_path,
      moduleInfo.fingerprint,
      toJson(moduleInfo.entry_files || []),
      toJson(moduleInfo.key_files || [])
    );
  }

  const insertFile = db.prepare(`
    INSERT INTO files (
      path,
      module_id,
      language,
      size_bytes,
      fingerprint,
      is_test,
      is_config,
      is_entrypoint,
      is_key_file
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const fileInfo of snapshot.files) {
    insertFile.run(
      fileInfo.path,
      fileInfo.module_id || null,
      fileInfo.language,
      fileInfo.size_bytes,
      fileInfo.fingerprint,
      fileInfo.is_test,
      fileInfo.is_config,
      fileInfo.is_entrypoint,
      fileInfo.is_key_file
    );
  }

  const insertSymbol = db.prepare(`
    INSERT INTO symbols (
      module_id,
      file_path,
      name,
      kind,
      exported,
      start_line,
      end_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const symbolInfo of snapshot.symbols) {
    insertSymbol.run(
      symbolInfo.module_id || null,
      symbolInfo.file_path,
      symbolInfo.name,
      symbolInfo.kind,
      symbolInfo.exported,
      symbolInfo.start_line,
      symbolInfo.end_line
    );
  }

  const insertImport = db.prepare(`
    INSERT INTO imports (
      from_path,
      to_path,
      specifier,
      kind,
      from_module_id,
      to_module_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const importInfo of snapshot.imports) {
    insertImport.run(
      importInfo.from_path,
      importInfo.to_path || null,
      importInfo.specifier,
      importInfo.kind,
      importInfo.from_module_id || null,
      importInfo.to_module_id || null
    );
  }

  const insertTest = db.prepare(`
    INSERT INTO tests (
      file_path,
      module_id,
      framework,
      related_path
    ) VALUES (?, ?, ?, ?)
  `);
  for (const testInfo of snapshot.tests) {
    insertTest.run(
      testInfo.file_path,
      testInfo.module_id || null,
      testInfo.framework,
      testInfo.related_path || null
    );
  }

  const insertCommand = db.prepare(`
    INSERT INTO commands (
      module_id,
      command_type,
      command,
      args_json
    ) VALUES (?, ?, ?, ?)
  `);
  for (const commandInfo of snapshot.commands) {
    insertCommand.run(
      commandInfo.module_id || null,
      commandInfo.command_type,
      commandInfo.command,
      toJson(commandInfo.args || [])
    );
  }

  db.prepare(`
    INSERT INTO index_events (
      indexed_at,
      head_commit,
      file_count,
      module_count,
      symbol_count,
      import_count
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.generated_at,
    headCommit,
    snapshot.files.length,
    snapshot.modules.length,
    snapshot.symbols.length,
    snapshot.imports.length
  );
}

export function loadFiles(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(db.prepare(`
        SELECT path, module_id, language, size_bytes, fingerprint, is_test, is_config, is_entrypoint, is_key_file
        FROM files
        WHERE module_id = ?
        ORDER BY path
      `).all(moduleId))
    : normalizeRows(db.prepare(`
        SELECT path, module_id, language, size_bytes, fingerprint, is_test, is_config, is_entrypoint, is_key_file
        FROM files
        ORDER BY path
      `).all());

  return rows;
}

export function loadSymbols(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(db.prepare(`
        SELECT symbol_id, module_id, file_path, name, kind, exported, start_line, end_line
        FROM symbols
        WHERE module_id = ?
        ORDER BY file_path, start_line
      `).all(moduleId))
    : normalizeRows(db.prepare(`
        SELECT symbol_id, module_id, file_path, name, kind, exported, start_line, end_line
        FROM symbols
        ORDER BY file_path, start_line
      `).all());

  return rows;
}

export function loadTests(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(db.prepare(`
        SELECT file_path, module_id, framework, related_path
        FROM tests
        WHERE module_id = ?
        ORDER BY file_path
      `).all(moduleId))
    : normalizeRows(db.prepare(`
        SELECT file_path, module_id, framework, related_path
        FROM tests
        ORDER BY file_path
      `).all());

  return rows;
}

export function loadCommands(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(db.prepare(`
        SELECT module_id, command_type, command, args_json
        FROM commands
        WHERE module_id = ?
        ORDER BY command_type, command
      `).all(moduleId))
    : normalizeRows(db.prepare(`
        SELECT module_id, command_type, command, args_json
        FROM commands
        ORDER BY module_id, command_type, command
      `).all());

  return rows.map((row) => ({
    ...row,
    args: fromJson(row.args_json, []),
  }));
}

export function loadModuleDependencies(db, moduleId) {
  const dependsOn = normalizeRows(db.prepare(`
    SELECT DISTINCT to_module_id AS module_id
    FROM imports
    WHERE from_module_id = ?
      AND to_module_id IS NOT NULL
      AND to_module_id != ?
    ORDER BY to_module_id
  `).all(moduleId, moduleId)).map((row) => row.module_id);

  const usedBy = normalizeRows(db.prepare(`
    SELECT DISTINCT from_module_id AS module_id
    FROM imports
    WHERE to_module_id = ?
      AND from_module_id IS NOT NULL
      AND from_module_id != ?
    ORDER BY from_module_id
  `).all(moduleId, moduleId)).map((row) => row.module_id);

  return { dependsOn, usedBy };
}

export function searchIndex(db, term, limit = 20) {
  const normalized = `%${String(term || "").trim().toLowerCase()}%`;
  return {
    modules: normalizeRows(db.prepare(`
      SELECT id, name, root_path, stack
      FROM modules
      WHERE lower(id) LIKE ? OR lower(name) LIKE ? OR lower(root_path) LIKE ?
      ORDER BY root_path
      LIMIT ?
    `).all(normalized, normalized, normalized, limit)),
    files: normalizeRows(db.prepare(`
      SELECT path, module_id, language, is_test, is_config
      FROM files
      WHERE lower(path) LIKE ?
      ORDER BY path
      LIMIT ?
    `).all(normalized, limit)),
    symbols: normalizeRows(db.prepare(`
      SELECT name, kind, file_path, module_id, exported
      FROM symbols
      WHERE lower(name) LIKE ? OR lower(file_path) LIKE ?
      ORDER BY file_path, start_line
      LIMIT ?
    `).all(normalized, normalized, limit)),
  };
}
