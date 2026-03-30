import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_STALE_MS = 300000;

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
      if (Date.now() - existing.acquired_at > LOCK_STALE_MS) {
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
