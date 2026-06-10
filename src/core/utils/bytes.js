export function bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

export function clipToBytes(value, maxBytes) {
  const text = String(value || "");
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  if (bytes(text) <= maxBytes) {
    return text;
  }

  let end = text.length;
  while (end > 0) {
    const candidate = `${text.slice(0, end).trimEnd()}...`;
    if (bytes(candidate) <= maxBytes) {
      return candidate;
    }
    end -= 1;
  }

  return "";
}
