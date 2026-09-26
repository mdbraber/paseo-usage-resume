import assert from "node:assert/strict";
import { test } from "node:test";
import { findExhaustion } from "../server/usage.ts";

const now = Date.parse("2026-09-26T12:00:00Z");
const week = 8 * 24 * 3600_000;
const at = (h: number) => new Date(now + h * 3600_000).toISOString();

test("returns null below the limit", () => {
  const usage = [{ providerId: "claude", windows: [{ id: "five_hour", usedPct: 99, resetsAt: at(1) }] }];
  assert.equal(findExhaustion(usage, "claude", now, week), null);
});

test("finds a full window", () => {
  const usage = [{ providerId: "claude", windows: [{ id: "five_hour", usedPct: 100, resetsAt: at(2) }] }];
  assert.deepEqual(findExhaustion(usage, "claude", now, week), { limitId: "five_hour", resetsAtMs: now + 2 * 3600_000 });
});

test("ignores other providers", () => {
  const usage = [{ providerId: "codex", windows: [{ id: "five_hour", usedPct: 100, resetsAt: at(2) }] }];
  assert.equal(findExhaustion(usage, "claude", now, week), null);
});

test("waits for the latest of several full limits", () => {
  const usage = [{ providerId: "claude", windows: [
    { id: "five_hour", usedPct: 100, resetsAt: at(2) },
    { id: "weekly", remainingPct: 0, resetsAt: at(30) },
  ] }];
  assert.equal(findExhaustion(usage, "claude", now, week)?.limitId, "weekly");
});

test("ignores an empty credit balance", () => {
  const usage = [{ providerId: "codex", windows: [], balances: [{ id: "credits", remaining: 0, resetsAt: at(5) }] }];
  assert.equal(findExhaustion(usage, "codex", now, week), null);
});

test("refuses to guess without a reset time", () => {
  const usage = [{ providerId: "claude", windows: [{ id: "five_hour", usedPct: 100, resetsAt: null }] }];
  assert.equal(findExhaustion(usage, "claude", now, week), null);
});

test("refuses resets beyond the maximum wait", () => {
  const usage = [{ providerId: "claude", windows: [{ id: "monthly", usedPct: 100, resetsAt: at(24 * 20) }] }];
  assert.equal(findExhaustion(usage, "claude", now, week), null);
});

test("matches a provider/model agent to its provider's usage", () => {
  const usage = [{ providerId: "claude", windows: [{ id: "five_hour", usedPct: 100, resetsAt: at(1) }] }];
  assert.equal(findExhaustion(usage, "claude/claude-opus-5-5", now, week)?.limitId, "five_hour");
});
