import assert from "node:assert/strict";
import { test } from "node:test";
import { findLimitNotice, resetFromClock } from "../server/notice.ts";
import { resetFromUsage } from "../server/usage.ts";

const assistant = (text: string) => ({ type: "assistant_message", text });
const tool = { type: "tool_call" };
const NOTICE = "You've hit your session limit · resets 5:50pm (America/Los_Angeles)";

test("finds the notice as the whole final message", () => {
  assert.deepEqual(findLimitNotice([tool, assistant(NOTICE)]), {
    kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: "America/Los_Angeles",
  });
});

test("finds the notice as the last line after other text", () => {
  const timeline = [tool, assistant("Phase 8 is committed. I'm waiting for the review.\n"), assistant(NOTICE)];
  assert.equal(findLimitNotice(timeline)?.kind, "session");
});

test("ignores the notice when work followed it", () => {
  assert.equal(findLimitNotice([assistant(NOTICE), tool]), null);
});

test("ignores the notice quoted inside a sentence", () => {
  assert.equal(findLimitNotice([assistant(`The CLI prints "${NOTICE}" when limited.`)]), null);
});

test("ignores the notice when it is not the last line", () => {
  assert.equal(findLimitNotice([assistant(`${NOTICE}\nAnyway, here is the plan.`)]), null);
});

test("reads weekly notices and whole hours", () => {
  const notice = findLimitNotice([assistant("You’ve hit your weekly limit · resets 9am (America/Los_Angeles)")]);
  assert.deepEqual(notice, { kind: "weekly", month: null, day: null, hour: 9, minute: 0, timeZone: "America/Los_Angeles" });
});

test("reads 5-hour notices", () => {
  const notice = findLimitNotice([tool, assistant("You've hit your 5-hour limit · resets 10:40pm (Europe/Amsterdam)")]);
  assert.deepEqual(notice, { kind: "5-hour", month: null, day: null, hour: 22, minute: 40, timeZone: "Europe/Amsterdam" });
});

test("takes the 5-hour reset from the five_hour usage window", () => {
  const now = Date.parse("2026-10-30T19:36:00Z");
  const usage = [{ providerId: "claude", windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-30T21:39:59Z" }] }];
  assert.equal(resetFromUsage(usage, "claude", "5-hour", now, 8 * 86_400_000), Date.parse("2026-10-30T21:39:59Z"));
});

test("reads the wording variants Claude Code has used", () => {
  const read = (line: string) => {
    const notice = findLimitNotice([assistant(line)]);
    return notice && [notice.kind, notice.month, notice.day, notice.hour, notice.minute, notice.timeZone];
  };
  assert.deepEqual(read("You have reached your Opus 4.5 weekly limit - resets 9:15 AM (Europe/Amsterdam)."),
    ["opus 4.5 weekly", null, null, 9, 15, "Europe/Amsterdam"]);
  assert.deepEqual(read("You've hit your weekly limit · resets Nov 3, 9am (Europe/Amsterdam)"),
    ["weekly", 11, 3, 9, 0, "Europe/Amsterdam"]);
  assert.deepEqual(read("You've hit your weekly limit · resets November 3rd at 9:30pm"),
    ["weekly", 11, 3, 21, 30, null]);
  assert.deepEqual(read("You've hit your weekly limit, resets 3 Nov, 22:00 (UTC)"),
    ["weekly", 11, 3, 22, 0, "UTC"]);
  assert.deepEqual(read("Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles)."),
    ["usage", null, null, 17, 0, "America/Los_Angeles"]);
  assert.deepEqual(read("You've hit your session limit ∙ resets 5.50 p.m."), ["session", null, null, 17, 50, null]);
});

test("rejects ambiguous or impossible clock times", () => {
  assert.equal(findLimitNotice([assistant("You've hit your session limit · resets 5 (UTC)")]), null);
  assert.equal(findLimitNotice([assistant("You've hit your session limit · resets 13pm")]), null);
  assert.equal(findLimitNotice([assistant("You've hit your weekly limit · resets Foo 3, 9am")]), null);
});

test("computes a dated reset, rolling into next year once passed", () => {
  const notice = { kind: "weekly", month: 11, day: 3, hour: 9, minute: 0, timeZone: "Europe/Amsterdam" };
  // Amsterdam is UTC+1 in November.
  assert.equal(resetFromClock(notice, Date.parse("2026-10-30T20:00:00Z"), "UTC"), Date.parse("2026-11-03T08:00:00Z"));
  assert.equal(resetFromClock(notice, Date.parse("2026-11-04T20:00:00Z"), "UTC"), Date.parse("2027-11-03T08:00:00Z"));
});

test("maps notice wordings to usage windows", () => {
  const now = Date.parse("2026-10-30T19:36:00Z");
  const usage = [{ providerId: "claude", windows: [
    { id: "five_hour", usedPct: 100, resetsAt: "2026-10-30T21:39:59Z" },
    { id: "weekly_model_opus", usedPct: 100, resetsAt: "2026-11-03T08:00:00Z" },
  ] }];
  const week = 8 * 86_400_000;
  for (const kind of ["5 hour", "5h", "five-hour"]) {
    assert.equal(resetFromUsage(usage, "claude", kind, now, week), Date.parse("2026-10-30T21:39:59Z"));
  }
  assert.equal(resetFromUsage(usage, "claude", "opus 4.5 weekly", now, week), Date.parse("2026-11-03T08:00:00Z"));
});

test("computes the reset in the notice's time zone, whatever the daemon's", () => {
  const notice = { kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: "America/Los_Angeles" };
  // 16:50 in Los Angeles (daylight time, UTC-7) is 23:50 UTC.
  const now = Date.parse("2026-09-26T23:50:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-27T00:50:00Z"));
  assert.equal(resetFromClock(notice, now, "Asia/Tokyo"), Date.parse("2026-09-27T00:50:00Z"));
});

test("rolls over to tomorrow once the reset time has passed", () => {
  const notice = { kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: "America/Los_Angeles" };
  const now = Date.parse("2026-09-27T01:30:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-28T00:50:00Z"));
});

