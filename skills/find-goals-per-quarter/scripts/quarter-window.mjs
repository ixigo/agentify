#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const QUARTER_PATTERN = /^(\d{4})-?Q([1-4])$/i;

function parseIsoDate(value, label) {
  const text = String(value || "").slice(0, 10);
  if (!DATE_PATTERN.test(text)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD), received "${value}"`);
  }
  const [year, month, day] = text.split("-").map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a real calendar date: "${value}"`);
  }
  return date;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsClamped(date, months) {
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, day));
}

function quarterOf(date) {
  return Math.floor(date.getUTCMonth() / 3) + 1;
}

function quarterBounds(year, quarter) {
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const endExclusive = new Date(Date.UTC(year, startMonth + 3, 1));
  return { start, end: addDays(endExclusive, -1), endExclusive };
}

function overlappingQuarters(start, endExclusive) {
  const quarters = [];
  let year = start.getUTCFullYear();
  let quarter = quarterOf(start);

  for (let guard = 0; guard < 64; guard += 1) {
    const bounds = quarterBounds(year, quarter);
    if (bounds.start.getTime() >= endExclusive.getTime()) break;
    quarters.push({
      label: `${year}-Q${quarter}`,
      start: formatIsoDate(bounds.start),
      end: formatIsoDate(bounds.end),
      complete:
        bounds.endExclusive.getTime() <= endExclusive.getTime() &&
        bounds.start.getTime() >= start.getTime(),
    });
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
  }

  return quarters;
}

function buildJql({ start, endExclusive, end }) {
  const range = (field) => `${field} >= "${start}" AND ${field} < "${endExclusive}"`;
  return {
    resolved: `assignee = currentUser() AND ${range("resolved")} ORDER BY resolved DESC`,
    closed_by_status_category: `assignee = currentUser() AND statusCategory = Done AND ${range(
      "updated"
    )} ORDER BY updated DESC`,
    updated: `assignee = currentUser() AND ${range("updated")} ORDER BY updated DESC`,
    created: `reporter = currentUser() AND ${range("created")} ORDER BY created DESC`,
    in_flight: `assignee = currentUser() AND statusCategory != Done AND updated >= "${start}" ORDER BY updated DESC`,
    previously_assigned: `assignee was currentUser() AND ${range(
      "updated"
    )} ORDER BY updated DESC`,
    worklog: `worklogAuthor = currentUser() AND worklogDate >= "${start}" AND worklogDate <= "${end}" ORDER BY updated DESC`,
  };
}

export function resolveQuarterWindow({ asOf, months = 3, quarter = null } = {}) {
  const asOfDate = parseIsoDate(asOf, "asOf");
  let mode = "rolling";
  let label = "";
  let start = null;
  let endExclusive = null;
  const notes = [];

  if (quarter) {
    const match = QUARTER_PATTERN.exec(String(quarter).trim());
    if (!match) {
      throw new Error(`quarter must look like 2026-Q2, received "${quarter}"`);
    }
    const year = Number(match[1]);
    const index = Number(match[2]);
    const bounds = quarterBounds(year, index);
    mode = "calendar_quarter";
    label = `${year}-Q${index}`;
    start = bounds.start;
    endExclusive = bounds.endExclusive;
    if (endExclusive.getTime() > addDays(asOfDate, 1).getTime()) {
      notes.push(
        `${label} extends past ${formatIsoDate(asOfDate)}; the quarter is still open and the summary covers partial data.`
      );
    }
  } else {
    const monthCount = Number(months);
    if (!Number.isInteger(monthCount) || monthCount < 1 || monthCount > 24) {
      throw new Error(`months must be an integer between 1 and 24, received "${months}"`);
    }
    mode = "rolling";
    start = addMonthsClamped(asOfDate, -monthCount);
    endExclusive = addDays(asOfDate, 1);
    label = `${formatIsoDate(start)}..${formatIsoDate(asOfDate)}`;
  }

  const startText = formatIsoDate(start);
  const endText = formatIsoDate(addDays(endExclusive, -1));
  const endExclusiveText = formatIsoDate(endExclusive);

  notes.push(
    "All bounds are UTC dates. Jira and Azure DevOps timestamps are rendered in each service's own timezone, so treat boundary-day items as in-window and say so."
  );
  notes.push(
    "az repos pr list has no date filter; filter pull requests client-side on closedDate or creationDate, or use the az devops invoke route with min_time/max_time."
  );

  return {
    schema_version: 1,
    mode,
    label,
    as_of: formatIsoDate(asOfDate),
    months: mode === "rolling" ? Number(months) : 3,
    start: startText,
    end: endText,
    end_exclusive: endExclusiveText,
    calendar_quarters: overlappingQuarters(start, endExclusive),
    jira: {
      jql: buildJql({ start: startText, end: endText, endExclusive: endExclusiveText }),
    },
    azure: {
      min_time: `${startText}T00:00:00Z`,
      max_time: `${endExclusiveText}T00:00:00Z`,
      query_time_range_type: "Closed",
      client_side_cutoff: {
        completed_prs: "closedDate",
        active_prs: "creationDate",
      },
    },
    notes,
  };
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

async function writeOutput(outputPath, payload) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${payload}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const asOf =
    typeof args["as-of"] === "string"
      ? args["as-of"]
      : new Date().toISOString().slice(0, 10);
  const window = resolveQuarterWindow({
    asOf,
    months: typeof args.months === "string" ? Number(args.months) : 3,
    quarter: typeof args.quarter === "string" ? args.quarter : null,
  });
  const payload = JSON.stringify(window, null, args.pretty ? 2 : 0);
  const outputPath = args.output || args.out;

  if (typeof outputPath === "string") {
    await writeOutput(path.resolve(outputPath), payload);
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
