import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import process from "node:process";

export function createLockData(operation) {
  return {
    owner_id: randomUUID(),
    pid: process.pid,
    operation,
    acquired_at: Date.now(),
    host: os.hostname(),
  };
}

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

export function canReclaimLock(existing, staleMs) {
  if (!existing || typeof existing.acquired_at !== "number") {
    return false;
  }

  if (Date.now() - existing.acquired_at <= staleMs) {
    return false;
  }

  return !(existing.host === os.hostname() && isProcessAlive(existing.pid));
}

function ownsLock(current, expected) {
  if (!current || !expected) {
    return false;
  }

  if (current.owner_id && expected.owner_id) {
    return current.owner_id === expected.owner_id;
  }

  return current.pid === expected.pid
    && current.operation === expected.operation
    && current.acquired_at === expected.acquired_at
    && current.host === expected.host;
}

export async function unlinkLockIfOwned(lockPath, expected) {
  let current;
  try {
    current = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return false;
  }

  if (!ownsLock(current, expected)) {
    return false;
  }

  try {
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}
