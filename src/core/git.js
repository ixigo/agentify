import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getHeadCommit(root) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    return stdout.trim();
  } catch {
    return "nogit";
  }
}

export async function getChangedFiles(root) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z"],
      { cwd: root }
    );
    if (!stdout) return [];

    const entries = [];
    const parts = stdout.split("\0").filter(Boolean);
    let i = 0;
    while (i < parts.length) {
      const entry = parts[i];
      const statusCode = entry.slice(0, 2);
      const filePath = entry.slice(3);

      if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
        i += 1;
        const destination = parts[i] || filePath;
        entries.push({
          status: statusCode.trim(),
          path: destination,
          origPath: filePath,
        });
      } else {
        entries.push({
          status: statusCode.trim(),
          path: filePath,
        });
      }
      i += 1;
    }
    return entries;
  } catch {
    return [];
  }
}

export async function getChangedFilesSince(root, sinceCommit) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-status", "-z", sinceCommit, "HEAD"],
      { cwd: root }
    );
    if (!stdout) return [];

    const parts = stdout.split("\0").filter(Boolean);
    const entries = [];
    let i = 0;
    while (i < parts.length) {
      const status = parts[i];
      i += 1;
      const filePath = parts[i];
      i += 1;
      if (status && filePath) {
        entries.push({ status: status.charAt(0), path: filePath });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export async function getFileContentAtHead(root, filePath) {
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${filePath}`], { cwd: root });
    return stdout;
  } catch {
    return null;
  }
}
