import { spawn } from "node:child_process";

import { ACP_PROVIDER_NAMES, getAcpAdapter } from "../provider-registry.js";

/**
 * Resolve the downstream ACP adapter command for a provider.
 *
 * Argv comes from the provider registry rather than being hard-coded here, so
 * the adapter for each provider lives in one place. An explicit `command`
 * override wins and can point at any binary (useful for adapters the registry
 * does not know about, or a locally built one).
 *
 * @returns {{ command: string, args: string[], source: string, package?: string, install?: string[] }}
 */
export function resolveDownstreamAdapter(provider, { command = null, extraArgs = [] } = {}) {
  if (command) {
    return { command, args: [...extraArgs], source: "override" };
  }
  if (!provider) {
    throw new Error(`agentify acp requires a downstream provider (one of: ${ACP_PROVIDER_NAMES.join(", ")}) or an explicit --command.`);
  }
  const adapter = getAcpAdapter(provider);
  if (!adapter) {
    throw new Error(`provider "${provider}" has no ACP adapter. Use one of: ${ACP_PROVIDER_NAMES.join(", ")}, or pass --command <bin>.`);
  }
  return {
    command: adapter.command,
    args: [...adapter.args, ...extraArgs],
    source: "registry",
    package: adapter.package,
    install: adapter.install,
    minNodeMajor: adapter.minNodeMajor || null,
  };
}

/**
 * Spawn the downstream adapter and expose its stdio as a raw byte duplex.
 *
 * stdout is the JSON-RPC channel; stderr is inherited (by default) so adapter
 * diagnostics reach the proxy's own stderr and never corrupt the protocol
 * stream. The caller owns the returned child and must terminate it.
 *
 * @returns {{ child: import("node:child_process").ChildProcess, duplex: { readable: import("node:stream").Readable, writable: import("node:stream").Writable } }}
 */
export function spawnDownstream(adapter, { cwd = process.cwd(), env = process.env, stderr = "inherit" } = {}) {
  const child = spawn(adapter.command, adapter.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", stderr],
    // Global npm bins (claude-agent-acp, codex-acp) are exposed as `.cmd` shims
    // on Windows, which cannot be spawned directly — they need a shell. The
    // command/args here come from the registry or the user's own --command, so
    // this is not an injection surface.
    shell: process.platform === "win32",
    // Put the adapter in its own process group on POSIX so terminateChild can
    // signal the whole tree (kill -pid), not just the immediate child — an
    // adapter that spawns helper processes must not leave them orphaned.
    detached: process.platform !== "win32",
  });
  return { child, duplex: { readable: child.stdout, writable: child.stdin } };
}

// Terminate the whole process tree for an owned child. On POSIX the child is a
// process-group leader (spawned `detached`), so a negative-pid signal reaches
// its helper subprocesses; on Windows `taskkill /T` walks the tree. Best-effort
// and never throws — the caller always bounds the wait separately.
function signalTree(child, signal) {
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      // taskkill may be missing; its launch failure arrives async as `error`.
      killer.once("error", () => {});
    } catch {
      // Nothing more we can do here.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Terminate an owned child process tree: SIGTERM, then SIGKILL after a grace
 * period. Resolves once the child has exited (or the grace window elapses). If
 * the immediate child already exited, its detached group may still hold helper
 * processes, so the group is still reaped before resolving.
 */
export function terminateChild(child, { graceMs = 2000 } = {}) {
  // No pid means the spawn failed (e.g. ENOENT) — nothing to reap.
  if (!child || !child.pid) {
    return Promise.resolve();
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    // The leader is gone but detached helpers may survive; reap the group.
    signalTree(child, "SIGKILL");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("error", finish);
    // Settle regardless once the grace period elapses, so shutdown can never
    // hang on an unresponsive child even if it never emits `exit`.
    timer = setTimeout(finish, graceMs);
    timer.unref?.();
    // Escalate to SIGKILL partway through the grace window if SIGTERM is ignored.
    const killTimer = setTimeout(() => signalTree(child, "SIGKILL"), Math.max(1, Math.floor(graceMs / 2)));
    killTimer.unref?.();
    child.once("exit", () => {
      clearTimeout(killTimer);
      // The leader is gone, but a detached helper may have ignored SIGTERM and
      // outlived it — SIGKILL the whole group to make sure nothing is orphaned.
      signalTree(child, "SIGKILL");
      finish();
    });
    signalTree(child, "SIGTERM");
  });
}
