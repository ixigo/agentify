import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(here, "..", "settings.yaml");

// Tiny flat-YAML reader: one `key: value` per line, `#` comments ignored.
// Numeric-looking values are coerced to numbers, everything else stays a string.
export function loadConfig(path = SETTINGS_PATH) {
  const text = readFileSync(path, "utf8");
  const config = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1).trim();
    const asNumber = Number(rawValue);
    config[key] =
      rawValue !== "" && !Number.isNaN(asNumber) ? asNumber : rawValue;
  }
  return config;
}
