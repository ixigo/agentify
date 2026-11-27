// Path-glob matching for the two harnesses that enforce path refusals: the eval
// runner (a graded attempt that edits a forbidden path is a failed attempt) and
// the loop runner (an iteration's forbidden edits are reverted before grading).
//
// Deliberately not git's pathspec matcher or a glob dependency: the patterns
// are compared against git-relative paths that the harness already has in hand,
// and both harnesses must agree exactly on what a pattern covers. One shared
// implementation is what makes "the check and the revert saw the same set" true
// by construction.

/**
 * Return the patterns that match a path.
 *
 * `**` crosses directory boundaries, `*` stays within one segment, and
 * everything else is literal.
 */
export function matchesForbiddenPath(filePath, patterns) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return (patterns || []).filter((pattern) => {
    const source = String(pattern).replace(/\\/g, "/");
    const regex = new RegExp(`^${source
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) => {
        if (part === "**/") return "(?:.*/)?";
        if (part === "**") return ".*";
        if (part === "*") return "[^/]*";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("")}$`);
    return regex.test(normalized);
  });
}
