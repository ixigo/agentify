// In-process network tripwire, preloaded into the CLI subprocess via
// `NODE_OPTIONS=--import`. It replaces every outbound-network primitive with a
// stub that RECORDS the attempt (to $NET_TRIP_FILE) and then throws. The default
// path (`git analyze` with no `--ai`/`--jira`) proves it opens no socket
// in-process — complementing the child-process provider spy.
//
// Two design points the reviewer flagged, both handled here:
//   * Recording, not just throwing. Fail-soft code can CATCH a thrown error, so
//     an exit-code-only check could stay green despite an attempt. The tripwire
//     FILE captures the attempt regardless of whether the throw is swallowed;
//     the test asserts the file stays empty.
//   * syncBuiltinESMExports(). Mutating a built-in module's properties does not,
//     by itself, update already-bound ESM named imports
//     (`import { request } from "node:https"`). We call syncBuiltinESMExports()
//     so the live bindings pick up the patched functions, and we ALSO patch the
//     low-level socket chokepoint (`net.Socket.prototype.connect`) so a socket
//     created by any means still trips.
//
// It does NOT affect child processes (the real git spawned by the shim runs in
// its own process) — only network attempted from within the CLI's own process.

import process from "node:process";
import module from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import fs from "node:fs";

const TRIP_FILE = process.env.NET_TRIP_FILE;

function record(what) {
  try {
    if (TRIP_FILE) fs.appendFileSync(TRIP_FILE, `${what}\n`);
  } catch { /* recording is best-effort; the throw below is the hard stop */ }
}

const trip = (what) => () => {
  record(what);
  // Fail hard so a real request cannot proceed. The attempt is already recorded
  // above, so even a caller that catches this still trips the assertion.
  throw new Error(`network blocked by conformance guard: ${what}`);
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

// The low-level chokepoint: every outbound TCP connection funnels through here,
// so patching it catches a socket created by any higher-level API even if a
// reference to the original was captured before this ran.
try {
  net.Socket.prototype.connect = trip("net.Socket.prototype.connect");
} catch { /* ignore */ }

for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  try { dns[name] = trip(`dns.${name}`); } catch { /* ignore */ }
  try { if (dns.promises) dns.promises[name] = trip(`dns.promises.${name}`); } catch { /* ignore */ }
  // dns.Resolver instances have their own methods; patch the prototype so a
  // `new dns.Resolver().resolve(...)` trips too.
  try { if (dns.Resolver?.prototype) dns.Resolver.prototype[name] = trip(`dns.Resolver.${name}`); } catch { /* ignore */ }
  try { if (dns.promises?.Resolver?.prototype) dns.promises.Resolver.prototype[name] = trip(`dns.promises.Resolver.${name}`); } catch { /* ignore */ }
}

// UDP (dgram) is a network egress path too.
try { dgram.createSocket = trip("dgram.createSocket"); } catch { /* ignore */ }

try { globalThis.fetch = trip("fetch"); } catch { /* ignore */ }

// Make ESM named imports of these built-ins observe the patched properties.
try { module.syncBuiltinESMExports(); } catch { /* ignore */ }
