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
 * Statuses of an agent that is waiting for input. "closed" is included because Paseo shuts down
 * an agent's provider process after about an hour idle ("Collected idle agent runtime") and then
 * reports it as closed; a message sent to it starts the process again. An agent waiting out a
 * multi-hour limit is nearly always in that state when the limit resets.
 */
export const WAITING_STATUSES = ["idle", "error", "closed"] as const;

export interface AgentState {
  status?: string | null;
  archivedAt?: string | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
}

/** Why an agent must not be resumed now, or null when it can be. */
export function resumeBlocker(agent: AgentState | null | undefined): string | null {
  if (!agent?.status) return "agent is unavailable";
  if (agent.archivedAt) return "agent is archived";
  if (!(WAITING_STATUSES as readonly string[]).includes(agent.status)) return `agent is ${agent.status}`;
  if (agent.activeTurn) return "agent has an active turn";
  if (agent.pendingPermissions?.length) return "agent has a pending permission request";
  return null;
}

/**
 * Whether the periodic check should look at an agent's timeline: it is waiting (idle, closed
 * after being idle, or stopped with an error), not archived, and was last active within the
 * catch-up window.
 */
export function isCatchUpCandidate(agent: AgentSummary, nowMs: number): boolean {
  if (resumeBlocker(agent) !== null) return false;
  const updatedMs = Date.parse(agent.updatedAt);
  return Number.isFinite(updatedMs) && nowMs - updatedMs <= CATCH_UP_WINDOW_MS;
}
