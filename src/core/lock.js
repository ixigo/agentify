import fs from "node:fs/promises";
import path from "node:path";

import { canReclaimLock, createLockData, unlinkLockIfOwned } from "./lock-file.js";

const LOCK_STALE_MS = 300000;

export async function acquireLock(root, operation) {
  const lockPath = path.join(root, ".agentify", ".lock");

  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    // directory may already exist
  }

  const lockData = createLockData(operation);

  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(lockData));
    await handle.close();
    return { acquired: true, release: () => unlinkLockIfOwned(lockPath, lockData) };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    try {
      const existing = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (canReclaimLock(existing, LOCK_STALE_MS)) {
        await unlinkLockIfOwned(lockPath, existing);
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
