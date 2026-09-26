// Pure decision logic. No I/O, so it can be checked in isolation.

export interface UsageWindow {
  id: string;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
}

export interface ProviderUsage {
  providerId: string;
  windows: readonly UsageWindow[];
}

export interface Exhaustion {
  limitId: string;
  resetsAtMs: number;
}

/**
 * Only usage windows count. Balances are ignored: a prepaid credit balance
 * that sits at zero is normal and says nothing about why a turn stopped.
 *
 * Returns the exhausted limit that resets last, or null when nothing is
 * exhausted or an exhausted limit has no usable reset time. The agent can only
 * continue once every exhausted limit has reset, so the latest one wins.
 */
export function findExhaustion(
  usage: readonly ProviderUsage[],
  providerId: string,
  nowMs: number,
  maxWaitMs: number,
): Exhaustion | null {
  const entry = providerEntry(usage, providerId);
  if (!entry) return null;

  const exhausted = entry.windows.filter(
    (window) =>
      (typeof window.usedPct === "number" && window.usedPct >= 100) ||
      (typeof window.remainingPct === "number" && window.remainingPct <= 0),
  );
  if (exhausted.length === 0) return null;

  let latest: Exhaustion | null = null;
  for (const limit of exhausted) {
    const resetsAtMs = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
    // An exhausted limit without a trustworthy reset time means we cannot know
    // when to resume, so do nothing rather than guess.
    if (!Number.isFinite(resetsAtMs) || resetsAtMs - nowMs > maxWaitMs) return null;
    if (!latest || resetsAtMs > latest.resetsAtMs) latest = { limitId: limit.id, resetsAtMs };
  }
  return latest;
}

// Agents can report "provider/model" (e.g. "claude/claude-opus-5-5"); usage is keyed by provider.
function providerEntry(usage: readonly ProviderUsage[], providerId: string) {
  const baseProvider = providerId.split("/")[0];
  return usage.find((candidate) => candidate.providerId === baseProvider) ?? null;
}

/**
 * Reset time for a limit named in a notice ("session", "weekly", "opus weekly"),
 * taken from the matching usage window. Structured data beats the notice's clock time.
 */
export function resetFromUsage(
  usage: readonly ProviderUsage[],
  providerId: string,
  noticeKind: string,
  nowMs: number,
  maxWaitMs: number,
): number | null {
  const entry = providerEntry(usage, providerId);
  if (!entry) return null;
  const candidates =
    noticeKind === "session"
      ? entry.windows.filter((window) => window.id === "five_hour")
      : noticeKind.includes("weekly")
        ? entry.windows
            .filter((window) => window.id.startsWith("weekly"))
            .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))
        : [];
  for (const window of candidates) {
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (Number.isFinite(resetsAtMs) && resetsAtMs > nowMs - 10 * 60_000 && resetsAtMs - nowMs <= maxWaitMs) {
      return resetsAtMs;
    }
  }
  return null;
}

/** One-line summary of a provider's windows for the plugin log. */
export function describeUsage(usage: readonly ProviderUsage[], providerId: string): string {
  const entry = providerEntry(usage, providerId);
  if (!entry) return "no usage data";
  if (entry.windows.length === 0) return "no usage windows";
  return entry.windows
    .map((window) => `${window.id} ${window.usedPct ?? "?"}% resets ${window.resetsAt ?? "?"}`)
    .join("; ");
}
