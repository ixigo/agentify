// tinylog — structured logging
// Copyright 2025 Example Corp. MIT license.
export function formatLine(level, message, fields = {}) {
  return JSON.stringify({ level, message, ...fields });
}
