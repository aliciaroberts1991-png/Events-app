// Date and time handling shared by server and client.
//
// Conventions
// - Event times are stored as *event-local* ISO strings ("2026-12-05T23:00" or a
//   date-only "2026-12-05") together with the event's IANA timezone.
// - UTC instants (ISO strings with Z) are derived for querying and clash checks.
// - A missing time is never invented: flags record whether start/end times are known.
// - Weekends run Friday to Sunday. Ranges are computed in the planning timezone.
import { DateTime, Interval } from 'luxon';

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
export const TIME_ONLY = /^\d{2}:\d{2}$/;

export type RangePreset = 'today' | 'this-weekend' | 'next-weekend' | 'this-month' | 'custom' | 'upcoming';

export interface DateRange {
  preset: RangePreset;
  /** Inclusive local start date in the planning timezone. */
  fromDate: string;
  /** Inclusive local end date, or null for open-ended. */
  toDate: string | null;
  fromUtc: string;
  toUtc: string | null;
  label: string;
}

function fmtDay(d: DateTime) {
  return d.setLocale('en-GB').toFormat('ccc d LLL');
}

function rangeLabel(from: DateTime, to: DateTime) {
  if (from.hasSame(to, 'day')) return fmtDay(from);
  if (from.hasSame(to, 'month')) return `${from.setLocale('en-GB').toFormat('ccc d')} – ${fmtDay(to)}`;
  return `${fmtDay(from)} – ${fmtDay(to)}`;
}

/**
 * Resolve a date preset into concrete dates. "This weekend" is the Friday–Sunday
 * of the current week (or the coming one from Monday to Thursday).
 */
export function resolveRange(
  preset: RangePreset,
  tz: string,
  now: DateTime = DateTime.now(),
  custom?: { from?: string | null; to?: string | null },
): DateRange {
  const today = now.setZone(tz).startOf('day');
  let from: DateTime;
  let to: DateTime | null;
  switch (preset) {
    case 'today':
      from = today;
      to = today;
      break;
    case 'this-weekend':
    case 'next-weekend': {
      // luxon weekday: 1 = Monday ... 7 = Sunday. Friday = 5.
      const wd = today.weekday;
      let friday = wd >= 5 ? today.minus({ days: wd - 5 }) : today.plus({ days: 5 - wd });
      if (preset === 'next-weekend') friday = friday.plus({ days: 7 });
      from = friday;
      to = friday.plus({ days: 2 });
      break;
    }
    case 'this-month':
      from = today.startOf('month');
      to = today.endOf('month').startOf('day');
      break;
    case 'custom': {
      const f = custom?.from && DATE_ONLY.test(custom.from) ? DateTime.fromISO(custom.from, { zone: tz }) : today;
      const t = custom?.to && DATE_ONLY.test(custom.to) ? DateTime.fromISO(custom.to, { zone: tz }) : null;
      from = f;
      to = t && t < f ? f : t;
      break;
    }
    default:
      from = today;
      to = null;
  }
  const label =
    preset === 'upcoming'
      ? 'Upcoming'
      : to
        ? rangeLabel(from, to)
        : `From ${fmtDay(from)}`;
  return {
    preset,
    fromDate: from.toISODate()!,
    toDate: to ? to.toISODate()! : null,
    fromUtc: from.toUTC().toISO()!,
    toUtc: to ? to.endOf('day').toUTC().toISO()! : null,
    label,
  };
}

export interface ResolvedTimes {
  startLocal: string;
  endLocal: string | null;
  startUtc: string;
  /** Actual end instant (best estimate when the end is unknown). */
  endUtc: string;
  /**
   * End instant used for date filters: an overnight event that finishes early the
   * next morning is treated as belonging to its start date.
   */
  spanEndUtc: string;
  startTimeKnown: boolean;
  endTimeKnown: boolean;
  overnight: boolean;
}

