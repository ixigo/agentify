// tinylog — structured logging
// Copyright 2025 Example Corp. MIT license.
import { formatLine } from "./format.js";
import { levelValue } from "./levels.js";

export function createLogger(minLevel = "info") {
  const threshold = levelValue(minLevel);
  return {
    log(level, message, fields) {
      if (levelValue(level) < threshold) return null;
      return formatLine(level, message, fields);
    },
  };
}
