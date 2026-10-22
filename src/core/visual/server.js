import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export function fillPort(parts, port) {
  return parts.map((part) => part.replaceAll("{port}", String(port)));
}

export function startServer({ server, port, label = "app", spawnImpl = spawn }) {
  const [command, ...args] = fillPort(server.command, port);
  const child = spawnImpl(command, args, {
    cwd: server.cwd,
    env: { ...process.env, ...server.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const output = [];
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  return {
    label,
    child,
    output: () => output.join("").slice(-4000),
    exited: () => exited,
    stop() {
      if (exited) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}

export async function waitForServer(url, { timeoutMs = 90_000, handle, fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (handle?.exited()) {
      throw new Error(`${handle.label} server exited before it was ready (${JSON.stringify(handle.exited())}):\n${handle.output()}`);
    }
    try {
      const response = await fetchImpl(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Server did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s${handle ? `:\n${handle.output()}` : ""}`);
}

export function resolvePlaywright(roots) {
  const attempts = [];
  const extra = process.env.AGENTIFY_PLAYWRIGHT_FROM ? [path.resolve(process.env.AGENTIFY_PLAYWRIGHT_FROM)] : [];
  for (const root of [...extra, ...roots, path.dirname(new URL(import.meta.url).pathname)]) {
    try {
      const require = createRequire(path.join(root, "package.json"));
      const playwright = require("playwright");
      let expect = null;
      try {
        expect = require("playwright/test").expect;
      } catch {}
      return { chromium: playwright.chromium, expect, from: root };
    } catch (error) {
      attempts.push(`${root}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(`agentify visual needs Playwright. Install it in the project (pnpm add -D playwright && pnpm exec playwright install chromium).\nTried:\n  ${attempts.join("\n  ")}`);
}
