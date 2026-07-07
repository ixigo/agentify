export function redactSensitiveText(value) {
  return String(value || "")
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE[_-]?KEY)[A-Z0-9_-]*\s*[:=]\s*)(["']?)([^\s"'`,;]+)/gi,
      "$1$2[REDACTED]"
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{4,}\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]");
}
