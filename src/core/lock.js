import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveLocalAgentifyPaths } from "./project-store.js";

const LOCK_STALE_MS = 300000;
const LOCK_NAMES = {
  "index-refresh": "index.lock",
  "cache-gc": "cache-gc.lock",
};

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function canReclaimLock(existing) {
  const acquiredAt = existing?.acquired_at || Date.parse(existing?.created_at || "");
  if (!existing || !Number.isFinite(acquiredAt)) {
    return false;
  }

  if (Date.now() - acquiredAt <= LOCK_STALE_MS) {
    return false;
  }

  const host = existing.host || existing.hostname;
  return !(host === os.hostname() && isProcessAlive(existing.pid));
}

async function acquireLockFile(lockPath, operation) {
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    // directory may already exist
  }

  const lockData = {
    pid: process.pid,
    hostname: os.hostname(),
    operation,
    created_at: new Date().toISOString(),
    acquired_at: Date.now(),
    host: os.hostname(),
  };

  // Write the payload to a temp file and hard-link it into place: the lock
  // file either exists with complete contents or not at all, so a crash can
  // never leave an empty lock behind.
  const tempPath = `${lockPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(lockData), { flag: "wx" });
    await fs.link(tempPath, lockPath);
    let released = false;
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.off(signal, signalHandlers.get(signal));
      }
      await fs.unlink(lockPath).catch(() => {});
    };
    const signalHandlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        release().finally(() => {
          process.kill(process.pid, signal);
        });
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    return { acquired: true, lock_path: lockPath, release };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    try {
      const existing = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (canReclaimLock(existing)) {
        await fs.unlink(lockPath);
        return acquireLockFile(lockPath, operation);
      }
      return {
        acquired: false,
        lock_path: lockPath,
        holder: existing,
        message: `Lock held by PID ${existing.pid} for '${existing.operation}' since ${existing.created_at || new Date(existing.acquired_at).toISOString()}`,
      };
    } catch {
      // Unparseable lock (e.g. left by an interrupted write from an older
      // version). Reclaim it once it is old enough to be stale rather than
      // blocking until someone deletes it by hand.
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath);
          return acquireLockFile(lockPath, operation);
        }
      } catch {
        // Lock disappeared or is unstat-able; report it as held either way.
      }
      return { acquired: false, lock_path: lockPath, message: "Lock exists but is unreadable" };
    }
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export async function acquireLock(root, operation) {
  const lockPath = resolveLocalAgentifyPaths(root).lockPath;
  return acquireLockFile(lockPath, operation);
}

export async function acquireProjectStoreLock(agentifyPaths, operation) {
  const fileName = LOCK_NAMES[operation] || `${operation}.lock`;
  return acquireLockFile(path.join(agentifyPaths.locksRoot, fileName), operation);
}
