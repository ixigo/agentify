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

export { fromJson, normalizeRow, normalizeRows, toJson };
