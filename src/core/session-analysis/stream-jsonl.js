import { createReadStream } from "node:fs";
import readline from "node:readline";

// Bounded-memory JSONL reader: session histories can be hundreds of MB, so
// records are handed to the caller one line at a time and never accumulated.
export async function streamJsonlRecords(filePath, onRecord) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  let malformed = 0;
  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines += 1;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // Truncated final lines and corrupt records are coverage, not errors.
        malformed += 1;
        continue;
      }
      if (record !== null && typeof record === "object") {
        await onRecord(record);
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return { lines, malformed };
}
