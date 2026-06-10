import { fromJson, normalizeRows, toJson } from "./utils.js";
import { setRepoMeta } from "./metadata-store.js";
import { clearStructuralSearchIndex, rebuildStructuralSearchIndex } from "./search-store.js";

export function clearIndexedState(db) {
  clearStructuralSearchIndex(db);
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

export function loadModules(db) {
  return normalizeRows(
    db
      .prepare(
        `
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
  `,
      )
      .all(),
  ).map((row) => ({
    ...row,
    rootPath: row.root_path,
    packageName: row.package_name,
    docPath: row.doc_path,
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
      toJson(moduleInfo.key_files || []),
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
      fileInfo.is_key_file,
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
      symbolInfo.end_line,
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
      importInfo.to_module_id || null,
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
    insertTest.run(testInfo.file_path, testInfo.module_id || null, testInfo.framework, testInfo.related_path || null);
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
      toJson(commandInfo.args || []),
    );
  }

  db.prepare(
    `
    INSERT INTO index_events (
      indexed_at,
      head_commit,
      file_count,
      module_count,
      symbol_count,
      import_count
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    snapshot.generated_at,
    headCommit,
    snapshot.files.length,
    snapshot.modules.length,
    snapshot.symbols.length,
    snapshot.imports.length,
  );

  rebuildStructuralSearchIndex(db);
}

export function loadFiles(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(
        db
          .prepare(
            `
        SELECT path, module_id, language, size_bytes, fingerprint, is_test, is_config, is_entrypoint, is_key_file
        FROM files
        WHERE module_id = ?
        ORDER BY path
      `,
          )
          .all(moduleId),
      )
    : normalizeRows(
        db
          .prepare(
            `
        SELECT path, module_id, language, size_bytes, fingerprint, is_test, is_config, is_entrypoint, is_key_file
        FROM files
        ORDER BY path
      `,
          )
          .all(),
      );

  return rows;
}

export function loadSymbols(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(
        db
          .prepare(
            `
        SELECT symbol_id, module_id, file_path, name, kind, exported, start_line, end_line
        FROM symbols
        WHERE module_id = ?
        ORDER BY file_path, start_line
      `,
          )
          .all(moduleId),
      )
    : normalizeRows(
        db
          .prepare(
            `
        SELECT symbol_id, module_id, file_path, name, kind, exported, start_line, end_line
        FROM symbols
        ORDER BY file_path, start_line
      `,
          )
          .all(),
      );

  return rows;
}

export function loadTests(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(
        db
          .prepare(
            `
        SELECT file_path, module_id, framework, related_path
        FROM tests
        WHERE module_id = ?
        ORDER BY file_path
      `,
          )
          .all(moduleId),
      )
    : normalizeRows(
        db
          .prepare(
            `
        SELECT file_path, module_id, framework, related_path
        FROM tests
        ORDER BY file_path
      `,
          )
          .all(),
      );

  return rows;
}

export function loadCommands(db, moduleId = null) {
  const rows = moduleId
    ? normalizeRows(
        db
          .prepare(
            `
        SELECT module_id, command_type, command, args_json
        FROM commands
        WHERE module_id = ?
        ORDER BY command_type, command
      `,
          )
          .all(moduleId),
      )
    : normalizeRows(
        db
          .prepare(
            `
        SELECT module_id, command_type, command, args_json
        FROM commands
        ORDER BY module_id, command_type, command
      `,
          )
          .all(),
      );

  return rows.map((row) => ({
    ...row,
    args: fromJson(row.args_json, []),
  }));
}

export function loadModuleDependencies(db, moduleId) {
  const dependsOn = normalizeRows(
    db
      .prepare(
        `
    SELECT DISTINCT to_module_id AS module_id
    FROM imports
    WHERE from_module_id = ?
      AND to_module_id IS NOT NULL
      AND to_module_id != ?
    ORDER BY to_module_id
  `,
      )
      .all(moduleId, moduleId),
  ).map((row) => row.module_id);

  const usedBy = normalizeRows(
    db
      .prepare(
        `
    SELECT DISTINCT from_module_id AS module_id
    FROM imports
    WHERE to_module_id = ?
      AND from_module_id IS NOT NULL
      AND from_module_id != ?
    ORDER BY from_module_id
  `,
      )
      .all(moduleId, moduleId),
  ).map((row) => row.module_id);

  return { dependsOn, usedBy };
}

export function searchIndex(db, term, limit = 20) {
  const pattern = `%${String(term || "")
    .trim()
    .toLowerCase()}%`;
  return {
    modules: normalizeRows(
      db
        .prepare(
          `
      SELECT id, name, root_path, stack
      FROM query_search_fts search
      JOIN modules ON modules.id = search.entity_id
      WHERE search.entity_type = 'module'
        AND search.search_text LIKE ?
      ORDER BY root_path
      LIMIT ?
    `,
        )
        .all(pattern, limit),
    ),
    files: normalizeRows(
      db
        .prepare(
          `
      SELECT path, module_id, language, is_test, is_config
      FROM query_search_fts search
      JOIN files ON files.path = search.entity_id
      WHERE search.entity_type = 'file'
        AND search.search_text LIKE ?
      ORDER BY path
      LIMIT ?
    `,
        )
        .all(pattern, limit),
    ),
    symbols: normalizeRows(
      db
        .prepare(
          `
      SELECT name, kind, file_path, module_id, exported
      FROM query_search_fts search
      JOIN symbols ON symbols.symbol_id = CAST(search.entity_id AS INTEGER)
      WHERE search.entity_type = 'symbol'
        AND search.search_text LIKE ?
      ORDER BY file_path, start_line
      LIMIT ?
    `,
        )
        .all(pattern, limit),
    ),
  };
}
