import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LOCK_STALE_MS = 300000;

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
  if (!existing || typeof existing.acquired_at !== "number") {
    return false;
  }

  if (Date.now() - existing.acquired_at <= LOCK_STALE_MS) {
    return false;
  }

  return !(existing.host === os.hostname() && isProcessAlive(existing.pid));
}

export async function acquireLock(root, operation) {
  const lockPath = path.join(root, ".agents", ".lock");

  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    // directory may already exist
  }

  const lockData = {
    pid: process.pid,
    operation,
    acquired_at: Date.now(),
    host: os.hostname(),
  };

  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(lockData));
    await handle.close();
    return { acquired: true, release: () => fs.unlink(lockPath).catch(() => {}) };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    try {
      const existing = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (canReclaimLock(existing)) {
        await fs.unlink(lockPath);
        return acquireLock(root, operation);
      }
      return {
        acquired: false,
        holder: existing,
        message: `Lock held by PID ${existing.pid} for '${existing.operation}' since ${new Date(existing.acquired_at).toISOString()}`,
      };
    } catch {
      return { acquired: false, message: "Lock exists but is unreadable" };
    }
  }
}
