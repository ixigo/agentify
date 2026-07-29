import test from "node:test";
import assert from "node:assert/strict";

import {
  parseConventionalSubject,
  detectBreakingChange,
  extractIssueKeys,
  detectRevert,
} from "../src/core/git-analyze/parse.js";

test("parseConventionalSubject reads type, scope, and the breaking marker", () => {
  assert.deepEqual(parseConventionalSubject("feat(x): y"), { type: "feat", scope: "x", breaking: false });
  assert.deepEqual(parseConventionalSubject("fix!: y"), { type: "fix", scope: null, breaking: true });
  assert.deepEqual(parseConventionalSubject("chore: y"), { type: "chore", scope: null, breaking: false });
  assert.deepEqual(parseConventionalSubject("feat(acp)!: drop old flag"), { type: "feat", scope: "acp", breaking: true });
});

test("parseConventionalSubject returns null type for non-conventional subjects (no throw)", () => {
  assert.deepEqual(parseConventionalSubject("wip"), { type: null, scope: null, breaking: false });
  assert.deepEqual(parseConventionalSubject("fixes stuff"), { type: null, scope: null, breaking: false });
  // A colon with no leading type word is not conventional.
  assert.deepEqual(parseConventionalSubject(": nope"), { type: null, scope: null, breaking: false });
  // Missing the mandatory space after the colon.
  assert.deepEqual(parseConventionalSubject("feat:y"), { type: null, scope: null, breaking: false });
  assert.deepEqual(parseConventionalSubject(""), { type: null, scope: null, breaking: false });
  assert.deepEqual(parseConventionalSubject(undefined), { type: null, scope: null, breaking: false });
});

test("detectBreakingChange finds the BREAKING CHANGE / BREAKING-CHANGE trailer", () => {
  assert.equal(detectBreakingChange("body\n\nBREAKING CHANGE: removes the old API"), true);
  assert.equal(detectBreakingChange("BREAKING-CHANGE: also valid"), true);
  assert.equal(detectBreakingChange("mentions breaking change in prose only"), false);
  assert.equal(detectBreakingChange(""), false);
});

test("extractIssueKeys pulls GitHub refs and Jira keys, distinct and in order", () => {
  assert.deepEqual(extractIssueKeys("fix(acp): keep timeout (#336)"), ["#336"]);
  assert.deepEqual(
    extractIssueKeys("closes #12 and #34; see PROJ-7\n\nRefs: #12, ABC-99"),
    ["#12", "#34", "PROJ-7", "ABC-99"],
  );
  assert.deepEqual(extractIssueKeys("no refs here"), []);
});

test("extractIssueKeys orders keys by first appearance across kinds", () => {
  // A Jira key before a GitHub ref must come first (not "all # then all Jira").
  assert.deepEqual(extractIssueKeys("PROJ-7 before #12"), ["PROJ-7", "#12"]);
  assert.deepEqual(extractIssueKeys("#12 then PROJ-7"), ["#12", "PROJ-7"]);
});

test("extractIssueKeys does not treat standards tokens as issue keys", () => {
  // The acceptance false-positive set.
  assert.deepEqual(extractIssueKeys("encode as UTF-8 with SHA-256 over HTTP-2"), []);
  // A real Jira key alongside a standards token: only the real one survives.
  assert.deepEqual(extractIssueKeys("UTF-8 handling for PROJ-123"), ["PROJ-123"]);
});

test("extractIssueKeys does not treat security identifiers as issue keys", () => {
  // Multi-group hyphenated ids (CVE-YYYY-NNNN) and denylisted security prefixes.
  assert.deepEqual(extractIssueKeys("patch for CVE-2024-12345 and CWE-79"), []);
  // A real Jira key next to a CVE: only the Jira key survives, not "CVE-2024".
  assert.deepEqual(extractIssueKeys("PROJ-9 fixes CVE-2024-12345"), ["PROJ-9"]);
});

test("extractIssueKeys does not treat timezone offsets as issue keys", () => {
  assert.deepEqual(extractIssueKeys("window ran in UTC-05:00 and GMT-8"), []);
  assert.deepEqual(extractIssueKeys("PROJ-4 in UTC-05:00"), ["PROJ-4"]);
});

test("extractIssueKeys ignores refs glued to a word or an HTML entity", () => {
  assert.deepEqual(extractIssueKeys("commit abc#5 is not a ref"), []);
  assert.deepEqual(extractIssueKeys("entity &#123; is not a ref"), []);
});

test("detectRevert handles the default revert subject and the body trailer", () => {
  assert.deepEqual(detectRevert('Revert "feat(x): y"', ""), { isRevert: true, revertOf: "feat(x): y" });
  assert.deepEqual(
    detectRevert("Revert something", "This reverts commit adebe13abc1234567890abcdef1234567890abcd."),
    { isRevert: true, revertOf: "adebe13abc1234567890abcdef1234567890abcd" },
  );
  // Body SHA is preferred over the quoted subject when both are present.
  assert.deepEqual(
    detectRevert('Revert "feat(x): y"', "This reverts commit adebe13."),
    { isRevert: true, revertOf: "adebe13" },
  );
  // Conventional revert type with no discoverable target.
  assert.deepEqual(detectRevert("revert(core): back out change", ""), { isRevert: true, revertOf: null });
  assert.deepEqual(detectRevert("feat(x): y", ""), { isRevert: false, revertOf: null });
});
