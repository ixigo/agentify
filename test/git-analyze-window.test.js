import test from "node:test";
import assert from "node:assert/strict";

import { resolveWindow } from "../src/core/git-analyze/window.js";

// The window resolver reads the process timezone for its calendar arithmetic.
// These helpers pin TZ around each assertion so the tests are deterministic
// regardless of the machine they run on.
function withTZ(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

// A fixed "now" so relative windows (--days/--months/default) are reproducible.
const NOW = new Date("2026-07-29T12:00:00.000Z");

test("default (no flags) is the last 30 days, half-open", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({}, { now: NOW });
    assert.equal(win.form, "days");
    assert.equal(win.label, "Last 30 days");
    assert.equal(win.until, NOW.toISOString());
    assert.equal(win.since, "2026-06-29T12:00:00.000Z");
    assert.equal(win.timezone, "UTC");
  });
});

test("--days N resolves to [now - N days, now)", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ days: 7 }, { now: NOW });
    assert.equal(win.form, "days");
    assert.equal(win.since, "2026-07-22T12:00:00.000Z");
    assert.equal(win.until, NOW.toISOString());
    assert.equal(win.label, "Last 7 days");
  });
});

test("--days 1 uses the singular label", () => {
  const win = resolveWindow({ days: 1 }, { now: NOW });
  assert.equal(win.label, "Last 1 day");
});

test("--months N subtracts calendar months, not 30-day blocks", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ months: 3 }, { now: NOW });
    assert.equal(win.form, "months");
    assert.equal(win.since, "2026-04-29T12:00:00.000Z");
    assert.equal(win.until, NOW.toISOString());
    assert.equal(win.label, "Last 3 months");
  });
});

test("--months 1 from 31 March clamps to the last day of February", () => {
  withTZ("UTC", () => {
    const march31 = new Date("2025-03-31T09:00:00.000Z");
    const win = resolveWindow({ months: 1 }, { now: march31 });
    // February 2025 has 28 days, so the clamped start is 28 Feb, never 3 Mar.
    assert.equal(win.since, "2025-02-28T09:00:00.000Z");
  });
});

test("--quarter resolves to the calendar quarter of the given year", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ quarter: 2, year: 2025 }, { now: NOW });
    assert.equal(win.form, "quarter");
    assert.equal(win.label, "Q2 2025");
    assert.equal(win.since, "2025-04-01T00:00:00.000Z");
    assert.equal(win.until, "2025-07-01T00:00:00.000Z");
  });
});

test("--quarter defaults the year to the current year", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ quarter: 1 }, { now: NOW });
    assert.equal(win.label, "Q1 2026");
    assert.equal(win.since, "2026-01-01T00:00:00.000Z");
    assert.equal(win.until, "2026-04-01T00:00:00.000Z");
  });
});

test("--quarter 1 --year 2028 handles the leap year (Q1 spans Jan-Mar)", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ quarter: 1, year: 2028 }, { now: new Date("2029-01-01T00:00:00.000Z") });
    assert.equal(win.since, "2028-01-01T00:00:00.000Z");
    // Half-open end is 1 Apr regardless of Feb having 29 days that year.
    assert.equal(win.until, "2028-04-01T00:00:00.000Z");
  });
});

test("--year alone resolves to [Jan 1, Jan 1 next year)", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ year: 2025 }, { now: NOW });
    assert.equal(win.form, "year");
    assert.equal(win.label, "2025");
    assert.equal(win.since, "2025-01-01T00:00:00.000Z");
    assert.equal(win.until, "2026-01-01T00:00:00.000Z");
  });
});

test("--since with --until passes both through as refs", () => {
  const win = resolveWindow({ since: "2025-01-01", until: "2025-06-01" }, { now: NOW });
  assert.equal(win.form, "range");
  assert.equal(win.since, "2025-01-01");
  assert.equal(win.until, "2025-06-01");
  assert.equal(win.since_kind, "expression");
  assert.equal(win.until_kind, "expression");
  assert.equal(win.label, "2025-01-01 .. 2025-06-01");
});

test("--since without --until defaults until to now", () => {
  const win = resolveWindow({ since: "v1.0.0" }, { now: NOW });
  assert.equal(win.since, "v1.0.0");
  assert.equal(win.until, NOW.toISOString());
  assert.equal(win.until_kind, "instant");
  assert.equal(win.label, "Since v1.0.0");
});

