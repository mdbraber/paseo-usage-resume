import assert from "node:assert/strict";
import { test } from "node:test";
import { findLimitNotice, resetFromClock } from "../server/notice.ts";
import { chooseReset, isCatchUpCandidate } from "../server/plan.ts";

const NOW = Date.parse("2026-11-11T14:05:00Z");
const HOUR = 60 * 60_000;

test("uses a passed reset from the notice, not the usage window's next period", () => {
  const passed = Date.parse("2026-11-11T13:30:00Z");
  const nextWindow = Date.parse("2026-11-11T18:30:00Z");
  assert.equal(chooseReset(passed, nextWindow, NOW), passed);
});

test("prefers the usage window while the reset is still ahead", () => {
  const clock = NOW + HOUR;
  const usage = NOW + HOUR + 7_000;
  assert.equal(chooseReset(clock, usage, NOW), usage);
  assert.equal(chooseReset(clock, null, NOW), clock);
  assert.equal(chooseReset(null, usage, NOW), usage);
  assert.equal(chooseReset(null, null, NOW), null);
});

test("computes a notice found hours later from the time it was written", () => {
  const notice = findLimitNotice([{ type: "assistant_message", text: "You've hit your 5-hour limit · resets 2:30pm (Europe/Amsterdam)" }]);
  assert.ok(notice);
  const written = Date.parse("2026-11-11T09:31:48Z");
  const reset = resetFromClock(notice, written, "UTC");
  assert.equal(reset, Date.parse("2026-11-11T13:30:00Z"));
  // From the time it is found, the same clock time would wrongly mean tomorrow.
  assert.equal(resetFromClock(notice, NOW, "UTC"), Date.parse("2026-11-12T13:30:00Z"));
});

test("checks only waiting, recently active, unarchived agents", () => {
  const recent = new Date(NOW - 5 * HOUR).toISOString();
  assert.equal(isCatchUpCandidate({ status: "idle", updatedAt: recent }, NOW), true);
  assert.equal(isCatchUpCandidate({ status: "error", updatedAt: recent }, NOW), true);
  assert.equal(isCatchUpCandidate({ status: "running", updatedAt: recent }, NOW), false);
  assert.equal(isCatchUpCandidate({ status: "closed", updatedAt: recent }, NOW), false);
  assert.equal(isCatchUpCandidate({ status: "idle", updatedAt: recent, archivedAt: recent }, NOW), false);
  assert.equal(isCatchUpCandidate({ status: "idle", updatedAt: recent, pendingPermissions: [{}] }, NOW), false);
  assert.equal(isCatchUpCandidate({ status: "idle", updatedAt: new Date(NOW - 25 * HOUR).toISOString() }, NOW), false);
});
