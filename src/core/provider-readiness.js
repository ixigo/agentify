// One shared provider-readiness probe (#395). Before this, `agentify models`
// read a provider as "available" from `command -v` alone (a binary that exists
// but crashes on launch counted as available), while `doctor` ran a real
// `--version` and reported the same binary as MISSING — so the two commands
// disagreed, and a logged-out CLI was still chosen as a route target with no
// warning.
//
// This module is the single source of truth both commands use, so they cannot
// disagree. Readiness has three independent facts and one canonical state:
//
//   exists   — the binary is on PATH (`command -v`)
//   launches — the binary starts (`<bin> --version` exits 0)
//   auth     — the provider's own auth probe (login/credential state)
//
//   state:
//     missing    — not on PATH
//     broken     — on PATH but cannot start (e.g. a dyld crash at launch)
//     logged_out — starts, but the provider is not authenticated
//     ready      — starts and authenticated
//     unknown    — starts, auth could not be verified either way
//
// Probes are read-only and never spend tokens: only `--version` and the
// provider's login/credential check run. Results are memoized per process on
// the runtime object so repeated readiness queries in one command do not
// re-spawn. The launch/auth checks run only when an `exec` seam is supplied;
// with presence detection alone (no exec) the probe degrades to the legacy
// "installed == usable" behavior so existing call sites keep working.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DELEGATE_PROVIDER_NAMES, EXECUTABLE_PROVIDER_NAMES, getProviderDefinition } from "./provider-registry.js";

const execFileAsync = promisify(execFile);

export const READINESS_STATES = ["ready", "logged_out", "broken", "missing", "unknown"];
// States a route target must NOT be in to be chosen. logged_out and broken are
// the two the preflight skips over; missing is a provider that is not installed.
export const SELECTABLE_STATE = "ready";

async function defaultCommandExists(command) {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", 'command -v -- "$1"', "sh", command]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

// Read-only command capture used for the `--version` launch check and the
// provider auth probe. Never runs a provider agent (no tokens). Shares the
// shape the registry's probeAuth functions expect: { code, stdout, stderr }.
export async function defaultReadinessExec(argv, { cwd, env = process.env } = {}) {
  const [command, ...rest] = argv;
  try {
    const { stdout, stderr } = await execFileAsync(command, rest, { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { code: 127, stdout: "", stderr: `${command}: command not found` };
    }
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || ""),
    };
  }
}

function firstLine(value) {
  return String(value || "").trim().split("\n")[0] || "";
}

function parseVersion(stdout, stderr = "") {
  const match = `${stdout}\n${stderr}`.match(/(\d+\.\d+\.\d+|\d+\.\d+|\d+)/);
  return match ? match[1] : "unknown";
}

// Collapse the three facts into the canonical state. `auth` is the registry
// probeAuth result ({ state: ready|missing|unknown, detail, nextStep }).
export function canonicalReadinessState({ exists, launches, auth }) {
  if (!exists) return { state: "missing", detail: "binary not found on PATH", next_step: null };
  if (launches === false) return { state: "broken", detail: "binary found but fails to launch", next_step: null };
  const authState = auth?.state || "unknown";
  if (authState === "ready") return { state: "ready", detail: auth.detail || "logged in", next_step: null };
  if (authState === "missing") return { state: "logged_out", detail: auth.detail || "login required", next_step: auth.nextStep || null };
  return { state: "unknown", detail: auth?.detail || "auth not verified", next_step: auth?.nextStep || null };
}

