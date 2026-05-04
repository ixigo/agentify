import { fromJson, normalizeRow, normalizeRows, toJson } from "./utils.js";

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
