export function redactSensitiveText(value) {
  return String(value || "")
    // PEM private key blocks first: collapse the whole multiline block before any
    // inner base64 can partial-match another pattern below.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE[_-]?KEY)[A-Z0-9_-]*\s*[:=]\s*)(["']?)([^\s"'`,;]+)/gi,
      "$1$2[REDACTED]"
    )
    .replace(/\b((?:Bearer|Basic|Digest)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    // Credentials embedded in URLs: scheme://user:password@host
    .replace(/(:\/\/[^\s/:@]+:)[^\s/@]+(@)/g, "$1[REDACTED]$2")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{4,}\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    // Provider-specific tokens (anchored to their fixed prefixes — no entropy
    // heuristics, appended so the patterns above keep their exact behavior).
    // AWS access key ids (AKIA long-term, ASIA temporary).
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
    // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
    .replace(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    // Slack tokens (xoxb/xoxa/xoxp/xoxr/xoxs-...).
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    // GitLab personal access tokens.
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    // npm auth: .npmrc _authToken lines and npm_ automation tokens.
    .replace(/(\/\/registry\S*:_authToken=)\S+/g, "$1[REDACTED]")
    .replace(/\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED]")
    // Google API keys.
    .replace(/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED]");
}
