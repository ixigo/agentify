// Child-process execution shared by the harnesses that grade work: the eval
// runner (paired benchmark attempts) and the loop runner (gates and agent
// iterations).
//
// Both need the same three properties, which `execFile` does not give:
// - a hard wall-clock kill that reaches grandchildren (provider CLIs and shell
//   pipelines spawn their own children, and killing only the direct child
//   leaves them running and the promise hanging),
// - captured stdout/stderr capped at a fixed size so a runaway process cannot
//   exhaust memory, keeping the *tail* because result envelopes arrive last,
// - resolution rather than rejection on failure: a non-zero exit is data to be
//   graded, not an exception to be caught.

import { spawn } from "node:child_process";

// Keep only the newest bytes when a child floods stdout/stderr.
export const MAX_CAPTURE_CHARS = 8 * 1024 * 1024;

export function appendCapped(buffer, chunk, limit = MAX_CAPTURE_CHARS) {
  const next = buffer + chunk;
  return next.length > limit ? next.slice(-limit) : next;
}

/**
 * Run a command to completion, never rejecting.
 *
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runProcess(command, args, { cwd, env, timeoutMs, shell = false }) {
  return new Promise((resolve) => {
    // detached puts the child in its own process group so a timeout kill
    // reaches grandchildren (provider subprocesses, setup script pipelines).
    const child = shell
      ? spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/**
 * Spawn a long-lived background process (a dev server) and hand back a stop
 * handle. Output is captured for the run report; nothing is inherited, so a
 * server that logs forever cannot flood the caller's terminal.
 */
export function startBackgroundProcess(command, { cwd, env }) {
  const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const handle = {
    pid: child.pid,
    output: "",
    exited: false,
    exit_code: null,
  };
  child.stdout.on("data", (chunk) => { handle.output = appendCapped(handle.output, chunk, 256 * 1024); });
  child.stderr.on("data", (chunk) => { handle.output = appendCapped(handle.output, chunk, 256 * 1024); });
  child.on("close", (code) => {
    handle.exited = true;
    handle.exit_code = code ?? 1;
  });
  child.on("error", (error) => {
    handle.exited = true;
    handle.exit_code = 127;
    handle.output = appendCapped(handle.output, `\n${error.message}`, 256 * 1024);
  });
  handle.stop = async () => {
    if (handle.exited) {
      return;
    }
    // Kill the whole group: dev servers routinely fork a bundler and a watcher
    // that would otherwise survive and hold the port for the next run.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        resolve();
      }, 5000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return handle;
}

/**
 * Poll a URL until it answers or the deadline passes. Any HTTP response counts
 * as ready — a dev server returning 404 for the root path is still up, and
 * demanding 2xx would fail readiness for apps with no index route.
 */
export async function waitForUrl(url, { timeoutMs = 90000, intervalMs = 500, fetchImpl = fetch, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "manual" });
      return { ready: true, status: response.status };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { ready: false, error: lastError ? String(lastError.message || lastError) : "timed out" };
}
