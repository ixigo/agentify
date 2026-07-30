import assert from "node:assert/strict";
import test from "node:test";

import { resolveQuarterWindow } from "../skills/find-goals-per-quarter/scripts/quarter-window.mjs";
import {
  extractJiraKeys,
  normalizeJiraItem,
  normalizePullRequest,
  summarizeQuarterActivity,
} from "../skills/find-goals-per-quarter/scripts/summarize-quarter-activity.mjs";

test("resolveQuarterWindow builds a rolling three-month window with Jira and Azure bounds", () => {
  const window = resolveQuarterWindow({ asOf: "2026-07-30", months: 3 });

  assert.equal(window.mode, "rolling");
  assert.equal(window.start, "2026-04-30");
  assert.equal(window.end, "2026-07-30");
  assert.equal(window.end_exclusive, "2026-07-31");
  assert.equal(window.label, "2026-04-30..2026-07-30");
  assert.equal(window.azure.min_time, "2026-04-30T00:00:00Z");
  assert.equal(window.azure.max_time, "2026-07-31T00:00:00Z");
  assert.deepEqual(
    window.calendar_quarters.map((quarter) => quarter.label),
    ["2026-Q2", "2026-Q3"]
  );
  assert.match(window.jira.jql.resolved, /assignee = currentUser\(\)/);
  assert.match(window.jira.jql.resolved, /resolved >= "2026-04-30"/);
  assert.match(window.jira.jql.resolved, /resolved < "2026-07-31"/);
  assert.match(window.jira.jql.in_flight, /statusCategory != Done/);
  assert.match(window.jira.jql.worklog, /worklogDate <= "2026-07-30"/);
});

test("resolveQuarterWindow clamps month arithmetic to real calendar dates", () => {
  const window = resolveQuarterWindow({ asOf: "2026-05-31", months: 3 });
  assert.equal(window.start, "2026-02-28");
});

test("resolveQuarterWindow resolves a calendar quarter and flags an open one", () => {
  const closed = resolveQuarterWindow({ asOf: "2026-07-30", quarter: "2026-Q2" });
  assert.equal(closed.mode, "calendar_quarter");
  assert.equal(closed.label, "2026-Q2");
  assert.equal(closed.start, "2026-04-01");
  assert.equal(closed.end, "2026-06-30");
  assert.equal(closed.end_exclusive, "2026-07-01");
  assert.deepEqual(
    closed.calendar_quarters.map((quarter) => quarter.label),
    ["2026-Q2"]
  );
  assert.equal(
    closed.notes.some((note) => note.includes("still open")),
    false
  );

  const open = resolveQuarterWindow({ asOf: "2026-07-30", quarter: "2026Q3" });
  assert.equal(open.label, "2026-Q3");
  assert.ok(open.notes.some((note) => note.includes("still open")));
});

test("resolveQuarterWindow rejects invalid input", () => {
  assert.throws(() => resolveQuarterWindow({ asOf: "30-07-2026" }), /ISO date/);
  assert.throws(() => resolveQuarterWindow({ asOf: "2026-02-30" }), /real calendar date/);
  assert.throws(() => resolveQuarterWindow({ asOf: "2026-07-30", months: 0 }), /between 1 and 24/);
  assert.throws(
    () => resolveQuarterWindow({ asOf: "2026-07-30", quarter: "2026-Q5" }),
    /2026-Q2/
  );
});

test("extractJiraKeys reads branch names and skips non-key prefixes", () => {
  assert.deepEqual(
    extractJiraKeys("Fix fare rounding", "feature/ABC-123-fare-rounding"),
    ["ABC-123"]
  );
  assert.deepEqual(extractJiraKeys("Upgrade to UTF-8 and fix CVE-2026-1"), []);
  assert.deepEqual(extractJiraKeys("ABC-007 duplicate ABC-7"), ["ABC-7"]);
});

test("normalizeJiraItem accepts flat and fields-wrapped payloads", () => {
  const wrapped = normalizeJiraItem({
    key: "ABC-123",
    fields: {
      summary: "Move fare lookup server-side",
      issuetype: { name: "Story" },
      status: { name: "Done", statusCategory: { name: "Done" } },
      project: { key: "ABC" },
      parent: { key: "ABC-100", fields: { summary: "Checkout latency" } },
      labels: ["performance"],
      components: [{ name: "Booking" }],
      created: "2026-05-02T10:00:00.000+0530",
      updated: "2026-06-01T10:00:00.000+0530",
      resolutiondate: "2026-06-01T12:00:00.000+0530",
      assignee: { displayName: "Test User" },
    },
  });

  assert.equal(wrapped.summary, "Move fare lookup server-side");
  assert.equal(wrapped.type, "Story");
  assert.equal(wrapped.status_category, "Done");
  assert.equal(wrapped.project, "ABC");
  assert.equal(wrapped.parent_key, "ABC-100");
  assert.equal(wrapped.parent_summary, "Checkout latency");
  assert.deepEqual(wrapped.components, ["Booking"]);
  assert.equal(wrapped.resolved, "2026-06-01");

  const flat = normalizeJiraItem({
    key: "xyz-9",
    summary: "Flat shape",
    status: "In Progress",
    type: "Bug",
    updated: "2026-06-10T00:00:00Z",
  });

  assert.equal(flat.key, "XYZ-9");
  assert.equal(flat.project, "XYZ");
  assert.equal(flat.status, "In Progress");
  assert.equal(flat.resolved, "");
});

