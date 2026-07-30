// In-process network tripwire, preloaded into the CLI subprocess via
// `NODE_OPTIONS=--import`. It replaces every outbound-network primitive with a
// throwing stub, so the default path (`git analyze` with no `--ai`/`--jira`)
// proves it opens no socket IN-PROCESS — complementing the child-process
// provider spy. If a future slice adds a bare `fetch`/`https.request` on the
// default path, the run throws and the conformance suite fails loudly.
//
// It does NOT affect child processes (the real git spawned by the shim runs in
// its own process), only network attempted from within the CLI's own process.

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";

const trip = (what) => () => {
  throw new Error(`network blocked by conformance guard: ${what} was called on the default path`);
};

for (const [mod, name] of [
  [net, "connect"],
  [net, "createConnection"],
  [tls, "connect"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
]) {
  try { mod[name] = trip(`${name}`); } catch { /* frozen export: best effort */ }
}

// DNS resolution is a strong proxy for "about to open a socket".
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  try { dns[name] = trip(`dns.${name}`); } catch { /* ignore */ }
  try { if (dns.promises) dns.promises[name] = trip(`dns.promises.${name}`); } catch { /* ignore */ }
}

// Global fetch (Node 18+).
try {
  globalThis.fetch = trip("fetch");
} catch { /* ignore */ }
