// A move-out page declares one IANA timezone (default Australia/Sydney) and
// every deadline/timeslot on it is entered as a wall-clock time in that zone.
// Comparisons against "now" (is this slot past? is the deadline up?) need a
// real UTC instant, so wall-clock input has to be converted correctly across
// DST — without pulling in a date library. This uses only `Intl`, which Node
// ships with full ICU data, via a standard technique: ask Intl what wall-clock
// time a UTC guess renders as in the target zone, then correct the guess by
// the difference. One correction pass is enough for every real timezone (the
// only case it would need a second is a >1h jump mid-transition, which no
// IANA zone currently does in one step).

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function offsetMs(utcGuess: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - utcGuess;
}

// `localDateTime` is a `datetime-local` input value: "2026-10-10T18:30".
// Returns the real UTC instant that wall-clock time represents in `timeZone`,
// or null if the string doesn't parse.
export function zonedDateTimeToUtc(localDateTime: string, timeZone: string): Date | null {
  const match = localDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  const corrected = guess - offsetMs(guess, timeZone);
  return new Date(corrected);
}

// For display: formats a stored UTC instant back into the move-out's
// timezone, with the zone named so nobody has to guess which one it is.
export function formatInZone(instant: Date | string, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const formatted = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return `${formatted} (${timeZone})`;
}
