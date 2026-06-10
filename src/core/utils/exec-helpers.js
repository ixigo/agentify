import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommandCapture(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        resolve({ code: 127, stdout: "", stderr: `${cmd}: command not found`, missing: true });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        missing: false,
      });
    });

    child.stdin.end(options.input || "");
  });
}

export async function runGit(targetPath, args, options = {}) {
  const useCwd = Boolean(options.cwdMode);
  const execOptions = {
    maxBuffer: 1024 * 1024 * 10,
    ...(options.execOptions || {}),
  };
  const gitArgs = useCwd ? args : ["-C", targetPath, ...args];
  if (useCwd) {
    execOptions.cwd = targetPath;
  }

  try {
    const { stdout } = await execFileAsync("git", gitArgs, execOptions);
    return stdout.trim();
  } catch (error) {
    if (options.nullOnError) {
      return null;
    }
    if (options.failureMessage) {
      throw new Error(options.failureMessage);
    }
    throw error;
  }
}

export function isProcessAlive(pid) {
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

export function killChildProcess(child, signal, options = {}) {
  if (options.processGroup && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between timeout scheduling and signal delivery.
  }
}
