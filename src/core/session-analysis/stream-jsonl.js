import { createReadStream } from "node:fs";

const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;

export async function streamJsonl(filePath, onRecord, options = {}) {
  const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const maxRecordBytes = Number(options.maxRecordBytes || DEFAULT_MAX_RECORD_BYTES);
  let records = 0;
  let malformed = 0;
  let oversized = 0;
  let blank = 0;
  let line = "";
  let lineBytes = 0;
  let discarding = false;

  const finishLine = async () => {
    const value = line.endsWith("\r") ? line.slice(0, -1) : line;
    line = "";
    lineBytes = 0;
    if (!value.trim()) {
      blank += 1;
      return;
    }
    let record;
    try {
      record = JSON.parse(value);
    } catch {
      malformed += 1;
      return;
    }
    records += 1;
    await onRecord(record);
  };

  const consume = async (fragment, endOfLine) => {
    if (discarding) {
      if (endOfLine) {
        discarding = false;
        oversized += 1;
      }
      return;
    }
    const fragmentBytes = Buffer.byteLength(fragment);
    if (lineBytes + fragmentBytes > maxRecordBytes) {
      line = "";
      lineBytes = 0;
      if (endOfLine) oversized += 1;
      else discarding = true;
      return;
    }
    line += fragment;
    lineBytes += fragmentBytes;
    if (endOfLine) await finishLine();
  };

  try {
    for await (const chunk of input) {
      if (options.signal?.aborted) {
        const error = new Error("session analysis cancelled");
        error.code = "ABORT_ERR";
        throw error;
      }
      let offset = 0;
      for (let newline = chunk.indexOf("\n", offset); newline !== -1; newline = chunk.indexOf("\n", offset)) {
        await consume(chunk.slice(offset, newline), true);
        offset = newline + 1;
      }
      if (offset < chunk.length) await consume(chunk.slice(offset), false);
    }
    if (discarding) oversized += 1;
    else if (lineBytes > 0) await finishLine();
  } finally {
    input.destroy();
  }

  return { records, malformed, oversized, blank };
}