test("normalizePullRequest strips ref prefixes and resolves author", () => {
  const pr = normalizePullRequest({
    pullRequestId: 4512,
    title: "ABC-123 move fare lookup server-side",
    status: "Completed",
    repository: { name: "seo-pages", project: { name: "Web" } },
    createdBy: { uniqueName: "user@example.com", displayName: "Test User" },
    creationDate: "2026-05-20T09:00:00Z",
    closedDate: "2026-05-22T09:00:00Z",
    sourceRefName: "refs/heads/feature/ABC-123-fare",
    targetRefName: "refs/heads/main",
  });

  assert.equal(pr.id, 4512);
  assert.equal(pr.status, "completed");
  assert.equal(pr.repository, "seo-pages");
  assert.equal(pr.project, "Web");
  assert.equal(pr.author, "user@example.com");
  assert.equal(pr.source_branch, "feature/ABC-123-fare");
  assert.equal(pr.target_branch, "main");
  assert.equal(pr.closed, "2026-05-22");
});

test("summarizeQuarterActivity cross-links tickets to PRs and groups goal themes", () => {
  const window = resolveQuarterWindow({ asOf: "2026-07-30", months: 3 });
  const summary = summarizeQuarterActivity({
    window,
    identity: { jira: "user@example.com", azure: "user@example.com" },
    jira: [
      {
        key: "ABC-123",
        fields: {
          summary: "Move fare lookup server-side",
          issuetype: { name: "Story" },
          status: { name: "Done", statusCategory: { name: "Done" } },
          project: { key: "ABC" },
          parent: { key: "ABC-100", fields: { summary: "Checkout latency" } },
          updated: "2026-05-22T10:00:00Z",
          resolutiondate: "2026-05-22T10:00:00Z",
        },
      },
      {
        key: "ABC-124",
        fields: {
          summary: "Cache station metadata",
          issuetype: { name: "Task" },
          status: { name: "In Progress", statusCategory: { name: "In Progress" } },
          project: { key: "ABC" },
          parent: { key: "ABC-100", fields: { summary: "Checkout latency" } },
          updated: "2026-07-10T10:00:00Z",
        },
      },
      {
        key: "DEF-9",
        fields: {
          summary: "Refresh SEO copy",
          issuetype: { name: "Task" },
          status: { name: "Done", statusCategory: { name: "Done" } },
          project: { key: "DEF" },
          components: [{ name: "SEO" }],
          updated: "2026-06-15T10:00:00Z",
          resolutiondate: "2026-06-15T10:00:00Z",
        },
      },
    ],
    pullRequests: [
      {
        pullRequestId: 4512,
        title: "ABC-123 move fare lookup server-side",
        status: "completed",
        repository: { name: "seo-pages" },
        creationDate: "2026-05-20T09:00:00Z",
        closedDate: "2026-05-22T09:00:00Z",
        sourceRefName: "refs/heads/feature/ABC-123-fare",
      },
      {
        pullRequestId: 4600,
        title: "Bump build tooling",
        status: "completed",
        repository: { name: "platform-infra" },
        creationDate: "2026-06-01T09:00:00Z",
        closedDate: "2026-06-02T09:00:00Z",
        sourceRefName: "refs/heads/chore/bump-tooling",
      },
      {
        pullRequestId: 4700,
        title: "GHI-55 unrelated ticket reference",
        status: "active",
        repository: { name: "seo-pages" },
        creationDate: "2026-07-20T09:00:00Z",
        sourceRefName: "refs/heads/feature/GHI-55",
      },
    ],
  });

  assert.equal(summary.identity.verified, true);
  assert.equal(summary.totals.jira_items, 3);
  assert.equal(summary.totals.jira_resolved_in_window, 2);
  assert.equal(summary.totals.jira_in_flight, 1);
  assert.equal(summary.totals.pull_requests, 3);
  assert.equal(summary.totals.pull_requests_completed_in_window, 2);
  assert.equal(summary.totals.repositories, 2);

  assert.deepEqual(summary.cross_links.linked_pairs, [
    { jira_key: "ABC-123", pull_request_id: 4512, repository: "seo-pages" },
  ]);
  assert.deepEqual(summary.cross_links.jira_without_pull_request, ["ABC-124", "DEF-9"]);
  assert.deepEqual(summary.cross_links.referenced_unknown_keys, ["GHI-55"]);
  assert.deepEqual(
    summary.cross_links.pull_requests_without_jira.map((entry) => entry.pull_request_id),
    [4600, 4700]
  );

  const epicTheme = summary.themes.find((theme) => theme.theme_id === "epic:ABC-100");
  assert.deepEqual(epicTheme.jira_keys, ["ABC-123", "ABC-124"]);
  assert.deepEqual(epicTheme.pull_request_ids, [4512]);
  assert.deepEqual(epicTheme.repositories, ["seo-pages"]);
  assert.equal(epicTheme.signals.jira_done, 1);
  assert.equal(epicTheme.signals.pull_requests_completed, 1);
  assert.equal(epicTheme.first_activity, "2026-05-22");
  assert.equal(epicTheme.last_activity, "2026-07-10");
  assert.equal(epicTheme.label, "ABC-100 Checkout latency");

  assert.ok(summary.themes.some((theme) => theme.theme_id === "component:seo"));
  const repoTheme = summary.themes.find(
    (theme) => theme.theme_id === "repository:platform-infra"
  );
  assert.equal(repoTheme.kind, "repository");
  assert.deepEqual(repoTheme.pull_request_ids, [4600]);

  assert.deepEqual(summary.monthly, [
    { month: "2026-05", jira_resolved: 1, jira_updated: 1, pull_requests_completed: 1 },
    { month: "2026-06", jira_resolved: 1, jira_updated: 1, pull_requests_completed: 1 },
    { month: "2026-07", jira_resolved: 0, jira_updated: 1, pull_requests_completed: 0 },
  ]);

  assert.ok(
    summary.review_hints.some((hint) => hint.includes("no known Jira key")),
    "expected an unlinked pull request hint"
  );
  assert.ok(
    summary.review_hints.some((hint) => hint.includes("absent from the Jira export")),
    "expected an unverified key hint"
  );
  assert.ok(summary.review_hints.some((hint) => hint.includes("evidence clusters, not goals")));
});

