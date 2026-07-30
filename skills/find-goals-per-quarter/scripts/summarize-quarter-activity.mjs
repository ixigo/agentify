#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

// Prefixes that match the Jira key shape but almost never are one.
const NON_KEY_PREFIXES = new Set([
  "AES",
  "CVE",
  "GMT",
  "HTTP",
  "HTTPS",
  "IPV",
  "ISO",
  "MD",
  "RFC",
  "RSA",
  "SHA",
  "SSL",
  "TLS",
  "UTC",
  "UTF",
]);

function pickName(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.name || value.key || value.displayName || value.value || "");
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function toDay(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function tally(counts, key) {
  if (!key) return;
  counts[key] = (counts[key] || 0) + 1;
}

function sortedTally(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function extractJiraKeys(...sources) {
  const keys = [];
  for (const source of sources) {
    const text = String(source || "").replace(/[_/]+/g, " ");
    for (const match of text.matchAll(JIRA_KEY_PATTERN)) {
      if (NON_KEY_PREFIXES.has(match[1])) continue;
      keys.push(`${match[1]}-${Number(match[2])}`);
    }
  }
  return unique(keys);
}

export function normalizeJiraItem(raw) {
  const fields = raw.fields || {};
  const key = String(firstDefined(raw.key, raw.Key, fields.key) || "").toUpperCase();
  const status = pickName(firstDefined(raw.status, fields.status));
  const statusCategory = pickName(
    firstDefined(
      raw.statusCategory,
      fields.status?.statusCategory,
      raw.status?.statusCategory
    )
  );
  const parentKey = String(
    firstDefined(raw.parentKey, raw.parent?.key, fields.parent?.key) || ""
  ).toUpperCase();

  return {
    key,
    summary: String(firstDefined(raw.summary, fields.summary) || ""),
    type: pickName(firstDefined(raw.type, raw.issuetype, fields.issuetype)),
    status,
    status_category: statusCategory,
    project: String(
      firstDefined(
        pickName(raw.project),
        fields.project?.key,
        key.includes("-") ? key.split("-")[0] : ""
      ) || ""
    ),
    parent_key: parentKey,
    parent_summary: String(
      firstDefined(raw.parentSummary, fields.parent?.fields?.summary) || ""
    ),
    labels: unique([...(raw.labels || []), ...(fields.labels || [])].map(String)),
    components: unique(
      [...(raw.components || []), ...(fields.components || [])].map(pickName)
    ),
    created: toDay(firstDefined(raw.created, fields.created)),
    updated: toDay(firstDefined(raw.updated, fields.updated)),
    resolved: toDay(
      firstDefined(raw.resolved, raw.resolutiondate, fields.resolutiondate)
    ),
    assignee: pickName(firstDefined(raw.assignee, fields.assignee)),
  };
}

export function normalizePullRequest(raw) {
  const sourceRef = String(firstDefined(raw.sourceRefName, raw.source_ref_name) || "");
  return {
    id: Number(firstDefined(raw.pullRequestId, raw.pull_request_id, raw.id) || 0),
    title: String(raw.title || ""),
    status: String(raw.status || "").toLowerCase(),
    repository: String(
      firstDefined(pickName(raw.repository), raw.repositoryName) || ""
    ),
    project: String(
      firstDefined(pickName(raw.repository?.project), raw.project) || ""
    ),
    author: String(
      firstDefined(raw.createdBy?.uniqueName, raw.createdBy?.displayName, raw.author) ||
        ""
    ),
    source_branch: sourceRef.replace(/^refs\/heads\//, ""),
    target_branch: String(
      firstDefined(raw.targetRefName, raw.target_ref_name) || ""
    ).replace(/^refs\/heads\//, ""),
    created: toDay(firstDefined(raw.creationDate, raw.creation_date)),
    closed: toDay(firstDefined(raw.closedDate, raw.closed_date)),
    is_draft: Boolean(firstDefined(raw.isDraft, raw.is_draft, false)),
    merge_status: String(firstDefined(raw.mergeStatus, raw.merge_status) || ""),
    url: String(firstDefined(raw.url, raw.webUrl, raw.web_url) || ""),
  };
}

function inWindow(day, window) {
  if (!day) return false;
  return day >= window.start && day < window.end_exclusive;
}

function themeFor(item) {
  if (item.parent_key) {
    return {
      id: `epic:${item.parent_key}`,
      kind: "epic",
      label: item.parent_summary
        ? `${item.parent_key} ${item.parent_summary}`
        : item.parent_key,
    };
  }
  if (item.components.length > 0) {
    return {
      id: `component:${slug(item.components[0])}`,
      kind: "component",
      label: item.components[0],
    };
  }
  if (item.labels.length > 0) {
    return { id: `label:${slug(item.labels[0])}`, kind: "label", label: item.labels[0] };
  }
  if (item.project) {
    return { id: `project:${item.project}`, kind: "project", label: item.project };
  }
  return { id: "unclassified", kind: "unclassified", label: "Unclassified Jira work" };
}

function ensureTheme(themes, descriptor) {
  let theme = themes.get(descriptor.id);
  if (!theme) {
    theme = {
      theme_id: descriptor.id,
      kind: descriptor.kind,
      label: descriptor.label,
      jira_keys: [],
      pull_request_ids: [],
      repositories: [],
      signals: { jira_total: 0, jira_done: 0, pull_requests_completed: 0 },
      first_activity: "",
      last_activity: "",
    };
    themes.set(descriptor.id, theme);
  }
  return theme;
}

function trackActivity(theme, day) {
  if (!day) return;
  if (!theme.first_activity || day < theme.first_activity) theme.first_activity = day;
  if (!theme.last_activity || day > theme.last_activity) theme.last_activity = day;
}

export function summarizeQuarterActivity({
  window,
  jira = [],
  pullRequests = [],
  identity = {},
} = {}) {
  if (!window || !window.start || !window.end_exclusive) {
    throw new Error(
      "window with start and end_exclusive is required; generate it with quarter-window.mjs"
    );
  }

  const items = jira.map(normalizeJiraItem);
  const prs = pullRequests.map(normalizePullRequest);
  const knownKeys = new Set(items.map((item) => item.key).filter(Boolean));
  const itemsByKey = new Map(items.map((item) => [item.key, item]));

  const jiraByStatusCategory = {};
  const jiraByType = {};
  const jiraByProject = {};
  const jiraByStatus = {};
  const prByStatus = {};
  const prByRepository = {};
  const monthly = new Map();
  const themes = new Map();

  const outsideWindow = [];
  const missingDates = [];

  const bucket = (month) => {
    if (!monthly.has(month)) {
      monthly.set(month, {
        month,
        jira_resolved: 0,
        jira_updated: 0,
        pull_requests_completed: 0,
      });
    }
    return monthly.get(month);
  };

  const resolvedInWindow = [];
  const inFlight = [];

  for (const item of items) {
    tally(jiraByStatusCategory, item.status_category || "unknown");
    tally(jiraByType, item.type || "unknown");
    tally(jiraByProject, item.project || "unknown");
    tally(jiraByStatus, item.status || "unknown");

    const activityDay = item.resolved || item.updated;
    if (!activityDay) {
      missingDates.push({ kind: "jira", ref: item.key, reason: "no resolved or updated date" });
    } else if (!inWindow(activityDay, window)) {
      outsideWindow.push({
        kind: "jira",
        ref: item.key,
        day: activityDay,
        field: item.resolved ? "resolved" : "updated",
      });
    }

    if (item.resolved && inWindow(item.resolved, window)) {
      resolvedInWindow.push(item.key);
      bucket(item.resolved.slice(0, 7)).jira_resolved += 1;
    }
    if (item.updated && inWindow(item.updated, window)) {
      bucket(item.updated.slice(0, 7)).jira_updated += 1;
    }
    if (item.status_category && item.status_category.toLowerCase() !== "done") {
      inFlight.push(item.key);
    }

    const theme = ensureTheme(themes, themeFor(item));
    theme.jira_keys.push(item.key);
    theme.signals.jira_total += 1;
    if (item.status_category.toLowerCase() === "done" || item.resolved) {
      theme.signals.jira_done += 1;
    }
    trackActivity(theme, activityDay);
  }

  const linkedPairs = [];
  const referencedUnknownKeys = new Set();
  const pullRequestsWithoutJira = [];
  const completedInWindow = [];
  const linkedJiraKeys = new Set();

  for (const pr of prs) {
    tally(prByStatus, pr.status || "unknown");
    tally(prByRepository, pr.repository || "unknown");

    const activityDay = pr.closed || pr.created;
    if (!activityDay) {
      missingDates.push({
        kind: "pull_request",
        ref: pr.id,
        reason: "no closedDate or creationDate",
      });
    } else if (!inWindow(activityDay, window)) {
      outsideWindow.push({
        kind: "pull_request",
        ref: pr.id,
        day: activityDay,
        field: pr.closed ? "closedDate" : "creationDate",
      });
    }

    if (pr.status === "completed" && pr.closed && inWindow(pr.closed, window)) {
      completedInWindow.push(pr.id);
      bucket(pr.closed.slice(0, 7)).pull_requests_completed += 1;
    }

    const candidateKeys = extractJiraKeys(pr.title, pr.source_branch, pr.description);
    const matchedKeys = candidateKeys.filter((key) => knownKeys.has(key));
    for (const key of candidateKeys) {
      if (!knownKeys.has(key)) referencedUnknownKeys.add(key);
    }

    let descriptor = null;
    if (matchedKeys.length > 0) {
      for (const key of matchedKeys) {
        linkedPairs.push({ jira_key: key, pull_request_id: pr.id, repository: pr.repository });
        linkedJiraKeys.add(key);
      }
      descriptor = themeFor(itemsByKey.get(matchedKeys[0]));
    } else {
      pullRequestsWithoutJira.push({
        pull_request_id: pr.id,
        repository: pr.repository,
        title: pr.title,
        referenced_keys: candidateKeys,
      });
      descriptor = {
        id: `repository:${slug(pr.repository) || "unknown"}`,
        kind: "repository",
        label: pr.repository || "Unknown repository",
      };
    }

    const theme = ensureTheme(themes, descriptor);
    theme.pull_request_ids.push(pr.id);
    if (pr.repository) theme.repositories.push(pr.repository);
    if (pr.status === "completed") theme.signals.pull_requests_completed += 1;
    trackActivity(theme, activityDay);
  }

  const themeList = [...themes.values()]
    .map((theme) => ({
      ...theme,
      jira_keys: unique(theme.jira_keys),
      pull_request_ids: [...new Set(theme.pull_request_ids)].sort((a, b) => a - b),
      repositories: unique(theme.repositories),
      evidence_count: new Set(theme.jira_keys).size + new Set(theme.pull_request_ids).size,
    }))
    .sort(
      (a, b) => b.evidence_count - a.evidence_count || a.theme_id.localeCompare(b.theme_id)
    );

  const jiraWithoutPullRequest = items
    .map((item) => item.key)
    .filter((key) => key && !linkedJiraKeys.has(key));

  const summary = {
    schema_version: 1,
    window: {
      label: window.label || `${window.start}..${window.end}`,
      mode: window.mode || "rolling",
      start: window.start,
      end: window.end || "",
      end_exclusive: window.end_exclusive,
      calendar_quarters: (window.calendar_quarters || []).map((quarter) => quarter.label),
    },
    identity: {
      jira: String(identity.jira || ""),
      azure: String(identity.azure || ""),
      verified: Boolean(identity.jira) && Boolean(identity.azure),
    },
    totals: {
      jira_items: items.length,
      jira_resolved_in_window: resolvedInWindow.length,
      jira_in_flight: inFlight.length,
      pull_requests: prs.length,
      pull_requests_completed_in_window: completedInWindow.length,
      repositories: unique(prs.map((pr) => pr.repository)).length,
      themes: themeList.length,
    },
    jira: {
      by_status_category: sortedTally(jiraByStatusCategory),
      by_status: sortedTally(jiraByStatus),
      by_type: sortedTally(jiraByType),
      by_project: sortedTally(jiraByProject),
      resolved_in_window: resolvedInWindow.sort(),
      in_flight: inFlight.sort(),
    },
    pull_requests: {
      by_status: sortedTally(prByStatus),
      by_repository: sortedTally(prByRepository),
      completed_in_window: completedInWindow.sort((a, b) => a - b),
    },
    themes: themeList,
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    cross_links: {
      linked_pairs: linkedPairs,
      jira_without_pull_request: jiraWithoutPullRequest.sort(),
      pull_requests_without_jira: pullRequestsWithoutJira,
      referenced_unknown_keys: [...referencedUnknownKeys].sort(),
    },
    gaps: {
      outside_window: outsideWindow,
      missing_dates: missingDates,
      evidence_ready: items.length > 0 || prs.length > 0,
    },
  };

  summary.review_hints = [
    !summary.gaps.evidence_ready
      ? "No Jira items and no pull requests were supplied; report the missing source instead of summarizing."
      : "",
    !summary.identity.verified
      ? "Jira and Azure DevOps identities were not both resolved; state whose work this covers before presenting the summary."
      : "",
    pullRequestsWithoutJira.length > 0
      ? `${pullRequestsWithoutJira.length} pull request(s) carry no known Jira key; attribute them by repository and do not guess a ticket.`
      : "",
    summary.cross_links.referenced_unknown_keys.length > 0
      ? `Pull requests reference ${summary.cross_links.referenced_unknown_keys.length} Jira key(s) absent from the Jira export; fetch them or mark them unverified.`
      : "",
    jiraWithoutPullRequest.length > 0
      ? `${jiraWithoutPullRequest.length} Jira item(s) have no linked pull request; that is normal for non-code work but weakens code-level evidence.`
      : "",
    outsideWindow.length > 0
      ? `${outsideWindow.length} record(s) fall outside ${summary.window.label}; drop them or widen the window explicitly.`
      : "",
    "Themes are grouped from epic, component, label, project, and repository metadata. They are evidence clusters, not goals; write goal statements from them and cite keys and pull request ids.",
  ].filter(Boolean);

  return summary;
}

function parseArgs(argv) {
  const result = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result.positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

async function readJson(filePath, label) {
  const text = await fs.readFile(path.resolve(filePath), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${filePath}): ${error.message}`);
  }
}

function asArray(value, label) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.value)) return value.value;
  if (value && Array.isArray(value.issues)) return value.issues;
  if (value && Array.isArray(value.workItems)) return value.workItems;
  throw new Error(`${label} must be a JSON array or an object with a value/issues array`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.window !== "string") {
    throw new Error(
      "Usage: summarize-quarter-activity.mjs --window <window.json> [--jira <jira.json>] [--prs <prs.json>] [--jira-identity <email>] [--azure-identity <email>] [--output <file>] [--pretty]"
    );
  }

  const window = await readJson(args.window, "window file");
  const jira =
    typeof args.jira === "string" ? asArray(await readJson(args.jira, "jira file"), "jira file") : [];
  const pullRequests =
    typeof args.prs === "string" ? asArray(await readJson(args.prs, "prs file"), "prs file") : [];

  const summary = summarizeQuarterActivity({
    window,
    jira,
    pullRequests,
    identity: {
      jira: typeof args["jira-identity"] === "string" ? args["jira-identity"] : "",
      azure: typeof args["azure-identity"] === "string" ? args["azure-identity"] : "",
    },
  });

  const payload = JSON.stringify(summary, null, args.pretty ? 2 : 0);
  const outputPath = args.output || args.out;
  if (typeof outputPath === "string") {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${payload}\n`, "utf8");
  }
  process.stdout.write(`${payload}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
