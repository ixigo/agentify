// Pure window resolver for `agentify git analyze`. No I/O, no git, no clock
// side effects: it takes the window flags and a `now` instant and returns a
// single half-open [since, until) pair plus a human label and the IANA
// timezone the calendar arithmetic was done in.
//
// Two invariants shape every branch here:
//   1. Half-open. `until` is exclusive, so adjacent windows (Q1/Q2, this
//      year / next year) can never both claim a commit authored on the
//      boundary instant.
//   2. Calendar arithmetic by explicit year/month/day construction, never by
//      millisecond offset. `now - 3*30*24*60*60*1000` is not three months and
//      drifts across DST; `new Date(y, m - 3, d)` is.
//
// Author date vs commit date is a git-read concern (#349); this module only
// produces the boundary instants the log read is filtered by.

const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

// Every window form the command surface accepts, keyed by the primary flag
// that selects it. `--year` is special: it is a modifier of `--quarter` when
// both are present, and a standalone form otherwise.
const WINDOW_FLAGS = ["days", "months", "quarter", "since"];

// The calendar arithmetic below runs in the process timezone (Node honours a
// runtime `process.env.TZ` change for both `new Date(y, m, d)` and the Intl
// resolver), so the recorded zone is always the one the boundaries were built
// in. There is deliberately no timezone override: labelling a window with a
// zone the arithmetic did not use would silently move commits between reports.
function resolveTimeZone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function has(args, key) {
  return Object.prototype.hasOwnProperty.call(args, key);
}

// A flag present with no usable value (`--days` with nothing after it) parses
// to `true`; treat that as "requires a value" rather than a silent default.
function requireInteger(args, key, { min, max, message }) {
  const raw = args[key];
  const value = Number(raw);
  if (raw === true || raw === "" || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(message);
  }
  return value;
}

function requireString(args, key, flag) {
  const raw = args[key];
  if (raw === true || raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error(`git analyze ${flag} requires a value`);
  }
  return String(raw).trim();
}

function daysInMonth(year, monthIndex) {
  // Day 0 of the next month is the last day of this month, so this also
  // normalizes monthIndex 12 into January of the next year.
  return new Date(year, monthIndex + 1, 0).getDate();
}

function localDate(year, monthIndex, day, hours = 0, minutes = 0, seconds = 0, ms = 0) {
  const date = new Date(year, monthIndex, day, hours, minutes, seconds, ms);
  // The Date constructor remaps years 0-99 to 1900-1999. A large `--months`
  // window can legitimately land there (e.g. year 0050), so restore the literal
  // year explicitly. setFullYear leaves month/day/time untouched.
  if (year >= 0 && year <= 99) {
    date.setFullYear(year);
  }
  return date;
}

