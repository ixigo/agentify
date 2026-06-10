export const DEFAULT_CAPTURE_MAX_KB = 48;

export function normalizeCaptureMaxBytes(maxKb, fallbackKb = DEFAULT_CAPTURE_MAX_KB) {
  const normalizedKb = Number.isFinite(Number(maxKb)) && Number(maxKb) > 0 ? Number(maxKb) : fallbackKb;
  return Math.floor(normalizedKb * 1024);
}

export function createBoundedCaptureBuffer(maxBytes) {
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 0;
  const chunks = [];
  let capturedBytes = 0;
  let seenBytes = 0;

  return {
    append(chunk) {
      if (!chunk?.length) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      seenBytes += buffer.length;

      if (limit <= 0 || capturedBytes >= limit) {
        return;
      }

      const remaining = limit - capturedBytes;
      const slice = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
      chunks.push(Buffer.from(slice));
      capturedBytes += slice.length;
    },
    toString() {
      return capturedBytes > 0 ? Buffer.concat(chunks, capturedBytes).toString("utf8") : "";
    },
    get capturedBytes() {
      return capturedBytes;
    },
    get seenBytes() {
      return seenBytes;
    },
    get truncated() {
      return seenBytes > capturedBytes;
    },
  };
}
