import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "bin",
  "obj"
]);

export async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function walkFiles(root) {
  const files = [];

  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await visit(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  await visit(root);
  return files;
}

export function relative(root, targetPath) {
  return path.relative(root, targetPath).split(path.sep).join("/");
}

export async function writeText(targetPath, text) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, text, "utf8");
}

export async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8");
}
