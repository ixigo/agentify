import { createHash } from "node:crypto";

export function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function pathHash(...parts) {
  return sha1(parts.join(":"));
}
