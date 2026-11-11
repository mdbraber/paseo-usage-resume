// Pure decisions about when to resume. No I/O, so they can be checked in isolation.

const HOUR = 60 * 60_000;

/** How far back the periodic check looks for an agent left stopped at a limit. */
export const CATCH_UP_WINDOW_MS = 24 * HOUR;

/**
 * The reset time to wait for, given the reset from the notice's clock time (computed relative to
 * when the notice was written) and the reset from the matching usage window (relative to now).
 *
 * A clock reset that has already passed wins: the usage window has moved on to its next period
 * by then, so its reset time would make the agent wait a whole extra window.
 */
export function chooseReset(clockReset: number | null, usageReset: number | null, nowMs: number): number | null {
  if (clockReset !== null && clockReset <= nowMs) return clockReset;
  return usageReset ?? clockReset;
}

export interface AgentSummary {
  status: string;
  updatedAt: string;
  archivedAt?: string | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[];
}

/**
 * Whether the periodic check should look at an agent's timeline: it is waiting (idle, or
 * stopped with an error), not archived, and was last active within the catch-up window.
 */
export function isCatchUpCandidate(agent: AgentSummary, nowMs: number): boolean {
  if (agent.archivedAt) return false;
  if (agent.status !== "idle" && agent.status !== "error") return false;
  if (agent.activeTurn || agent.pendingPermissions?.length) return false;
  const updatedMs = Date.parse(agent.updatedAt);
  return Number.isFinite(updatedMs) && nowMs - updatedMs <= CATCH_UP_WINDOW_MS;
}