test("Q1/Q2 boundary is identical and does not overlap under UTC", () => {
  withTZ("UTC", () => {
    const q1 = resolveWindow({ quarter: 1, year: 2026 }, { now: NOW });
    const q2 = resolveWindow({ quarter: 2, year: 2026 }, { now: NOW });
    // Half-open: Q1's exclusive end is byte-identical to Q2's inclusive start,
    // so a commit at that instant belongs to exactly one quarter (Q2).
    assert.equal(q1.until, q2.since);
    assert.equal(q1.until, "2026-04-01T00:00:00.000Z");
  });
});

test("Q1/Q2 boundary stays half-open and consistent under Pacific/Kiritimati", () => {
  withTZ("Pacific/Kiritimati", () => {
    const tz = "Pacific/Kiritimati";
    const q1 = resolveWindow({ quarter: 1, year: 2026 }, { now: NOW });
    const q2 = resolveWindow({ quarter: 2, year: 2026 }, { now: NOW });
    // The absolute instant differs from UTC (Kiritimati is UTC+14), but the
    // no-overlap invariant is preserved: Q1.until === Q2.since.
    assert.equal(q1.until, q2.since);
    // Local midnight 1 Apr in UTC+14 is 31 Mar 10:00 UTC.
    assert.equal(q1.until, "2026-03-31T10:00:00.000Z");
    assert.equal(q1.timezone, tz);
  });
});

test("mutually exclusive window forms error naming both", () => {
  assert.throws(
    () => resolveWindow({ days: 5, months: 2 }, { now: NOW }),
    /mutually exclusive.*--days.*--months/,
  );
});

test("--year combined with --days is a conflict", () => {
  assert.throws(
    () => resolveWindow({ year: 2025, days: 5 }, { now: NOW }),
    /mutually exclusive/,
  );
});

test("--year with --quarter is NOT a conflict (year modifies quarter)", () => {
  withTZ("UTC", () => {
    const win = resolveWindow({ quarter: 3, year: 2024 }, { now: NOW });
    assert.equal(win.label, "Q3 2024");
  });
});

test("--until without --since errors", () => {
  assert.throws(
    () => resolveWindow({ until: "2025-06-01" }, { now: NOW }),
    /--until requires --since/,
  );
});

test("--quarter 5 errors naming the flag and range", () => {
  assert.throws(
    () => resolveWindow({ quarter: 5 }, { now: NOW }),
    /--quarter must be an integer 1-4/,
  );
});

test("--days 0 errors naming the flag", () => {
  assert.throws(
    () => resolveWindow({ days: 0 }, { now: NOW }),
    /--days must be a positive integer/,
  );
});

test("--days abc errors naming the flag", () => {
  assert.throws(
    () => resolveWindow({ days: "abc" }, { now: NOW }),
    /--days must be a positive integer/,
  );
});

test("--days with no value (parsed true) errors", () => {
  assert.throws(
    () => resolveWindow({ days: true }, { now: NOW }),
    /--days must be a positive integer/,
  );
});

test("a quarter that has not started suggests the current started quarter", () => {
  withTZ("UTC", () => {
    // Q4 2026 starts 1 Oct 2026; from July 2026 (Q3) it has not started.
    assert.throws(
      () => resolveWindow({ quarter: 4, year: 2026 }, { now: NOW }),
      /Q4 2026 has not started; use --quarter 3 --year 2026 or --year 2026/,
    );
  });
});

test("a far-future quarter suggests a started period, never another future one", () => {
  withTZ("UTC", () => {
    // From 2026, Q1 2028 must not be told to use Q4 2027 (also future).
    assert.throws(
      () => resolveWindow({ quarter: 1, year: 2028 }, { now: NOW }),
      /use --quarter 3 --year 2026 or --year 2026/,
    );
  });
});

test("a year that has not started suggests the current year", () => {
  withTZ("UTC", () => {
    assert.throws(
      () => resolveWindow({ year: 2027 }, { now: NOW }),
      /2027 has not started; use --year 2026/,
    );
    // A far-future year still suggests the current (started) year.
    assert.throws(
      () => resolveWindow({ year: 2031 }, { now: NOW }),
      /2031 has not started; use --year 2026/,
    );
  });
});
