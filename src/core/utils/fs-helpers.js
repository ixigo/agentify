import fs from "node:fs/promises";

export async function readJsonIfExists(targetPath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readTextIfExists(targetPath, fallback = "") {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return fallback;
  }
}
