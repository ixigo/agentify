import path from "node:path";

import { ACP_PROTOCOL_VERSION, createAcpProxy } from "./proxy.js";
import { resolveDownstreamAdapter, spawnDownstream, terminateChild } from "./downstream.js";
import { buildInjectionDigest, createFirstTurnInjector, resolveAcpInjectionMode } from "./inject.js";

export { ACP_PROTOCOL_VERSION, createAcpProxy } from "./proxy.js";
export { resolveDownstreamAdapter, spawnDownstream, terminateChild } from "./downstream.js";
export {
  ACP_INJECTION_MODES,
  AGENTIFY_CONTEXT_CLOSE,
  AGENTIFY_CONTEXT_OPEN,
  buildInjectionDigest,
  createFirstTurnInjector,
  extractPromptText,
  extractTopLevelRawId,
  injectIntoPromptMessage,
  markInjectedBlock,
  normalizeAcpInjectionMode,
  resolveAcpInjectionMode,
} from "./inject.js";

function describeAdapter(adapter) {
  return adapter.args.length > 0 ? `${adapter.command} ${adapter.args.join(" ")}` : adapter.command;
}

/**
 * `agentify acp` — run the ACP pass-through proxy over stdio.
 *
 * Speaks ACP to the connecting client on stdin/stdout and to a downstream
 * adapter (resolved from the provider registry, or an explicit `--command`)
 * over the child's stdio, forwarding every message in both directions
 * unchanged. Owns the child process: it is terminated when the client
 * disconnects, and its death closes the proxy so in-flight requests fail loudly
 * instead of hanging.
 */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

