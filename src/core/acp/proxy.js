import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

// The ACP wire version this proxy was built and tested against. ACP is young;
// recording it makes an incompatible downstream adapter a diagnosable mismatch.
export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

function endWritable(writable) {
  try {
    if (!writable.writableEnded && !writable.destroyed) {
      writable.end();
    }
  } catch {
    // Already ended/destroyed.
  }
}

/**
 * Wire a transparent ACP pass-through proxy between a client (editor) byte
 * duplex and a downstream agent byte duplex.
 *
 * The forwarding is a raw *byte* relay built on Node streams (`.pipe()`): every
 * chunk read from one side is written unchanged to the other, in both
 * directions, with no parsing at all. That is what makes it genuinely
 * byte-for-byte — requests, responses, notifications, `$/cancel_request`,
 * batches, unknown/vendor extension methods, exact JSON-RPC ids (including
 * integers beyond 2^53, which a parse+reserialize relay would corrupt), key
 * order, and whitespace all survive untouched. This is essential for the trust
 * path: approval, permission, and elicitation traffic is never even
 * deserialized, let alone rewritten. Node's `.pipe()` also propagates
 * backpressure, so a slow client throttles the downstream instead of buffering
 * unboundedly.
 *
 * Because the relay never interprets ACP, it cannot get the protocol wrong and
 * needs no per-method logic. Message-level interposition — what #336 (injection)
 * and #337 (capture) require — is layered on top later by parsing a copy of the
 * stream (the SDK's `ndJsonStream` reads exactly this transport); to stay
 * byte-identical those features must forward unmodified messages as raw bytes
 * and only reserialize the ones they actually touch.
 *
 * `client` and `downstream` are each a byte duplex of Node streams
 * `{ readable: stream.Readable, writable: stream.Writable }` (a process's
 * stdio, or an in-memory `PassThrough`).
 *
 * @returns {{ closed: Promise<{ endedBy: "client" | "downstream" | null }>, close: () => void }}
 */
export function createAcpProxy({ client, downstream }) {
  if (!client?.readable || !client?.writable || !downstream?.readable || !downstream?.writable) {
    throw new Error("createAcpProxy requires client and downstream byte duplexes ({ readable, writable })");
  }

  // Which side hit EOF first: "client" (editor disconnected — a clean end) or
  // "downstream" (adapter transport closed — a failure, even if the adapter
  // process lingers). Stays null when torn down by close().
  let endedBy = null;
  let done = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  // Forward without letting `.pipe()` auto-end the destination: teardown ends
  // BOTH writables itself, so whichever side dies, the other peer always
  // receives EOF (a downstream crash closes the client stream, failing its
  // in-flight requests loudly instead of leaving them to hang).
  client.readable.pipe(downstream.writable, { end: false });
  downstream.readable.pipe(client.writable, { end: false });

  const finish = (who) => {
    if (who && !endedBy) {
      endedBy = who;
    }
    if (done) {
      return;
    }
    done = true;
    client.readable.unpipe(downstream.writable);
    downstream.readable.unpipe(client.writable);
    endWritable(downstream.writable);
    endWritable(client.writable);
    client.readable.destroy();
    downstream.readable.destroy();
    resolveClosed({ endedBy });
  };

  // Every stream event is attributed to its side: EOF/close/error on the client
  // streams ends the session as "client" (a disconnect), on the downstream
  // streams as "downstream" (a transport failure). Writable `error` handlers are
  // mandatory — an unhandled `error` (e.g. EPIPE writing to a dead peer) would
  // otherwise crash the whole proxy process instead of tearing down cleanly.
  client.readable.once("end", () => finish("client"));
  client.readable.once("close", () => finish("client"));
  client.readable.once("error", () => finish("client"));
  client.writable.once("error", () => finish("client"));
  client.writable.once("close", () => finish("client"));
  downstream.readable.once("end", () => finish("downstream"));
  downstream.readable.once("close", () => finish("downstream"));
  downstream.readable.once("error", () => finish("downstream"));
  downstream.writable.once("error", () => finish("downstream"));
  downstream.writable.once("close", () => finish("downstream"));

  return {
    closed,
    close: () => finish(null),
  };
}