test("keeps a reset that passed moments ago", () => {
  const notice = { kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: "America/Los_Angeles" };
  const now = Date.parse("2026-09-27T00:55:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-27T00:50:00Z"));
});

test("handles zones east of UTC", () => {
  const notice = { kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: "Asia/Tokyo" };
  // Tokyo is UTC+9 all year.
  const now = Date.parse("2026-09-26T06:00:00Z");
  assert.equal(resetFromClock(notice, now, "America/Los_Angeles"), Date.parse("2026-09-26T08:50:00Z"));
});

test("honours a daylight-saving change before the reset", () => {
  // Los Angeles leaves daylight time at 02:00 on 1 November 2026; 9am is then UTC-8.
  const notice = { kind: "session", month: null, day: null, hour: 9, minute: 0, timeZone: "America/Los_Angeles" };
  const now = Date.parse("2026-11-01T06:00:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-11-01T17:00:00Z"));
});

test("uses the daemon's zone when the notice names none", () => {
  const notice = { kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: null };
  const now = Date.parse("2026-09-26T14:50:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-26T17:50:00Z"));
});

test("refuses an unknown time zone", () => {
  const notice = { kind: "session", month: null, day: null, hour: 17, minute: 50, timeZone: "Mars/Olympus_Mons" };
  assert.equal(resetFromClock(notice, Date.now(), "UTC"), null);
});

test("prefers the matching usage window's reset time", () => {
  const now = Date.parse("2026-09-26T14:50:00Z");
  const usage = [{ providerId: "claude", windows: [
    { id: "five_hour", usedPct: 97, resetsAt: "2026-09-26T15:50:00Z" },
    { id: "weekly", usedPct: 40, resetsAt: "2026-09-30T10:00:00Z" },
  ] }];
  assert.equal(resetFromUsage(usage, "claude", "session", now, 8 * 86400_000), Date.parse("2026-09-26T15:50:00Z"));
  assert.equal(resetFromUsage(usage, "claude", "weekly", now, 8 * 86400_000), Date.parse("2026-09-30T10:00:00Z"));
  assert.equal(resetFromUsage(usage, "claude", "extra usage", now, 8 * 86400_000), null);
});