function parseLocal(value: string, tz: string): DateTime {
  const dt = DateTime.fromISO(value, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid local date/time "${value}"`);
  return dt;
}

/**
 * Turn event-local start/end values into UTC instants.
 * - end may be a date, a local datetime, a bare time ("06:00") or empty.
 * - an end time earlier than (or equal to) the start time on the same date rolls
 *   over to the next day (overnight events).
 */
export function resolveTimes(start: string, end: string | null | undefined, tz: string): ResolvedTimes {
  if (!DATE_ONLY.test(start) && !LOCAL_DATETIME.test(start)) throw new Error(`Invalid start "${start}"`);
  const startTimeKnown = LOCAL_DATETIME.test(start);
  const s = parseLocal(start, tz);
  let e: DateTime;
  let endTimeKnown = false;
  let endLocal: string | null = null;

  if (end && TIME_ONLY.test(end)) {
    end = `${s.toISODate()}T${end}`;
  }
  if (end && LOCAL_DATETIME.test(end)) {
    e = parseLocal(end, tz);
    endTimeKnown = true;
    if (e <= s) {
      // Same-day end that is not after the start: overnight.
      if (e.toISODate() === s.toISODate()) e = e.plus({ days: 1 });
      else throw new Error(`End "${end}" is before start "${start}"`);
    }
    endLocal = e.toFormat("yyyy-MM-dd'T'HH:mm");
  } else if (end && DATE_ONLY.test(end)) {
    const ed = parseLocal(end, tz);
    if (ed < s.startOf('day')) throw new Error(`End "${end}" is before start "${start}"`);
    e = ed.endOf('day');
    endLocal = end;
  } else {
    // Unknown end. Late starts are assumed to run into the early morning.
    e = startTimeKnown && s.hour >= 20 ? s.plus({ days: 1 }).set({ hour: 6, minute: 0 }) : s.endOf('day');
  }

  const overnight = !s.hasSame(e, 'day') && e.diff(s, 'hours').hours <= 16 && e.hour < 12;
  const spanEnd = overnight ? s.endOf('day') : e;

  return {
    startLocal: startTimeKnown ? s.toFormat("yyyy-MM-dd'T'HH:mm") : s.toISODate()!,
    endLocal,
    startUtc: s.toUTC().toISO()!,
    endUtc: e.toUTC().toISO()!,
    spanEndUtc: spanEnd.toUTC().toISO()!,
    startTimeKnown,
    endTimeKnown,
    overnight,
  };
}

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval?: number;
  /** Weekday codes: MO TU WE TH FR SA SU. */
  byweekday?: string[];
  /** For monthly rules: 1 = first, 2 = second, -1 = last weekday of the month. */
  setpos?: number;
  /** For monthly rules: day of month. */
  monthday?: number;
  from: string;
  until?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  exceptions?: string[];
  extra_dates?: string[];
}

const WD_CODES: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/** Expand a recurrence rule into local occurrence dates (capped). */
export function expandRecurrence(rule: RecurrenceRule, tz: string, maxCount = 400, horizonMonths = 18): string[] {
  const from = DateTime.fromISO(rule.from, { zone: tz });
  if (!from.isValid) throw new Error('Invalid recurrence "from" date');
  const hardUntil = from.plus({ months: horizonMonths });
  const until = rule.until ? DateTime.fromISO(rule.until, { zone: tz }) : hardUntil;
  const end = until < hardUntil ? until : hardUntil;
  const interval = Math.max(1, rule.interval ?? 1);
  const exceptions = new Set(rule.exceptions ?? []);
  const wds = (rule.byweekday ?? []).map((c) => WD_CODES[c.toUpperCase()]).filter(Boolean);
  const dates = new Set<string>();

  if (rule.freq === 'daily') {
    for (let d = from; d <= end && dates.size < maxCount; d = d.plus({ days: interval })) {
      if (wds.length && !wds.includes(d.weekday)) continue;
      dates.add(d.toISODate()!);
    }
  } else if (rule.freq === 'weekly') {
    const days = wds.length ? wds : [from.weekday];
    let weekStart = from.startOf('week');
    while (weekStart <= end && dates.size < maxCount) {
      for (const wd of days) {
        const d = weekStart.plus({ days: wd - 1 });
        if (d >= from.startOf('day') && d <= end) dates.add(d.toISODate()!);
      }
      weekStart = weekStart.plus({ weeks: interval });
    }
  } else if (rule.freq === 'monthly') {
    let month = from.startOf('month');
    while (month <= end && dates.size < maxCount) {
      const candidates: DateTime[] = [];
      if (rule.monthday) {
        const d = month.set({ day: rule.monthday });
        if (d.month === month.month) candidates.push(d);
      } else if (wds.length) {
        const matching: DateTime[] = [];
        for (let d = month; d.month === month.month; d = d.plus({ days: 1 })) if (wds.includes(d.weekday)) matching.push(d);
        if (rule.setpos) {
          const pick = rule.setpos > 0 ? matching[rule.setpos - 1] : matching[matching.length + rule.setpos];
          if (pick) candidates.push(pick);
        } else candidates.push(...matching);
      } else {
        const d = month.set({ day: from.day });
        if (d.month === month.month) candidates.push(d);
      }
      for (const d of candidates) if (d >= from.startOf('day') && d <= end) dates.add(d.toISODate()!);
      month = month.plus({ months: interval });
    }
  }
  for (const x of rule.extra_dates ?? []) if (DATE_ONLY.test(x)) dates.add(x);
  return [...dates].filter((d) => !exceptions.has(d)).sort().slice(0, maxCount);
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string | null): boolean {
  return aStart <= (bEnd ?? '9999') && aEnd >= bStart;
}

/** ISO instant comparison helper (works for strings in the same "Z" format). */
export function isoMax(a: string, b: string) {
  return a > b ? a : b;
}

export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a = Interval.fromDateTimes(DateTime.fromISO(aStart), DateTime.fromISO(aEnd));
  const b = Interval.fromDateTimes(DateTime.fromISO(bStart), DateTime.fromISO(bEnd));
  return a.overlaps(b);
}

/** Local calendar date of an instant in a zone. */
export function localDate(isoUtc: string, tz: string): string {
  return DateTime.fromISO(isoUtc).setZone(tz).toISODate()!;
}

/** The local dates (in tz) touched by an interval, capped to 60 days. */
export function datesTouched(startUtc: string, endUtc: string, tz: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(startUtc).setZone(tz).startOf('day');
  const e = DateTime.fromISO(endUtc).setZone(tz);
  let guard = 0;
  while (d <= e && guard++ < 60) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

export function formatLocal(local: string, opts: { withWeekday?: boolean } = {}): string {
  const dt = DateTime.fromISO(local).setLocale('en-GB');
  if (DATE_ONLY.test(local)) return dt.toFormat(opts.withWeekday === false ? 'd LLL yyyy' : 'ccc d LLL yyyy');
  return dt.toFormat(opts.withWeekday === false ? 'd LLL yyyy, HH:mm' : 'ccc d LLL yyyy, HH:mm');
}

export function timeOf(local: string | null | undefined): string | null {
  if (!local || !LOCAL_DATETIME.test(local)) return null;
  return local.slice(11, 16);
}

export function dateOf(local: string): string {
  return local.slice(0, 10);
}

/** Short zone label such as "CET" or "CEST" for a local time in its zone. */
export function zoneAbbrev(local: string, tz: string): string {
  const dt = DateTime.fromISO(local, { zone: tz });
  return dt.isValid ? dt.toFormat('ZZZZ') : tz;
}