export async function runAcpProxyCommand(root, config, args, options = {}) {
  const provider = args.provider ? String(args.provider) : config.provider;
  // If `--command` is present at all it must be a non-empty string. A bare
  // `--command`, `--command=`, `--command=false`, or `--command=0` must not
  // silently fall back to the provider default — reject the malformed override.
  let command = null;
  if (Object.prototype.hasOwnProperty.call(args, "command")) {
    if (typeof args.command !== "string" || args.command.trim() === "") {
      throw new Error("agentify acp: --command requires a non-empty value (the downstream adapter binary).");
    }
    command = args.command;
  }
  const adapter = resolveDownstreamAdapter(provider, { command });

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const log = options.log || ((message) => process.stderr.write(`${message}\n`));
  const env = options.env || process.env;

  // Decide session-start context injection (#336) before spawning: whether we
  // inject determines the downstream's environment (see below). This is the
  // static decision (config + env recursion guard); the transient `ctx pause`
  // marker is re-checked per session-start when the digest is built.
  const injectionMode = resolveAcpInjectionMode(config, env);
  const injecting = injectionMode !== "off";

  // Double-injection guard: if we inject, the downstream provider's own
  // Agentify hooks (e.g. Claude Code) must NOT also inject the digest, or a
  // session gets it twice. AGENTIFY_CTX_INJECTION=off is the narrow, existing
  // switch the hooks path already honors (resolveInjectionMode reads it first,
  // the same lever eval ablations use): it turns the downstream's prompt/digest
  // injection off while leaving its context TRACKING (edits, commands, session
  // summaries) intact — unlike AGENTIFY_CTX=off, which pauses tracking too.
  // When we are not injecting we leave the environment untouched, preserving
  // #335's exact pass-through behaviour.
  //
  // Known trade-off: AGENTIFY_CTX_INJECTION=off is the only existing lever that
  // suppresses the downstream's context injection, and the hooks path gates its
  // PreToolUse failed-command precheck behind the same mode, so an injecting ACP
  // session also loses the downstream's precheck warnings. Tracking is
  // preserved; a per-feature lever would be a change to the shared hooks path,
  // out of scope for #336.
  const childEnv = injecting ? { ...env, AGENTIFY_CTX_INJECTION: "off" } : env;

  const { child, duplex: downstreamDuplex } = spawnDownstream(adapter, {
    cwd: root,
    env: childEnv,
    stderr: options.stderr || "inherit",
  });

  // Client -> downstream stream: interpose the first-turn injector only when
  // injecting, so untouched sessions keep the raw byte relay verbatim. The
  // reverse direction (downstream -> client) is never interposed.
  let clientReadable = input;
  if (injecting) {
    const injector = createFirstTurnInjector({
      buildDigest: (promptText, opts) => buildInjectionDigest(root, {
        mode: injectionMode,
        promptText,
        config,
        env,
        // Scope injection dedupe to the ACP session, not a shared "unknown"
        // ledger key, so context injected in one session isn't suppressed as
        // "already seen" in the next.
        sessionId: opts?.sessionId,
      }),
      onInject: ({ sessionId }) => log(`agentify acp: injected ${injectionMode} context into the first turn of session ${sessionId}`),
      // Privacy: only inject when a session's working directory is the same repo
      // the proxy reads context from. A session established elsewhere (a
      // long-lived proxy reused across repos) must not receive this root's notes.
      isSameWorkspace: (cwd) => typeof cwd === "string" && path.resolve(cwd) === path.resolve(root),
    });
    // The proxy observes the injector (clientReadable), not `input`. So the
    // ways `input` can terminate must reach the injector: a clean EOF is
    // forwarded by pipe (end -> injector end -> proxy "client" end); an error
    // or an abrupt close (destroy without EOF) would otherwise leave the
    // injector — and therefore the proxy and child — open forever, so mirror
    // those onto the injector.
    input.once("error", () => { injector.destroy(); });
    input.once("close", () => { if (!injector.writableEnded) injector.destroy(); });
    input.pipe(injector);
    clientReadable = injector;
    log(`agentify acp: session-start context injection enabled (mode: ${injectionMode}; downstream Agentify hook injection suppressed via AGENTIFY_CTX_INJECTION=off, tracking preserved)`);
  }

  const clientDuplex = { readable: clientReadable, writable: output };
  if (typeof options.onSpawn === "function") {
    options.onSpawn(child);
  }

  // The adapter may require a newer Node than Agentify's floor (Node 20); warn
  // clearly rather than let it fail with a cryptic runtime/install error.
  if (adapter.minNodeMajor) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (Number.isFinite(nodeMajor) && nodeMajor < adapter.minNodeMajor) {
      log(`agentify acp: warning — "${adapter.command}" requires Node >= ${adapter.minNodeMajor}, but this is Node ${process.versions.node}; the adapter may fail to launch.`);
    }
  }

  log(`agentify acp: forwarding ACP v${ACP_PROTOCOL_VERSION} to downstream "${describeAdapter(adapter)}" (${adapter.source})`);

  const proxy = createAcpProxy({ client: clientDuplex, downstream: downstreamDuplex });

  // Observe the child's fate without ever blocking on it: `spawnError` for a
  // failed launch, `exitInfo` for its exit status, `downstreamCrashed` when it
  // dies on its own (before we terminate it). A launch failure or an exit closes
  // the proxy, which sends EOF to the client so in-flight requests fail loudly
  // rather than hanging.
  let spawnError = null;
  let exitInfo = null;
  let stopping = false;
  let downstreamCrashed = false;
  child.once("error", (error) => { spawnError = error; proxy.close(); });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    if (!stopping) {
      downstreamCrashed = true;
    }
    proxy.close();
  });

  const handleSignals = options.handleSignals !== false;
  let interruptedBy = null;
  const onSignal = (signalName) => {
    // Interrupting the proxy is a cancellation, not a clean run — record it so
    // the exit code (128+signum) lets supervisors tell it apart from success.
    interruptedBy = signalName;
    proxy.close();
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  if (handleSignals) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }

  let endedBy = null;
  try {
    // Resolves when either side of the proxy closes: endedBy is "client" (clean
    // disconnect), "downstream" (adapter transport died — a failure), or null
    // (torn down by a signal or a spawn error).
    ({ endedBy } = await proxy.closed);
  } finally {
    if (handleSignals) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
    // No orphans: terminate the process tree we own on the way out.
    // terminateChild is bounded (SIGTERM, then SIGKILL, then it settles
    // regardless), so shutdown can never hang on an unresponsive adapter. Set
    // `stopping` first so the exit it triggers is not misread as a crash.
    stopping = true;
    await terminateChild(child);
    // When injecting, the proxy tore down the injector (clientReadable) but not
    // its source `input`; destroy it so stdin/the client stream is released
    // exactly as the non-injecting pass-through does (proxy destroys `input`
    // directly there).
    if (injecting && clientReadable !== input) {
      input.destroy();
    }
  }

  const downstreamFailed = Boolean(spawnError) || downstreamCrashed || endedBy === "downstream";
  if (spawnError) {
    const hint = spawnError.code === "ENOENT" && adapter.install
      ? ` — command not found; install with: ${adapter.install.join(" ")}`
      : spawnError.code === "ENOENT"
        ? " — command not found"
        : `: ${spawnError.message}`;
    log(`agentify acp: downstream adapter "${adapter.command}" could not run${hint}`);
  } else if (downstreamCrashed) {
    // The adapter exited on its own; exitInfo is its genuine cause.
    const how = exitInfo?.signal
      ? `was killed by signal ${exitInfo.signal}`
      : `exited with code ${exitInfo?.code}`;
    log(`agentify acp: downstream adapter "${adapter.command}" ${how}`);
  } else if (endedBy === "downstream") {
    // The adapter closed its transport but lingered; we terminated it during
    // cleanup, so do not blame our own signal — report the transport failure.
    log(`agentify acp: downstream adapter "${adapter.command}" closed its connection unexpectedly`);
  }

  const failed = downstreamFailed || Boolean(interruptedBy);

  const result = {
    command: "acp",
    provider: command ? null : provider,
    downstream: { command: adapter.command, args: adapter.args, source: adapter.source },
    protocol_version: ACP_PROTOCOL_VERSION,
    ended_by: endedBy,
    exit_code: exitInfo?.code ?? null,
    signal: exitInfo?.signal ?? null,
    interrupted_by: interruptedBy,
    failed,
  };

  if (options.setExitCode !== false) {
    if (interruptedBy) {
      process.exitCode = SIGNAL_EXIT_CODES[interruptedBy] || 1;
    } else if (failed) {
      process.exitCode = 1;
    }
  }
  return result;
}
