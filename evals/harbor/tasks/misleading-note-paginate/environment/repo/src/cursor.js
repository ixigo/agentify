// feedpage — opaque cursor tokens over integer offsets.
// Clients treat the token as opaque; only these helpers read its contents.
export function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64");
}

export function decodeCursor(token) {
  const decoded = Buffer.from(token, "base64").toString("utf8");
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) {
    throw new Error("invalid cursor");
  }
  return Number(match[1]);
}
