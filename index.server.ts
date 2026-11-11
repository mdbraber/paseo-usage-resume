import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { clearAttention } from "./server/attention";
import { findLimitNotice, mentionsLimit, resetFromClock, type TimelineItem } from "./server/notice";
import { CATCH_UP_WINDOW_MS, chooseReset, isCatchUpCandidate } from "./server/plan";
import { describeUsage, findExhaustion, resetFromUsage } from "./server/usage";

// Fixed text. Nothing from the transcript or the provider error is ever sent.
const RESUME_PROMPT =
  "Your previous turn stopped because the provider usage limit was reached. " +
  "The limit has now reset. Continue where you left off. " +
  "If the task was already complete, reply briefly that it is done and do nothing else.";

const MINUTE = 60_000;
const RESUME_DELAY_AFTER_RESET_MS = 2 * MINUTE;
// Paseo caches provider usage for five minutes; re-check once after that expires.
const STALE_USAGE_RECHECK_MS = 6 * MINUTE;
// Longest wait we accept. Covers weekly limits; anything later is treated as unknown.
const MAX_WAIT_MS = 8 * 24 * 60 * MINUTE;
// A 5-hour window can reset at most five times in 24 hours; one more allows a weekly reset.
// Each limit is already resumed only once; this cap is a backstop against runaway loops.
const MAX_RESUMES_PER_AGENT_PER_DAY = 6;
// How often idle agents are checked for a limit notice that no scheduled resume covers.
const CATCH_UP_INTERVAL_MS = 10 * MINUTE;
const TIMELINE_TAIL = 20;
const DAEMON_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type PaseoApi = PluginHookContext["paseo"];

interface AgentRef {
  id: string;
  provider: string;
}

interface TimelineEntry {
  item: TimelineItem;
  timestamp?: string;
  seqEnd?: number;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

export default function contribute(server: PluginServerContext) {
  const pending = new Map<string, Pending>();
  const resumedLimits = new Set<string>();
  const resumeTimes = new Map<string, number[]>();
  // Last timeline position looked at per agent, so an unchanged timeline is not re-examined.
  const examined = new Map<string, string>();
  let api: PaseoApi | null = null;
  let catchUpTimer: ReturnType<typeof setInterval> | null = null;
  let catchUpRunning = false;

  function cancel(agentId: string, reason: string) {
    const entry = pending.get(agentId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(agentId);
    console.log(`[${agentId}] cancelled ${entry.label}: ${reason}`);
  }

  function schedule(agentId: string, delayMs: number, label: string, run: () => Promise<void>) {
    cancel(agentId, "replaced");
    const timer = setTimeout(() => {
      pending.delete(agentId);
      run().catch((error) => console.error(`[${agentId}] ${label} failed:`, error));
    }, delayMs);
    pending.set(agentId, { timer, label });
    console.log(`[${agentId}] scheduled ${label} at ${new Date(Date.now() + delayMs).toISOString()}`);
  }

  function scheduleResume(agent: AgentRef, paseo: PaseoApi, limitId: string, resetsAtMs: number) {
    const now = Date.now();
    const limitKey = `${agent.id}:${limitId}:${resetsAtMs}`;
    if (resumedLimits.has(limitKey)) {
      console.log(`[${agent.id}] already resumed once for ${limitId}; not repeating`);
      return;
    }
    const recent = (resumeTimes.get(agent.id) ?? []).filter((time) => now - time < 24 * 60 * MINUTE);
    if (recent.length >= MAX_RESUMES_PER_AGENT_PER_DAY) {
      console.log(`[${agent.id}] daily resume cap reached; not scheduling`);
      return;
    }

    const delayMs = Math.max(0, resetsAtMs - now) + RESUME_DELAY_AFTER_RESET_MS;
    schedule(agent.id, delayMs, `resume after ${limitId} reset`, async () => {
      const ref = paseo.agents.ref(agent.id);
      await ref.refresh();
      const busy = ref.status === "running" || ref.status === "initializing";
      if (busy || ref.status === "closed" || ref.archivedAt || ref.activeTurn || ref.pendingPermissions?.length) {
        console.log(`[${agent.id}] skipped resume: agent is ${ref.status ?? "unavailable"}`);
        return;
      }
      // Otherwise the unread limit notice suppresses the notification for the resumed turn.
      if (ref.current()?.requiresAttention && !clearAttention(agent.id)) {
        console.log(`[${agent.id}] could not clear the unread flag; the resumed turn may not notify`);
      }
      try {
        await ref.send(RESUME_PROMPT);
      } catch (error) {
        // Forget the timeline position so the next catch-up check looks at this agent again.
        examined.delete(agent.id);
        throw error;
      }
      // Recorded only once sent, so a failed send can be retried.
      resumedLimits.add(limitKey);
      resumeTimes.set(agent.id, [...recent, Date.now()]);
      console.log(`[${agent.id}] resumed`);
    });
  }

  async function readUsage(agent: AgentRef, paseo: PaseoApi) {
    const { providers } = await paseo.providers.listUsage();
    console.log(`[${agent.id}] usage: ${describeUsage(providers, agent.provider)}`);
    return providers;
  }

  async function checkUsage(agent: AgentRef, paseo: PaseoApi, isRecheck: boolean) {
    const providers = await readUsage(agent, paseo);
    const exhaustion = findExhaustion(providers, agent.provider, Date.now(), MAX_WAIT_MS);
    if (exhaustion) {
      scheduleResume(agent, paseo, exhaustion.limitId, exhaustion.resetsAtMs);
    } else if (!isRecheck) {
      schedule(agent.id, STALE_USAGE_RECHECK_MS, "usage re-check", () => checkUsage(agent, paseo, true));
    }
  }

  async function fetchTail(agentId: string, paseo: PaseoApi): Promise<TimelineEntry[]> {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: TIMELINE_TAIL });
    const entries = page.entries as unknown as TimelineEntry[];
    const last = entries[entries.length - 1];
    examined.set(agentId, `${entries.length}:${last?.seqEnd ?? ""}:${last?.timestamp ?? ""}`);
    return entries;
  }

