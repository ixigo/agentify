import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, exists, readJson, writeJson } from "./fs.js";

function blobHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function blobPath(cacheRoot, hash) {
  return path.join(cacheRoot, "blobs", hash.slice(0, 2), `${hash}.blob`);
}

export async function storeBlob(cacheRoot, content) {
  const hash = blobHash(content);
  const target = blobPath(cacheRoot, hash);
  if (await exists(target)) return hash;
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, content, "utf8");
  return hash;
}

export async function readBlob(cacheRoot, hash) {
  return fs.readFile(blobPath(cacheRoot, hash), "utf8");
}

export async function updateManifest(cacheRoot, moduleId, blobRefs) {
  const manifestPath = path.join(cacheRoot, "manifest.json");
  const manifest = (await exists(manifestPath)) ? await readJson(manifestPath) : { modules: {} };
  manifest.modules[moduleId] = {
    blobs: blobRefs,
    updated_at: new Date().toISOString(),
  };
  await writeJson(manifestPath, manifest);
}

export async function garbageCollect(cacheRoot, maxAgeDays = 7) {
  const manifestPath = path.join(cacheRoot, "manifest.json");
  if (!(await exists(manifestPath))) return { removed: 0 };

  const manifest = await readJson(manifestPath);
  const referencedHashes = new Set();
  const cutoff = Date.now() - maxAgeDays * 86400000;

  for (const [moduleId, entry] of Object.entries(manifest.modules)) {
    const updatedAt = new Date(entry.updated_at).getTime();
    if (updatedAt < cutoff) {
      delete manifest.modules[moduleId];
    } else {
      for (const hash of entry.blobs) referencedHashes.add(hash);
    }
  }

  let removed = 0;
  const blobsRoot = path.join(cacheRoot, "blobs");
  if (await exists(blobsRoot)) {
    const prefixes = await fs.readdir(blobsRoot);
    for (const prefix of prefixes) {
      const prefixDir = path.join(blobsRoot, prefix);
      let files;
      try {
        files = await fs.readdir(prefixDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const hash = file.replace(".blob", "");
        if (!referencedHashes.has(hash)) {
          await fs.unlink(path.join(prefixDir, file));
          removed += 1;
        }
      }
    }
  }

  await writeJson(manifestPath, manifest);
  return { removed };
}

export async function cacheStatus(cacheRoot) {
  const manifestPath = path.join(cacheRoot, "manifest.json");
  if (!(await exists(manifestPath))) {
    return { entries: 0, blobs: 0, totalSize: 0 };
  }

  const manifest = await readJson(manifestPath);
  const moduleCount = Object.keys(manifest.modules).length;

  let blobCount = 0;
  let totalSize = 0;
  const blobsRoot = path.join(cacheRoot, "blobs");
  if (await exists(blobsRoot)) {
    const prefixes = await fs.readdir(blobsRoot);
    for (const prefix of prefixes) {
      const prefixDir = path.join(blobsRoot, prefix);
      let files;
      try {
        files = await fs.readdir(prefixDir);
      } catch {
        continue;
      }
      for (const file of files) {
        blobCount += 1;
        try {
          const stat = await fs.stat(path.join(prefixDir, file));
          totalSize += stat.size;
        } catch {
          // skip unreadable blobs
        }
      }
    }
  }

  return { entries: moduleCount, blobs: blobCount, totalSize };
}
