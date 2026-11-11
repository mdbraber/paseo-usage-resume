// Detects Claude Code's usage-limit notice, e.g.
//   "You've hit your session limit · resets 5:50pm (America/Los_Angeles)"
//   "You've hit your 5-hour limit · resets 10:40pm (Europe/Amsterdam)"
//   "You've reached your Opus weekly limit · resets Nov 3, 9am (Europe/Amsterdam)"
//   "Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles)."
// Pure functions, no I/O.

export interface TimelineItem {
  type: string;
  text?: string;
  // Paseo stores some provider errors, including usage limits, as "error" items with a message.
  message?: string;
}

export interface LimitNotice {
  /** "session", "5-hour", "weekly", "opus weekly", ... as written in the notice; "usage" when it names none. */
  kind: string;
  /** Month (1-12) and day when the notice names a date, otherwise null. */
  month: number | null;
  day: number | null;
  hour: number;
  minute: number;
  timeZone: string | null;
}

// The notice must run to the end of the line. Anything the agent quoted mid-sentence does not match.
// Wording, separator, date and clock format vary between Claude Code versions, so each is loose;
// the anchors, the "limit" header and the "reset" time keep it from matching ordinary prose.
const NOTICE = new RegExp(
  [
    "^(?:You(?:['’]ve| have) (?:hit|reached) your (.{1,40}?) limit|Claude(?: AI)?(?: usage)? limit reached)",
    "\\s*[·∙•|,.:;–—-]?\\s*",
    "(?:(?:your )?limit will )?resets?(?: at| on)?\\s+",
    // Optional date: "Nov 3, ", "November 3rd at ", "3 Nov, ".
    "(?:([A-Za-z]{3,9})\\.? (\\d{1,2})(?:st|nd|rd|th)?,?(?: at)?\\s+|(\\d{1,2}) ([A-Za-z]{3,9})\\.?,?(?: at)?\\s+)?",
    // Clock: "5pm", "5:50 PM", "5.50 p.m.", "17:50".
    "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:([ap])\\.?m\\.?)?",
    "(?:\\s*\\(([^()\\s]+)\\))?\\.?$",
  ].join(""),
  "i",
);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthNumber(name: string): number | null {
  const index = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return index < 0 ? null : index + 1;
}

const FINAL_TEXT_TYPES = new Set(["assistant_message", "error"]);

function textOf(item: TimelineItem): string {
  return item.type === "error" ? (item.message ?? "") : (item.text ?? "");
}

/** The assistant messages and error items after the last item of any other kind. */
function finalItems(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  let start = timeline.length;
  while (start > 0 && FINAL_TEXT_TYPES.has(timeline[start - 1]?.type ?? "")) start--;
  return timeline.slice(start);
}

function lastLineOf(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}

// Where a notice can begin inside a line. The notice may follow the agent's own last sentence
// on the same line, because separate assistant messages can be joined without a line break.
const NOTICE_START = /You(?:['’]ve| have) (?:hit|reached) your |Claude(?: AI)?(?: usage)? limit reached/gi;
// What may come directly before a notice that does not start the line: a space or the end
// of a sentence. A quote mark is excluded, so a quoted notice never counts.
const BEFORE_NOTICE = /[\s.!?:;)\]]/;

/** Matches a line that is a notice, or that ends with a notice after the agent's own sentence. */
function matchNoticeLine(line: string): RegExpExecArray | null {
  for (const start of line.matchAll(NOTICE_START)) {
    const index = start.index ?? 0;
    if (index > 0 && !BEFORE_NOTICE.test(line[index - 1] ?? "")) continue;
    const match = NOTICE.exec(line.slice(index));
    if (match) return match;
  }
  return null;
}

/**
 * Returns the notice when it ends the agent's final text (the assistant messages and error items
 * after the last item of any other kind). Returns null otherwise.
 *
 * Streamed chunks of one message are joined directly, but separate messages may or may not
 * end in a line break, so both the joined text and the last message on its own are checked.
 */
export function findLimitNotice(timeline: readonly TimelineItem[]): LimitNotice | null {
  const items = finalItems(timeline);
  if (items.length === 0) return null;
  // An error item always starts a new line.
  const joined = items.map((item) => (item.type === "error" ? `\n${textOf(item)}` : textOf(item))).join("");
  const lastItem = items[items.length - 1] as TimelineItem;
  const match = matchNoticeLine(lastLineOf(joined)) ?? matchNoticeLine(lastLineOf(textOf(lastItem)));
  if (!match) return null;
  const [, kind, monthFirst, dayAfter, dayFirst, monthAfter, hourText, minuteText, meridiem, timeZone] = match;

  let month: number | null = null;
  let day: number | null = null;
  const monthName = monthFirst ?? monthAfter;
  if (monthName) {
    month = monthNumber(monthName);
    day = Number(dayAfter ?? dayFirst);
    if (month === null || day < 1 || day > 31) return null;
  }

  const rawHour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) return null;
  let hour: number;
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) return null;
    hour = (rawHour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
  } else {
    // Without am/pm only a 24-hour clock with minutes is unambiguous.
    if (!minuteText || rawHour > 23) return null;
    hour = rawHour;
  }
  return { kind: kind?.trim().toLowerCase() ?? "usage", month, day, hour, minute, timeZone: timeZone ?? null };
}

// Loose signs of a limit message whose exact wording the notice pattern does not know.
const LIMIT_WORDS = /\b(?:usage|rate|session|weekly|hour|5-hour)\s+limit\b|\blimit\b[^\n]{0,80}\breset|\bout of (?:extra )?usage\b/i;

/**
 * True when the end of the final text looks like a limit message the notice pattern did not
 * recognise. Never enough to resume on its own: usage data must confirm the limit.
 */
export function mentionsLimit(timeline: readonly TimelineItem[]): boolean {
  const items = finalItems(timeline);
  const tail = items.map(textOf).join("\n").trim().slice(-300);
  return LIMIT_WORDS.test(tail);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock time of an instant in an IANA time zone. */
function wallClock(ms: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMs(ms: number, timeZone: string): number {
  const clock = wallClock(ms, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time occurs in a zone. Day overflow rolls into the next month. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Apply the offset twice so a daylight-saving change between the guess and the answer is honoured.
  const first = asUtc - offsetMs(asUtc, timeZone);
  return asUtc - offsetMs(first, timeZone);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Next occurrence of the notice's date and clock time in the time zone the notice names,
 * or in the daemon's time zone when it names none. Returns null for an unknown zone.
 */
export function resetFromClock(
  notice: LimitNotice,
  nowMs: number,
  daemonTimeZone: string,
): number | null {
  const timeZone = notice.timeZone ?? daemonTimeZone;
  if (!isValidTimeZone(timeZone)) return null;
  const today = wallClock(nowMs, timeZone);
  // A reset that passed moments ago is still the right one; older means the next occurrence.
  const passed = (reset: number) => reset < nowMs - 10 * 60_000;
  if (notice.month !== null && notice.day !== null) {
    let reset = zonedToUtc(today.year, notice.month, notice.day, notice.hour, notice.minute, timeZone);
    if (passed(reset)) {
      reset = zonedToUtc(today.year + 1, notice.month, notice.day, notice.hour, notice.minute, timeZone);
    }
    return reset;
  }
  let reset = zonedToUtc(today.year, today.month, today.day, notice.hour, notice.minute, timeZone);
  if (passed(reset)) {
    reset = zonedToUtc(today.year, today.month, today.day + 1, notice.hour, notice.minute, timeZone);
  }
  return reset;
}
