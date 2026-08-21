import { createHmac, timingSafeEqual } from "node:crypto";

export function digest(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
