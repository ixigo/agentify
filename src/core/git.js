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
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: root });
    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}