function subtractDays(date, n) {
  // Day underflow rolls back across month and year boundaries unambiguously,
  // so no clamping is needed here.
  return localDate(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - n,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function subtractMonths(date, n) {
  const totalMonths = date.getFullYear() * 12 + date.getMonth() - n;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  // Clamp the day to the target month so "1 month before 31 March" is the last
  // day of February, not a rollover into early March.
  const day = Math.min(date.getDate(), daysInMonth(targetYear, targetMonth));
  return localDate(
    targetYear,
    targetMonth,
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function selectedForms(args) {
  const forms = WINDOW_FLAGS.filter((flag) => has(args, flag)).map((flag) => `--${flag}`);
  // `--year` is a standalone window only when no `--quarter` consumes it.
  if (has(args, "year") && !has(args, "quarter")) {
    forms.push("--year");
  }
  return forms;
}

/**
 * Resolve the analysis window.
 *
 * @param {object} args - parsed flags: { days, months, quarter, year, since, until }
 * @param {object} [options]
 * @param {Date}   [options.now] - the "now" instant (injectable for tests)
 * @returns {{ form: string, since: string, until: string, label: string,
 *             timezone: string, since_kind: string, until_kind: string }}
 *   `since_kind`/`until_kind` are "instant" (an absolute ISO timestamp, ready
 *   to hand to git as-is) or "expression" (a user-supplied date/ref string the
 *   git-reading layer (#349) must resolve).
 */
export function resolveWindow(args = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const timezone = resolveTimeZone();

  if (has(args, "until") && !has(args, "since")) {
    throw new Error("git analyze --until requires --since");
  }

  const forms = selectedForms(args);
  if (forms.length > 1) {
    throw new Error(`git analyze window flags are mutually exclusive; got ${forms.join(" and ")}. Use exactly one.`);
  }

  const form = forms[0] || "--days";

  switch (form) {
    case "--days": {
      const n = has(args, "days")
        ? requireInteger(args, "days", { min: 1, message: "git analyze --days must be a positive integer (e.g. --days 30)" })
        : 30;
      return finalizeComputed({
        form: "days",
        since: subtractDays(now, n),
        until: now,
        label: `Last ${n} day${n === 1 ? "" : "s"}`,
        timezone,
      });
    }

    case "--months": {
      const n = requireInteger(args, "months", { min: 1, message: "git analyze --months must be a positive integer (e.g. --months 3)" });
      return finalizeComputed({
        form: "months",
        since: subtractMonths(now, n),
        until: now,
        label: `Last ${n} month${n === 1 ? "" : "s"}`,
        timezone,
      });
    }

    case "--quarter": {
      const quarter = requireInteger(args, "quarter", { min: 1, max: 4, message: "git analyze --quarter must be an integer 1-4" });
      const year = has(args, "year")
        ? requireInteger(args, "year", { min: MIN_YEAR, max: MAX_YEAR, message: `git analyze --year must be a 4-digit year (${MIN_YEAR}-${MAX_YEAR})` })
        : now.getFullYear();
      const startMonth = (quarter - 1) * 3;
      const since = localDate(year, startMonth, 1);
      const until = localDate(year, startMonth + 3, 1);
      if (since.getTime() > now.getTime()) {
        // Suggest the current (already-started) quarter, not the quarter before
        // the requested one — a request several years ahead must not be told to
        // use another future quarter.
        const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
        const currentYear = now.getFullYear();
        throw new Error(`Q${quarter} ${year} has not started; use --quarter ${currentQuarter} --year ${currentYear} or --year ${currentYear}`);
      }
      return finalizeComputed({ form: "quarter", since, until, label: `Q${quarter} ${year}`, timezone });
    }

    case "--year": {
      const year = requireInteger(args, "year", { min: MIN_YEAR, max: MAX_YEAR, message: `git analyze --year must be a 4-digit year (${MIN_YEAR}-${MAX_YEAR})` });
      const since = localDate(year, 0, 1);
      const until = localDate(year + 1, 0, 1);
      if (since.getTime() > now.getTime()) {
        // Suggest the current (already-started) year, not the year before the
        // requested one, which may still be in the future.
        throw new Error(`${year} has not started; use --year ${now.getFullYear()}`);
      }
      return finalizeComputed({ form: "year", since, until, label: `${year}`, timezone });
    }

    case "--since": {
      const since = requireString(args, "since", "--since");
      const untilGiven = has(args, "until");
      const until = untilGiven ? requireString(args, "until", "--until") : now.toISOString();
      return {
        form: "range",
        since,
        until,
        // `--since`/`--until` accept dates or refs verbatim; they are passed to
        // git as given (#349), so they are not normalized to instants here and
        // are marked "expression" for the git-reading layer to resolve. A
        // defaulted `--until` is the concrete `now` instant, not an expression.
        since_kind: "expression",
        until_kind: untilGiven ? "expression" : "instant",
        label: untilGiven ? `${since} .. ${until}` : `Since ${since}`,
        timezone,
      };
    }

    default:
      // selectedForms only ever yields the flags handled above.
      throw new Error(`git analyze: unrecognized window form ${form}`);
  }
}

function finalizeComputed({ form, since, until, label, timezone }) {
  return {
    form,
    since: since.toISOString(),
    until: until.toISOString(),
    // Computed windows are absolute instants, ready to hand to git as-is.
    since_kind: "instant",
    until_kind: "instant",
    label,
    timezone,
  };
}
