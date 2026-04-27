import { fromJson, normalizeRow, normalizeRows, toJson } from "./utils.js";

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
