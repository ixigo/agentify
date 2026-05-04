import { fromJson, normalizeRows, toJson } from "./utils.js";

export function clearSemanticProjectState(db, projectId) {
  db.prepare("DELETE FROM semantic_symbol_edges WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM semantic_surfaces WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM semantic_symbols WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM semantic_external_packages WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM semantic_project_files WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM semantic_projects WHERE project_id = ?").run(projectId);
}

export function upsertSemanticMeta(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO semantic_meta (key, value_json) VALUES (?, ?)")
    .run(key, toJson(value));
}

export function getSemanticMeta(db) {
  const rows = normalizeRows(db.prepare("SELECT key, value_json FROM semantic_meta").all());
  const meta = {};
  for (const row of rows) {
    meta[row.key] = fromJson(row.value_json);
  }
  return meta;
}

export function replaceSemanticProjectSnapshot(db, snapshot) {
  clearSemanticProjectState(db, snapshot.project.project_id);

  db.prepare(`
    INSERT INTO semantic_projects (
      project_id,
      config_path,
      project_root,
      inferred,
      analyzer_version,
      schema_version,
      status,
      coverage_ratio,
      file_count,
      symbol_count,
      surface_count,
      edge_count,
      content_fingerprint,
      public_fingerprint,
      refreshed_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.project.project_id,
    snapshot.project.config_path || null,
    snapshot.project.project_root,
    snapshot.project.inferred,
    snapshot.project.analyzer_version,
    snapshot.project.schema_version,
    snapshot.project.status,
    snapshot.project.coverage_ratio,
    snapshot.project.file_count,
    snapshot.project.symbol_count,
    snapshot.project.surface_count,
    snapshot.project.edge_count,
    snapshot.project.content_fingerprint,
    snapshot.project.public_fingerprint,
    snapshot.project.refreshed_at,
    snapshot.project.last_error || null
  );

  const insertFile = db.prepare(`
    INSERT INTO semantic_project_files (
      project_id,
      file_path,
      domain,
      is_header_target
    ) VALUES (?, ?, ?, ?)
  `);
  for (const fileInfo of snapshot.files || []) {
    insertFile.run(
      fileInfo.project_id,
      fileInfo.file_path,
      fileInfo.domain,
      fileInfo.is_header_target || 0
    );
  }

  const insertPackage = db.prepare(`
    INSERT INTO semantic_external_packages (
      project_id,
      package_name,
      usage_count
    ) VALUES (?, ?, ?)
  `);
  for (const packageInfo of snapshot.externalPackages || []) {
    insertPackage.run(
      packageInfo.project_id,
      packageInfo.package_name,
      packageInfo.usage_count || 0
    );
  }

  const insertSymbol = db.prepare(`
    INSERT INTO semantic_symbols (
      symbol_id,
      project_id,
      file_path,
      name,
      display_name,
      kind,
      export_name,
      start_line,
      end_line,
      is_exported,
      is_default,
      domain
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const symbolInfo of snapshot.symbols || []) {
    insertSymbol.run(
      symbolInfo.symbol_id,
      symbolInfo.project_id,
      symbolInfo.file_path,
      symbolInfo.name,
      symbolInfo.display_name,
      symbolInfo.kind,
      symbolInfo.export_name || null,
      symbolInfo.start_line,
      symbolInfo.end_line,
      symbolInfo.is_exported || 0,
      symbolInfo.is_default || 0,
      symbolInfo.domain
    );
  }

  const insertSurface = db.prepare(`
    INSERT INTO semantic_surfaces (
      surface_id,
      project_id,
      file_path,
      symbol_id,
      kind,
      role,
      surface_key,
      display_name,
      domain,
      is_header_target
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const surfaceInfo of snapshot.surfaces || []) {
    insertSurface.run(
      surfaceInfo.surface_id,
      surfaceInfo.project_id,
      surfaceInfo.file_path,
      surfaceInfo.symbol_id || null,
      surfaceInfo.kind,
      surfaceInfo.role,
      surfaceInfo.surface_key,
      surfaceInfo.display_name,
      surfaceInfo.domain,
      surfaceInfo.is_header_target || 0
    );
  }

  const insertEdge = db.prepare(`
    INSERT INTO semantic_symbol_edges (
      project_id,
      from_symbol_id,
      to_symbol_id,
      from_file_path,
      to_file_path,
      to_external_package,
      edge_kind,
      edge_domain,
      confidence,
      source,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const edgeInfo of snapshot.symbolEdges || []) {
    insertEdge.run(
      edgeInfo.project_id,
      edgeInfo.from_symbol_id || null,
      edgeInfo.to_symbol_id || null,
      edgeInfo.from_file_path || null,
      edgeInfo.to_file_path || null,
      edgeInfo.to_external_package || null,
      edgeInfo.edge_kind,
      edgeInfo.edge_domain,
      edgeInfo.confidence ?? 1,
      edgeInfo.source,
      edgeInfo.metadata_json || null
    );
  }
}

export function listSemanticProjects(db) {
  return normalizeRows(db.prepare(`
    SELECT
      project_id,
      config_path,
      project_root,
      inferred,
      analyzer_version,
      schema_version,
      status,
      coverage_ratio,
      file_count,
      symbol_count,
      surface_count,
      edge_count,
      content_fingerprint,
      public_fingerprint,
      refreshed_at,
      last_error
    FROM semantic_projects
    ORDER BY coalesce(config_path, project_root), project_id
  `).all());
}

export function loadSemanticRouteSurfaces(db) {
  return normalizeRows(db.prepare(`
    SELECT surface_key, role, file_path, display_name
    FROM semantic_surfaces
    WHERE kind = 'route'
    ORDER BY surface_key, role, file_path
  `).all());
}

export function loadSemanticReactSurfaces(db) {
  return normalizeRows(db.prepare(`
    SELECT display_name, role, file_path
    FROM semantic_surfaces
    WHERE kind LIKE 'react-%'
    ORDER BY display_name, file_path
  `).all());
}

export function loadSemanticProjectFactsByFile(db) {
  const fileRows = normalizeRows(db.prepare(`
    SELECT
      f.project_id,
      f.file_path,
      f.domain,
      f.is_header_target,
      p.status,
      p.config_path
    FROM semantic_project_files f
    JOIN semantic_projects p ON p.project_id = f.project_id
    WHERE f.is_header_target = 1
      AND p.status = 'ready'
    ORDER BY f.file_path
  `).all());

  const exportRows = normalizeRows(db.prepare(`
    SELECT file_path, export_name
    FROM semantic_symbols
    WHERE is_exported = 1
      AND export_name IS NOT NULL
    ORDER BY file_path, export_name
  `).all());
  const surfaceRows = normalizeRows(db.prepare(`
    SELECT file_path, kind, role, surface_key, display_name
    FROM semantic_surfaces
    ORDER BY file_path, kind, role
  `).all());
  const edgeRows = normalizeRows(db.prepare(`
    SELECT from_file_path, to_file_path, to_external_package, edge_domain
    FROM semantic_symbol_edges
    WHERE from_file_path IS NOT NULL
    ORDER BY from_file_path
  `).all());

  const exportsByFile = new Map();
  for (const row of exportRows) {
    const list = exportsByFile.get(row.file_path) || [];
    list.push(row.export_name);
    exportsByFile.set(row.file_path, list);
  }

  const surfacesByFile = new Map();
  for (const row of surfaceRows) {
    const list = surfacesByFile.get(row.file_path) || [];
    list.push(row);
    surfacesByFile.set(row.file_path, list);
  }

  const runtimeDepsByFile = new Map();
  const typeDepsByFile = new Map();
  for (const row of edgeRows) {
    const label = row.to_external_package || row.to_file_path;
    if (!label) {
      continue;
    }
    const targetMap = row.edge_domain === "type" ? typeDepsByFile : runtimeDepsByFile;
    const list = targetMap.get(row.from_file_path) || [];
    list.push(label);
    targetMap.set(row.from_file_path, list);
  }

  return fileRows.map((row) => {
    const surfaces = surfacesByFile.get(row.file_path) || [];
    const preferredSurface = surfaces.find((surface) => surface.kind === "route") || surfaces[0] || null;

    return {
      project_id: row.project_id,
      file_path: row.file_path,
      domain: row.domain,
      is_header_target: Boolean(row.is_header_target),
      status: row.status,
      project_label: row.config_path || "inferred",
      exports: exportsByFile.get(row.file_path) || [],
      runtimeDeps: runtimeDepsByFile.get(row.file_path) || [],
      typeDeps: typeDepsByFile.get(row.file_path) || [],
      surface: preferredSurface
        ? {
            kind: preferredSurface.kind,
            role: preferredSurface.role,
            surfaceKey: preferredSurface.surface_key,
            displayName: preferredSurface.display_name,
          }
        : null,
    };
  });
}

export function loadSemanticPlannerFacts(db) {
  const symbolRows = normalizeRows(db.prepare(`
    SELECT
      s.symbol_id AS semantic_id,
      s.project_id,
      s.file_path,
      f.module_id,
      s.name,
      s.kind,
      s.is_exported AS exported,
      s.start_line,
      s.end_line,
      s.domain,
      'symbol' AS source,
      NULL AS alias
    FROM semantic_symbols s
    LEFT JOIN files f ON f.path = s.file_path
    WHERE s.domain != 'support'
    ORDER BY s.file_path, s.start_line
  `).all());
  const surfaceRows = normalizeRows(db.prepare(`
    SELECT
      sf.surface_id AS semantic_id,
      sf.project_id,
      sf.file_path,
      f.module_id,
      sf.display_name AS name,
      sf.kind || ':' || sf.role AS kind,
      1 AS exported,
      1 AS start_line,
      1 AS end_line,
      sf.domain,
      'surface' AS source,
      sf.surface_key AS alias
    FROM semantic_surfaces sf
    LEFT JOIN files f ON f.path = sf.file_path
    WHERE sf.domain != 'support'
    ORDER BY sf.file_path, sf.kind, sf.role
  `).all());

  return [...symbolRows, ...surfaceRows];
}

export function searchSemanticIndex(db, term, limit = 20) {
  const normalized = `%${String(term || "").trim().toLowerCase()}%`;
  return {
    semantic_projects: normalizeRows(db.prepare(`
      SELECT project_id, config_path, project_root, status, file_count, symbol_count, surface_count, edge_count
      FROM semantic_projects
      WHERE lower(coalesce(config_path, '')) LIKE ?
        OR lower(project_root) LIKE ?
        OR lower(project_id) LIKE ?
      ORDER BY coalesce(config_path, project_root), project_id
      LIMIT ?
    `).all(normalized, normalized, normalized, limit)),
    semantic_surfaces: normalizeRows(db.prepare(`
      SELECT surface_id, project_id, file_path, kind, role, surface_key, display_name
      FROM semantic_surfaces
      WHERE lower(file_path) LIKE ?
        OR lower(kind) LIKE ?
        OR lower(role) LIKE ?
        OR lower(surface_key) LIKE ?
        OR lower(display_name) LIKE ?
      ORDER BY file_path, kind, role
      LIMIT ?
    `).all(normalized, normalized, normalized, normalized, normalized, limit)),
    semantic_symbols: normalizeRows(db.prepare(`
      SELECT symbol_id, project_id, file_path, name, kind, export_name, is_exported
      FROM semantic_symbols
      WHERE lower(name) LIKE ?
        OR lower(file_path) LIKE ?
        OR lower(coalesce(export_name, '')) LIKE ?
      ORDER BY file_path, start_line
      LIMIT ?
    `).all(normalized, normalized, normalized, limit)),
  };
}

export function loadSemanticFileContext(db, filePath) {
  return {
    projects: normalizeRows(db.prepare(`
      SELECT p.project_id, p.config_path, p.project_root, p.status
      FROM semantic_project_files f
      JOIN semantic_projects p ON p.project_id = f.project_id
      WHERE f.file_path = ?
      ORDER BY coalesce(p.config_path, p.project_root)
    `).all(filePath)),
    surfaces: normalizeRows(db.prepare(`
      SELECT surface_id, project_id, kind, role, surface_key, display_name, domain
      FROM semantic_surfaces
      WHERE file_path = ?
      ORDER BY kind, role, display_name
    `).all(filePath)),
    exports: normalizeRows(db.prepare(`
      SELECT symbol_id, name, kind, export_name
      FROM semantic_symbols
      WHERE file_path = ?
        AND is_exported = 1
      ORDER BY start_line
    `).all(filePath)),
  };
}

export function loadSemanticModuleDependencies(db, moduleId) {
  const dependsOn = normalizeRows(db.prepare(`
    SELECT DISTINCT tf.module_id AS module_id
    FROM semantic_symbol_edges e
    JOIN files ff ON ff.path = e.from_file_path
    JOIN files tf ON tf.path = e.to_file_path
    WHERE ff.module_id = ?
      AND tf.module_id IS NOT NULL
      AND tf.module_id != ?
      AND e.edge_domain = 'runtime'
    ORDER BY tf.module_id
  `).all(moduleId, moduleId)).map((row) => row.module_id);

  const usedBy = normalizeRows(db.prepare(`
    SELECT DISTINCT ff.module_id AS module_id
    FROM semantic_symbol_edges e
    JOIN files ff ON ff.path = e.from_file_path
    JOIN files tf ON tf.path = e.to_file_path
    WHERE tf.module_id = ?
      AND ff.module_id IS NOT NULL
      AND ff.module_id != ?
      AND e.edge_domain = 'runtime'
    ORDER BY ff.module_id
  `).all(moduleId, moduleId)).map((row) => row.module_id);

  return { dependsOn, usedBy };
}

export function loadSemanticModuleContext(db, moduleId) {
  const publicApi = normalizeRows(db.prepare(`
    SELECT s.name, s.kind, s.file_path
    FROM semantic_symbols s
    JOIN files f ON f.path = s.file_path
    WHERE f.module_id = ?
      AND s.is_exported = 1
      AND s.domain != 'support'
    ORDER BY s.file_path, s.start_line
    LIMIT 12
  `).all(moduleId)).map((row) => ({
    symbol: row.name,
    kind: row.kind,
    path: row.file_path,
  }));

  const surfaces = normalizeRows(db.prepare(`
    SELECT kind, role, surface_key, display_name, file_path
    FROM semantic_surfaces sf
    JOIN files f ON f.path = sf.file_path
    WHERE f.module_id = ?
      AND sf.domain != 'support'
    ORDER BY
      CASE WHEN sf.kind = 'route' THEN 0 ELSE 1 END,
      sf.file_path,
      sf.kind,
      sf.role
    LIMIT 16
  `).all(moduleId)).map((row) => ({
    kind: row.kind,
    role: row.role,
    surface_key: row.surface_key,
    display_name: row.display_name,
    path: row.file_path,
  }));

  const startHere = normalizeRows(db.prepare(`
    SELECT DISTINCT sf.file_path, sf.kind, sf.role, sf.display_name
    FROM semantic_surfaces sf
    JOIN files f ON f.path = sf.file_path
    WHERE f.module_id = ?
      AND sf.is_header_target = 1
    ORDER BY
      CASE WHEN sf.kind = 'route' THEN 0 ELSE 1 END,
      sf.file_path
    LIMIT 5
  `).all(moduleId)).map((row) => ({
    path: row.file_path,
    why: `Semantic ${row.role || row.kind} surface${row.display_name ? `: ${row.display_name}` : ""}.`,
  }));

  const runtimeDeps = normalizeRows(db.prepare(`
    SELECT DISTINCT coalesce(e.to_external_package, e.to_file_path) AS target
    FROM semantic_symbol_edges e
    JOIN files f ON f.path = e.from_file_path
    WHERE f.module_id = ?
      AND e.edge_domain = 'runtime'
      AND coalesce(e.to_external_package, e.to_file_path) IS NOT NULL
    ORDER BY target
    LIMIT 12
  `).all(moduleId)).map((row) => row.target);

  const typeDeps = normalizeRows(db.prepare(`
    SELECT DISTINCT coalesce(e.to_external_package, e.to_file_path) AS target
    FROM semantic_symbol_edges e
    JOIN files f ON f.path = e.from_file_path
    WHERE f.module_id = ?
      AND e.edge_domain = 'type'
      AND coalesce(e.to_external_package, e.to_file_path) IS NOT NULL
    ORDER BY target
    LIMIT 12
  `).all(moduleId)).map((row) => row.target);

  const projects = normalizeRows(db.prepare(`
    SELECT DISTINCT p.project_id, p.config_path, p.status
    FROM semantic_project_files pf
    JOIN files f ON f.path = pf.file_path
    JOIN semantic_projects p ON p.project_id = pf.project_id
    WHERE f.module_id = ?
    ORDER BY coalesce(p.config_path, p.project_id)
  `).all(moduleId));

  return {
    public_api: publicApi,
    surfaces,
    start_here: startHere,
    runtime_deps: runtimeDeps,
    type_deps: typeDeps,
    projects,
  };
}
