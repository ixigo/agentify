// tinylog — structured logging
// Copyright 2025 Example Corp. MIT license.
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function levelValue(name) {
  return LEVELS[name] ?? LEVELS.info;
}