// Probe one provider. Seams (all optional): commandExists(bin) -> bool,
// exec(argv, {cwd,env}) -> {code,stdout,stderr}. With no exec the probe is
// presence-only (installed == ready) so legacy callers that inject only
// commandExists keep their behavior.
export async function probeProviderReadiness(provider, opts = {}) {
  const { commandExists, exec, env = process.env, homeDir = process.env.HOME, cwd } = opts;
  const definition = getProviderDefinition(provider);
  const bootstrap = definition?.bootstrap || {};
  const binary = bootstrap.bin || provider;
  const installHint = bootstrap.install ? bootstrap.install.join(" ") : `install ${binary}`;
  const existsFn = commandExists || defaultCommandExists;
  const exists = Boolean(await existsFn(binary));

  // Presence-only mode (no launch/auth seam): installed == usable == ready.
  if (!exec) {
    return {
      name: provider,
      binary,
      exists,
      launches: null,
      version: null,
      available: exists,
      auth: { state: "skipped", detail: exists ? "not checked" : "binary not found on PATH", next_step: null },
      state: exists ? "ready" : "missing",
      state_detail: exists ? "installed (launch and auth not probed)" : "binary not found on PATH",
      next_step: null,
      install_hint: installHint,
      ...(exists ? {} : { reason: "command not found" }),
    };
  }

  let launches = null;
  let version = null;
  let auth = { state: "skipped", detail: "binary missing", nextStep: null };
  if (exists) {
    const versionResult = await exec([binary, ...(bootstrap.checkArgs || ["--version"])], { cwd, env });
    launches = versionResult.code === 0;
    version = launches ? parseVersion(versionResult.stdout, versionResult.stderr) : null;
    if (launches && definition?.probeAuth) {
      try {
        auth = await definition.probeAuth({ cwd, env, homeDir, exec });
      } catch (error) {
        auth = { state: "unknown", detail: firstLine(error?.message) || "auth not verified", nextStep: bootstrap.loginCommand || null };
      }
    } else if (launches) {
      auth = { state: "unknown", detail: "auth not verified", nextStep: bootstrap.loginCommand || null };
    }
  }

  const canonical = canonicalReadinessState({ exists, launches, auth });
  return {
    name: provider,
    binary,
    exists,
    launches,
    version,
    available: launches === true,
    auth: {
      state: auth?.state || "skipped",
      detail: auth?.detail || (launches ? "auth not verified" : "binary missing"),
      next_step: auth?.nextStep ?? null,
    },
    state: canonical.state,
    state_detail: canonical.detail,
    next_step: canonical.next_step ?? (canonical.state === "logged_out" ? bootstrap.loginCommand || null : null),
    install_hint: installHint,
    ...(exists ? {} : { reason: "command not found" }),
    ...(exists && launches === false ? { check_status: "failed" } : {}),
  };
}

// Readiness seams carried on a runtime object. A per-process cache lives on the
// runtime so repeated queries in one command do not re-spawn probes; a fresh
// runtime (one per command, one per test) starts with an empty cache.
function readinessSeams(runtime = {}) {
  return {
    commandExists: runtime.commandExists,
    exec: runtime.readinessExec,
    env: runtime.env || process.env,
    homeDir: runtime.home || runtime.homeDir || process.env.HOME,
    cwd: runtime.cwd,
  };
}

async function probeInto(cache, provider, seams) {
  if (cache.has(provider)) return cache.get(provider);
  const result = await probeProviderReadiness(provider, seams);
  cache.set(provider, result);
  return result;
}

// Readiness for every delegate provider, as { provider: readiness }.
export async function detectDelegateReadiness(runtime = {}) {
  const seams = readinessSeams(runtime);
  const cache = runtime._readinessCache || (runtime._readinessCache = new Map());
  const entries = await Promise.all(
    DELEGATE_PROVIDER_NAMES.map(async (provider) => [provider, await probeInto(cache, provider, seams)]),
  );
  return Object.fromEntries(entries);
}

// Readiness for every executable provider (doctor's wider set).
export async function detectExecutableReadiness(runtime = {}) {
  const seams = readinessSeams(runtime);
  const cache = runtime._readinessCache || (runtime._readinessCache = new Map());
  const entries = await Promise.all(
    EXECUTABLE_PROVIDER_NAMES.map(async (provider) => [provider, await probeInto(cache, provider, seams)]),
  );
  return Object.fromEntries(entries);
}

// Boolean availability map (ready only) for selection over a fallback chain.
export function readinessAvailability(readiness) {
  return Object.fromEntries(
    Object.entries(readiness).map(([provider, info]) => [provider, info.state === SELECTABLE_STATE]),
  );
}
