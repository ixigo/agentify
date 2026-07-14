import test from "node:test";
import assert from "node:assert/strict";

import { formatDay } from "../src/dates.js";

test("formats a late-evening UTC instant as its UTC calendar day", () => {
  assert.equal(formatDay(new Date("2026-03-02T02:30:00Z")), "2026-03-02");
});

test("formats a new-year UTC instant as its UTC calendar day", () => {
  assert.equal(formatDay(new Date("2027-01-01T04:00:00Z")), "2027-01-01");
});
