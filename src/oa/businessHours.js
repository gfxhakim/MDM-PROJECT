// Team business hours in the team's time zone (oa.business_* config). Pure functions.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN = 60_000;

/** Local wall-clock parts of `date` in `timeZone`. */
function localParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second,
    weekday: p.weekday.toLowerCase().slice(0, 3),
  };
}

/** The UTC instant of local wall-clock time y-m-d hh:mm in `timeZone`. */
function zonedInstant(y, m, d, hh, mm, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = localParts(new Date(guess), timeZone);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - guess;
  return new Date(guess - offset);
}

const hm = (s) => s.split(':').map(Number);

export function hoursFromConfig(c) {
  return {
    timeZone: c['oa.business_timezone'],
    open: hm(c['oa.business_open']),
    close: hm(c['oa.business_close']),
    days: new Set(c['oa.business_days'].split(',')),
  };
}

/** Business window [start, end] for the local day containing `date`, or null on a day off. */
function windowFor(date, bh) {
  const p = localParts(date, bh.timeZone);
  if (!bh.days.has(p.weekday)) return null;
  return {
    start: zonedInstant(p.y, p.m, p.d, bh.open[0], bh.open[1], bh.timeZone),
    end: zonedInstant(p.y, p.m, p.d, bh.close[0], bh.close[1], bh.timeZone),
  };
}

export function isBusinessTime(date, bh) {
  const w = windowFor(date, bh);
  return !!w && date >= w.start && date < w.end;
}

/** Start and end of the local calendar day containing `date` ("today" for the capacity model). */
export function localDayBounds(date, bh) {
  const p = localParts(date, bh.timeZone);
  const start = zonedInstant(p.y, p.m, p.d, 0, 0, bh.timeZone);
  const next = localParts(new Date(start.getTime() + 36 * 3_600_000), bh.timeZone);
  return { start, end: zonedInstant(next.y, next.m, next.d, 0, 0, bh.timeZone) };
}

/** Business minutes elapsed between two instants (first-contact SLA, r2). */
export function businessMinutesBetween(from, to, bh) {
  if (to <= from) return 0;
  let total = 0;
  let cursor = new Date(from);
  for (let i = 0; i < 400 && cursor < to; i++) {
    const w = windowFor(cursor, bh);
    if (w) {
      const s = Math.max(w.start, cursor);
      const e = Math.min(w.end, to);
      if (e > s) total += (e - s) / MIN;
    }
    cursor = localDayBounds(cursor, bh).end;
  }
  return Math.floor(total);
}

export { DAYS };

/** The instant `minutes` business minutes after `from` (first-contact due date, OA 3.4). */
export function addBusinessMinutes(from, minutes, bh) {
  let remaining = minutes;
  let cursor = new Date(from);
  for (let i = 0; i < 400; i++) {
    const w = windowFor(cursor, bh);
    if (w && cursor < w.end) {
      const s = cursor > w.start ? cursor : w.start;
      const avail = (w.end - s) / MIN;
      if (avail >= remaining) return new Date(s.getTime() + remaining * MIN);
      remaining -= avail;
    }
    cursor = localDayBounds(cursor, bh).end;
  }
  return cursor;
}
