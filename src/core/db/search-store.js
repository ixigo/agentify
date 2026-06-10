import { toJson } from "./utils.js";

const SEARCH_INDEX_VERSION = "1.0";
const STRUCTURAL_OWNER = "structural";

function likePattern(term) {
  const normalized = String(term || "")
    .trim()
    .toLowerCase();
  return `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
}

export function createSearchSchema(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS query_search_fts USING fts5(
      entity_type UNINDEXED,
      owner_id UNINDEXED,
      entity_id UNINDEXED,
      search_text,
      tokenize='trigram'
    );
  `);
}

export function refreshSearchIndexIfNeeded(db) {
  const version = db.prepare("SELECT value_json FROM repo_meta WHERE key = ?").get("search_index_version")?.value_json;
  if (version === toJson(SEARCH_INDEX_VERSION)) {
    return;
  }

  rebuildSearchIndex(db);
}

export function rebuildSearchIndex(db) {
  db.prepare("DELETE FROM query_search_fts").run();
  rebuildStructuralSearchIndex(db);
  rebuildSemanticSearchIndex(db);
  setSearchIndexVersion(db);
}

export function setSearchIndexVersion(db) {
  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)").run(
    "search_index_version",
    toJson(SEARCH_INDEX_VERSION),
  );
}

export function clearStructuralSearchIndex(db) {
  db.prepare("DELETE FROM query_search_fts WHERE owner_id = ?").run(STRUCTURAL_OWNER);
}

export function rebuildStructuralSearchIndex(db) {
  clearStructuralSearchIndex(db);
  db.exec(`
    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT 'module', '${STRUCTURAL_OWNER}', id, lower(id || ' ' || name || ' ' || root_path)
    FROM modules;

    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT 'file', '${STRUCTURAL_OWNER}', path, lower(path)
    FROM files;

    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT 'symbol', '${STRUCTURAL_OWNER}', CAST(symbol_id AS TEXT), lower(name || ' ' || file_path)
    FROM symbols;
  `);
}

export function clearSemanticProjectSearchIndex(db, projectId) {
  db.prepare(
    `
    DELETE FROM query_search_fts
    WHERE entity_type IN ('semantic_project', 'semantic_surface', 'semantic_symbol')
      AND owner_id = ?
  `,
  ).run(projectId);
}

export function rebuildSemanticProjectSearchIndex(db, projectId) {
  clearSemanticProjectSearchIndex(db, projectId);
  db.prepare(
    `
    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT
      'semantic_project',
      project_id,
      project_id,
      lower(project_id || ' ' || coalesce(config_path, '') || ' ' || project_root)
    FROM semantic_projects
    WHERE project_id = ?
  `,
  ).run(projectId);
  db.prepare(
    `
    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT
      'semantic_surface',
      project_id,
      surface_id,
      lower(file_path || ' ' || kind || ' ' || role || ' ' || surface_key || ' ' || display_name)
    FROM semantic_surfaces
    WHERE project_id = ?
  `,
  ).run(projectId);
  db.prepare(
    `
    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT
      'semantic_symbol',
      project_id,
      symbol_id,
      lower(name || ' ' || file_path || ' ' || coalesce(export_name, ''))
    FROM semantic_symbols
    WHERE project_id = ?
  `,
  ).run(projectId);
}

export function rebuildSemanticSearchIndex(db) {
  db.prepare(
    `
    DELETE FROM query_search_fts
    WHERE entity_type IN ('semantic_project', 'semantic_surface', 'semantic_symbol')
  `,
  ).run();
  db.exec(`
    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT
      'semantic_project',
      project_id,
      project_id,
      lower(project_id || ' ' || coalesce(config_path, '') || ' ' || project_root)
    FROM semantic_projects;

    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT
      'semantic_surface',
      project_id,
      surface_id,
      lower(file_path || ' ' || kind || ' ' || role || ' ' || surface_key || ' ' || display_name)
    FROM semantic_surfaces;

    INSERT INTO query_search_fts (entity_type, owner_id, entity_id, search_text)
    SELECT
      'semantic_symbol',
      project_id,
      symbol_id,
      lower(name || ' ' || file_path || ' ' || coalesce(export_name, ''))
    FROM semantic_symbols;
  `);
}

export function searchLikePattern(term) {
  return likePattern(term);
}
