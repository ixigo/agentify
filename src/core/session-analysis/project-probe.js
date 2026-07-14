import { createReadStream } from "node:fs";

const DEFAULT_PROBE_BYTES = 256 * 1024;

export async function probeSessionCwd(filePath, options = {}) {
  const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 16 * 1024 });
  const maxBytes = Number(options.maxBytes || DEFAULT_PROBE_BYTES);
  let buffered = "";
  let bytes = 0;

  try {
    for await (const chunk of input) {
      if (options.signal?.aborted) {
        const error = new Error("session analysis cancelled");
        error.code = "ABORT_ERR";
        throw error;
      }
      const remaining = maxBytes - bytes;
      if (remaining <= 0) break;
      const slice = Buffer.byteLength(chunk) > remaining ? Buffer.from(chunk).subarray(0, remaining).toString("utf8") : chunk;
      buffered += slice;
      bytes += Buffer.byteLength(slice);
      const match = buffered.match(/"cwd"\s*:\s*("(?:\\.|[^"\\])*")/);
      if (match) {
        try {
          const cwd = JSON.parse(match[1]);
          return typeof cwd === "string" && cwd.trim() ? cwd : null;
        } catch {
          return null;
        }
      }
      if (bytes >= maxBytes) break;
    }
  } finally {
    input.destroy();
  }
  return null;
}
