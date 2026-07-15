import path from "node:path";

import { readJson, writePrivateJson, ensurePrivateDir } from "../fs.js";
import { ANALYSIS_PARSER_VERSION, stableSessionId } from "./normalize.js";

// Incremental cache for normalized session facts. Only content-free
// normalized sessions are stored (the same objects that appear in --json
// output), never raw JSONL, so a cache file leaks nothing a report would
// not. Entries are keyed by provider + source path and validated against
// size, mtime, parser version, and the repo root the paths were
// normalized against; any mismatch is a miss and the entry is rewritten.
export function createAnalysisCache({ cacheRoot, enabled = true }) {
  const active = Boolean(enabled && cacheRoot);
  const stats = { enabled: active, hits: 0, misses: 0, invalidated: 0, write_errors: 0 };
  let dirReady = false;

  function entryPath(file) {
    return path.join(cacheRoot, `${stableSessionId(file.provider, file.path)}.json`);
  }

  return {
    stats: () => ({ ...stats }),

    async get(file, root) {
      if (!active) return null;
      let entry;
      try {
        entry = await readJson(entryPath(file));
      } catch {
        stats.misses += 1;
        return null;
      }
      const fresh = entry
        && entry.parser_version === ANALYSIS_PARSER_VERSION
        && entry.provider === file.provider
        && entry.root === root
        && entry.size === (file.size || 0)
        && entry.mtime_ms === file.mtime_ms
        && entry.session && typeof entry.session === "object";
      if (!fresh) {
        stats.invalidated += entry ? 1 : 0;
        stats.misses += 1;
        return null;
      }
      stats.hits += 1;
      return entry.session;
    },

    async put(file, root, session) {
      if (!active) return;
      try {
        if (!dirReady) {
          await ensurePrivateDir(cacheRoot);
          dirReady = true;
        }
        await writePrivateJson(entryPath(file), {
          parser_version: ANALYSIS_PARSER_VERSION,
          provider: file.provider,
          root,
          size: file.size || 0,
          mtime_ms: file.mtime_ms,
          session,
        });
      } catch {
        // A cache write failure must never fail the scan; the next run
        // simply re-parses. Count it so coverage stays honest.
        stats.write_errors += 1;
      }
    },
  };
}
