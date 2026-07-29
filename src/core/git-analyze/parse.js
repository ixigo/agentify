// Pure parsers for `agentify git analyze`. No I/O, no git, no clock: each
// function takes already-decoded strings from a commit and returns structured
// facts. Kept pure so #351/#352 can reuse them and so they are cheap to test
// against hostile inputs.
//
// The commit record shape these feed is frozen in #349 (see collect.js); do not
// change the meaning of a field a downstream slice already consumes.

// Conventional commit subject: `type(scope)!: description`.
//   - type: a lowercase-ish word (feat, fix, chore, refactor, ...). Required.
//   - (scope): optional, any non-paren text.
//   - !: optional breaking marker before the colon.
//   - ": " separator is mandatory — this is what distinguishes `wip` and
//     `fixes stuff` (no colon) from a real conventional subject.
const CONVENTIONAL_SUBJECT = /^([a-zA-Z]+)(?:\(([^()\r\n]+)\))?(!)?:\s/;

// GitHub-style reference: `#123`. Rejected when glued to a preceding word char
// (so `abc#1` is not a ref) or an HTML entity ampersand (`&#123;`). Not anchored
// to end so `(#123)` and `fixes #123.` both match.
const GITHUB_REF = /(?<![\w&])#(\d+)\b/g;

// Jira-style key: 2-10 char uppercase project key, a dash, then digits.
// `[A-Z][A-Z0-9]{1,9}` requires a leading letter and total length 2-10. The
// trailing `(?![-\d])` rejects multi-group hyphenated identifiers (e.g.
// `CVE-2024-12345`, `CWE-79`), so only single-group `PROJ-123` keys match.
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d+)(?![-\d])/g;

// Well-known technical tokens that share the Jira key shape (PREFIX-NUMBER) but
// are standards/versions, not issue references. The acceptance set (UTF-8,
// SHA-256, HTTP-2) must never parse as issue keys; the rest are common enough in
// commit messages to be worth pre-empting. Matched on the uppercase prefix.
const NON_ISSUE_PREFIXES = new Set([
  "UTF", "UTF8", "UTF16", "UTF32",
  "SHA", "SHA1", "SHA256", "SHA512", "MD", "MD5",
  "HTTP", "HTTPS", "HTTP2", "SSH", "TLS", "SSL", "SPF", "DKIM",
  "ISO", "RFC", "ASCII", "ANSI", "BASE64", "OAUTH", "OAUTH2", "PBKDF2",
  "IPV4", "IPV6", "EC2", "S3", "AES", "RSA", "DES", "ECMA", "ES",
  "GB", "MB", "KB", "TB", "PB", "H", "X", "CP",
  // Security identifiers that share the PREFIX-NUMBER shape but are not issues.
  "CVE", "CWE", "CAPEC", "GHSA",
  // Timezone abbreviations (e.g. `UTC-05:00`, `GMT-8`).
  "UTC", "GMT", "UT",
]);

// BREAKING CHANGE trailer, per the conventional-commits spec: a line that starts
// with `BREAKING CHANGE:` or `BREAKING-CHANGE:` anywhere in the body.
const BREAKING_TRAILER = /^BREAKING[ -]CHANGE:/m;

/**
 * Parse a conventional-commit subject.
 *
 * @param {string} subject
 * @returns {{ type: string|null, scope: string|null, breaking: boolean }}
 *   `type`/`scope` are null when the subject is not conventional or has no
 *   scope. `breaking` reflects only the `!` marker in the subject — the
 *   `BREAKING CHANGE:` trailer lives in the body (see {@link detectBreakingChange}).
 */
export function parseConventionalSubject(subject) {
  const match = CONVENTIONAL_SUBJECT.exec(String(subject || ""));
  if (!match) {
    return { type: null, scope: null, breaking: false };
  }
  return {
    type: match[1],
    scope: match[2] ? match[2].trim() : null,
    breaking: match[3] === "!",
  };
}

/**
 * Detect a `BREAKING CHANGE:` / `BREAKING-CHANGE:` trailer in a commit body.
 * @param {string} body
 * @returns {boolean}
 */
export function detectBreakingChange(body) {
  return BREAKING_TRAILER.test(String(body || ""));
}

/**
 * Extract distinct issue references from arbitrary commit text (subject, body,
 * and trailers should be concatenated by the caller). GitHub refs keep their
 * leading `#`; Jira keys are returned verbatim (`PROJ-123`). Order is
 * first-seen; duplicates within the text collapse to one.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractIssueKeys(text) {
  const source = String(text || "");

  // Collect matches from both patterns WITH their positions, so the returned
  // order is true first-seen across kinds (`PROJ-7 before #12` -> Jira first),
  // not "all GitHub refs, then all Jira keys".
  const found = [];
  for (const match of source.matchAll(GITHUB_REF)) {
    found.push({ index: match.index, key: `#${match[1]}` });
  }
  for (const match of source.matchAll(JIRA_KEY)) {
    if (NON_ISSUE_PREFIXES.has(match[1])) {
      continue;
    }
    found.push({ index: match.index, key: `${match[1]}-${match[2]}` });
  }
  found.sort((a, b) => a.index - b.index);

  const seen = new Set();
  const keys = [];
  for (const { key } of found) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

// Body trailer left by `git revert`: `This reverts commit <sha>.`. The hash may
// be sha1 (40) or sha256 (64); the trailing lookahead stops the capture at the
// full object id rather than truncating a 64-char sha256 to 40 chars.
const REVERT_TRAILER = /This reverts commit ([0-9a-f]{7,64})(?![0-9a-f])/;
// Default `git revert` subject: `Revert "<original subject>"`.
const REVERT_SUBJECT = /^Revert "(.*)"\s*$/;
// Conventional revert type: `revert: ...` or `revert(scope): ...`.
const REVERT_CONVENTIONAL = /^revert(?:\([^()\r\n]*\))?!?:\s/i;

/**
 * Detect whether a commit is a revert and, when possible, what it reverted.
 *
 * @param {string} subject
 * @param {string} body
 * @returns {{ isRevert: boolean, revertOf: string|null }}
 *   `revertOf` prefers the reverted commit SHA from the body trailer, falling
 *   back to the quoted original subject; null when undetectable.
 */
export function detectRevert(subject, body) {
  const subjectStr = String(subject || "");
  const bodyStr = String(body || "");

  const shaMatch = REVERT_TRAILER.exec(bodyStr);
  const quotedMatch = REVERT_SUBJECT.exec(subjectStr);
  const isRevert =
    Boolean(shaMatch) || Boolean(quotedMatch) || REVERT_CONVENTIONAL.test(subjectStr);

  if (!isRevert) {
    return { isRevert: false, revertOf: null };
  }

  let revertOf = null;
  if (shaMatch) {
    revertOf = shaMatch[1];
  } else if (quotedMatch) {
    revertOf = quotedMatch[1];
  }
  return { isRevert: true, revertOf };
}