  /**
   * Schedules a resume when the timeline ends with a limit notice. Returns false when there is
   * no notice. The reset is computed relative to when the notice was written, so a notice found
   * hours later still resolves to the reset it named.
   */
  async function resumeOnNotice(agent: AgentRef, entries: readonly TimelineEntry[], paseo: PaseoApi) {
    const notice = findLimitNotice(entries.map((entry) => entry.item));
    if (!notice) return false;
    const now = Date.now();
    const writtenMs = Date.parse(entries[entries.length - 1]?.timestamp ?? "");
    const noticeAt = Number.isFinite(writtenMs) ? Math.min(writtenMs, now) : now;
    const clockReset = resetFromClock(notice, noticeAt, DAEMON_TIME_ZONE);
    // The usage window only describes the current period; skip it once the named reset has passed.
    const usageReset =
      clockReset !== null && clockReset <= now
        ? null
        : resetFromUsage(await readUsage(agent, paseo), agent.provider, notice.kind, now, MAX_WAIT_MS);
    const resetsAtMs = chooseReset(clockReset, usageReset, now);
    if (resetsAtMs === null || resetsAtMs - now > MAX_WAIT_MS) {
      console.log(`[${agent.id}] ${notice.kind} limit notice, but no usable reset time; not resuming`);
      return true;
    }
    scheduleResume(agent, paseo, `${notice.kind} limit`, resetsAtMs);
    return true;
  }

  async function onTurnEnded(agent: AgentRef, failed: boolean, paseo: PaseoApi) {
    const entries = await fetchTail(agent.id, paseo);
    console.log(`[${agent.id}] turn ${failed ? "failed" : "completed"} (${agent.provider}, ${entries.length} timeline items)`);
    // Claude Code reports a usage limit as an ordinary final message, so the notice is the primary signal.
    if (await resumeOnNotice(agent, entries, paseo)) return;
    const timeline = entries.map((entry) => entry.item);
    // Other providers fail the turn instead, and Claude Code may change its wording again;
    // in both cases only usage data showing an exhausted window leads to a resume.
    if (failed || mentionsLimit(timeline)) {
      if (!failed) console.log(`[${agent.id}] final text mentions a limit the notice pattern did not recognise`);
      await checkUsage(agent, paseo, false);
      return;
    }
    // Log only item types, never text, so a missed notice can be diagnosed from the log.
    console.log(`[${agent.id}] no limit notice; last items: ${timeline.slice(-4).map((item) => item.type).join(", ")}`);
  }

  /**
   * Finds idle agents that stopped at a limit with no resume scheduled: a turn-end event that was
   * missed, a plugin reload or a daemon restart. Only notices from the last 24 hours count.
   */
  async function catchUp(paseo: PaseoApi) {
    if (catchUpRunning) return;
    catchUpRunning = true;
    try {
      const now = Date.now();
      const { entries } = await paseo.agents.list({ filter: { statuses: ["idle", "error"] }, page: { limit: 200 } });
      for (const { agent } of entries) {
        if (pending.has(agent.id) || !isCatchUpCandidate(agent, now)) continue;
        const before = examined.get(agent.id);
        const tail = await fetchTail(agent.id, paseo);
        if (examined.get(agent.id) === before) continue;
        const writtenMs = Date.parse(tail[tail.length - 1]?.timestamp ?? "");
        if (!Number.isFinite(writtenMs) || now - writtenMs > CATCH_UP_WINDOW_MS) continue;
        const ref = { id: agent.id, provider: agent.provider };
        if (findLimitNotice(tail.map((entry) => entry.item))) {
          console.log(`[${agent.id}] catch-up: found a limit notice from ${new Date(writtenMs).toISOString()}`);
          await resumeOnNotice(ref, tail, paseo);
        }
      }
    } catch (error) {
      console.error("catch-up check failed:", error);
    } finally {
      catchUpRunning = false;
    }
  }

  // The plugin API is only handed to hooks, so the first hook starts the periodic catch-up check.
  function remember(paseo: PaseoApi) {
    if (api) return;
    api = paseo;
    console.log("catch-up check started");
    void catchUp(paseo);
    catchUpTimer = setInterval(() => void catchUp(paseo), CATCH_UP_INTERVAL_MS);
  }

  // Any new turn, whether from the user or elsewhere, means the agent is no longer waiting.
  server.on("agent.turn_started", ({ agent }, { paseo }) => {
    remember(paseo);
    cancel(agent.id, "a new turn started");
  });
  server.on("agent.archived", ({ agent }, { paseo }) => {
    remember(paseo);
    cancel(agent.id, "agent archived");
  });
  server.on("agent.created", (_event, { paseo }) => remember(paseo));
  server.on("agent.closed", (_event, { paseo }) => remember(paseo));
  server.on("agent.permission_requested", (_event, { paseo }) => remember(paseo));

  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
    remember(paseo);
    if (outcome.kind === "canceled") return;
    try {
      await onTurnEnded(agent, outcome.kind === "failed", paseo);
    } catch (error) {
      console.error(`[${agent.id}] limit check failed:`, error);
    }
  });

  return () => {
    if (catchUpTimer) clearInterval(catchUpTimer);
    for (const agentId of [...pending.keys()]) cancel(agentId, "plugin stopped");
  };
}