test("summarizeQuarterActivity reports out-of-window records, missing dates, and unresolved identity", () => {
  const window = resolveQuarterWindow({ asOf: "2026-07-30", quarter: "2026-Q2" });
  const summary = summarizeQuarterActivity({
    window,
    jira: [
      {
        key: "ABC-1",
        fields: {
          summary: "Stale item",
          status: { name: "Done", statusCategory: { name: "Done" } },
          updated: "2026-01-05T00:00:00Z",
          resolutiondate: "2026-01-05T00:00:00Z",
        },
      },
      { key: "ABC-2", fields: { summary: "No dates at all" } },
    ],
    pullRequests: [
      {
        pullRequestId: 10,
        title: "Old work",
        status: "completed",
        repository: { name: "legacy" },
        creationDate: "2026-01-01T00:00:00Z",
        closedDate: "2026-01-02T00:00:00Z",
      },
    ],
  });

  assert.equal(summary.identity.verified, false);
  assert.equal(summary.totals.jira_resolved_in_window, 0);
  assert.equal(summary.totals.pull_requests_completed_in_window, 0);
  assert.deepEqual(summary.gaps.outside_window, [
    { kind: "jira", ref: "ABC-1", day: "2026-01-05", field: "resolved" },
    { kind: "pull_request", ref: 10, day: "2026-01-02", field: "closedDate" },
  ]);
  assert.deepEqual(summary.gaps.missing_dates, [
    { kind: "jira", ref: "ABC-2", reason: "no resolved or updated date" },
  ]);
  assert.equal(summary.gaps.evidence_ready, true);
  assert.ok(summary.review_hints.some((hint) => hint.includes("identities were not both resolved")));
  assert.ok(summary.review_hints.some((hint) => hint.includes("fall outside 2026-Q2")));
});

test("summarizeQuarterActivity requires a window and flags an empty fetch", () => {
  assert.throws(() => summarizeQuarterActivity({ jira: [], pullRequests: [] }), /window with start/);

  const window = resolveQuarterWindow({ asOf: "2026-07-30", months: 3 });
  const empty = summarizeQuarterActivity({ window });
  assert.equal(empty.gaps.evidence_ready, false);
  assert.equal(empty.totals.themes, 0);
  assert.ok(empty.review_hints.some((hint) => hint.includes("No Jira items")));
});
