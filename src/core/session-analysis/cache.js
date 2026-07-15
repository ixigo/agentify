import fs from "node:fs/promises";
import path from "node:path";

import { readJson, writePrivateJson, ensurePrivateDir } from "../fs.js";
import { ANALYSIS_PARSER_VERSION, stableSessionId } from "./normalize.js";

// Incremental cache for normalized session facts. Entries hold the
// normalized session metadata (workspace path, branch, models, usage
// counters, tool/file/pattern counts) that scoping and scanning need on
// the next run — never transcript bodies, prompts, responses, or command
// text. Because global reports pseudonymize some of these fields at
// render time, the cache is stored privately (dir 0700, files 0600) and
// swept when source files disappear. Entries are keyed by provider +
// source path and validated against size, mtime, parser version, and the
// repo root the paths were normalized against; any mismatch is a miss
// and the entry is rewritten.

// A cached session must carry the shapes buildSessionAnalysis
// dereferences; a structurally corrupt entry is discarded, not trusted.
function isUsableSession(session) {
  return Boolean(
    session
    && typeof session === "object"
    && session.usage && typeof session.usage === "object"
    && session.tools && typeof session.tools.by_name === "object"
    && Array.isArray(session.file_access)
    && Array.isArray(session.models)
    && session.shell_patterns && typeof session.shell_patterns === "object"
    && session.coverage && typeof session.coverage === "object"
    && session.turns && typeof session.turns === "object"
    && typeof session.failed_command_fingerprints === "object",
  );
}

export function createAnalysisCache({ cacheRoot, enabled = true }) {
  const active = Boolean(enabled && cacheRoot);
  const stats = { enabled: active, hits: 0, misses: 0, invalidated: 0, pruned: 0, write_errors: 0 };
  let dirReady = false;

  function entryPath(file) {
    return path.join(cacheRoot, `${stableSessionId(file.provider, file.path)}.json`);
  }

  return {
    stats: () => ({ ...stats }),

    async get(file, root, contentMode = "metadata-only") {
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
        // Sessions parsed under a different content mode carry different
        // task hints, so they never serve each other.
        && (entry.content_mode || "metadata-only") === contentMode
        && entry.size === (file.size || 0)
        && entry.mtime_ms === file.mtime_ms
        && isUsableSession(entry.session);
      if (!fresh) {
        stats.invalidated += entry ? 1 : 0;
        stats.misses += 1;
        return null;
      }
      stats.hits += 1;
      return entry.session;
    },

    async put(file, root, session, contentMode = "metadata-only") {
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
          content_mode: contentMode,
          source_path: path.resolve(file.path),
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

    // Evict entries whose source file is gone from discovery (deleted, or
    // aged past every window). Only entries that THIS scan could have
    // re-discovered are candidates: the entry's provider must be selected
    // and its source path must live under one of the scanned roots, so
    // switching between custom --source-root stores never evicts entries
    // belonging to a store the current scan did not look at.
    async sweep(discoveredFiles, providers, scannedRoots) {
      if (!active) return;
      const keep = new Set(discoveredFiles.map((file) => `${stableSessionId(file.provider, file.path)}.json`));
      const roots = (scannedRoots || []).map((entry) => path.resolve(entry));
      const underScannedRoot = (sourcePath) => roots.some((scanned) => sourcePath === scanned || sourcePath.startsWith(`${scanned}${path.sep}`));
      let names = [];
      try {
        names = await fs.readdir(cacheRoot);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".json") || keep.has(name)) continue;
        const fullPath = path.join(cacheRoot, name);
        let remove = false;
        try {
          const entry = await readJson(fullPath);
          if (entry?.parser_version !== ANALYSIS_PARSER_VERSION || typeof entry?.source_path !== "string") {
            remove = true; // stale schema: useless to every future scan
          } else {
            remove = providers.includes(entry.provider) && underScannedRoot(entry.source_path);
          }
        } catch {
          remove = true; // unreadable entry is junk either way
        }
        if (!remove) continue;
        try {
          await fs.unlink(fullPath);
          stats.pruned += 1;
        } catch { /* leave it; never fail the scan over cache hygiene */ }
      }
    },
  };
}
