// Calendar entries, clash detection and ICS output. Pure functions shared by the
// browser (which holds each device's plans) and the tests.
import { DateTime } from 'luxon';
import { datesTouched } from './dates';

export interface CalendarEntry {
  key: string;
  kind: 'event' | 'entry' | 'plan';
  event_id: string | null;
  title: string;
  /** Planning status for events and your own entries; 'plan' for personal plans. */
  status: string;
  event_status: string | null;
  start_local: string;
  end_local: string | null;
  timezone: string;
  start_utc: string;
  end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
  multi_day: boolean;
  location: string | null;
  needs_date: boolean;
  is_demo: boolean;
}

export interface Clash {
  a: string;
  b: string;
  type: 'overlap' | 'possible';
  dates: string[];
  reason: string;
  reviewed: boolean;
}

export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function isMultiDay(startUtc: string, endUtc: string) {
  return DateTime.fromISO(endUtc).diff(DateTime.fromISO(startUtc), 'hours').hours > 24;
}

/**
 * Overlap: both entries have known start and end times and the intervals intersect.
 * Possible: they share a calendar day in the planning time zone but at least one time
 * is missing, so an overlap cannot be ruled out.
 */
export function detectClashes(entries: CalendarEntry[], tz: string, reviewed: Set<string>): Clash[] {
  const active = entries.filter((e) => e.event_status !== 'cancelled' && !e.needs_date);
  const clashes: Clash[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const c = active[j];
      if (a.event_id && a.event_id === c.event_id) continue;
      const [ka, kb] = pairKey(a.key, c.key);
      const known = a.start_time_known && a.end_time_known && c.start_time_known && c.end_time_known;
      const intersects = a.start_utc < c.end_utc && c.start_utc < a.end_utc;
      if (known) {
        if (intersects) {
          const dates = datesTouched(a.start_utc > c.start_utc ? a.start_utc : c.start_utc, a.end_utc < c.end_utc ? a.end_utc : c.end_utc, tz);
          clashes.push({ a: ka, b: kb, type: 'overlap', dates, reason: 'Both have confirmed times that overlap', reviewed: reviewed.has(`${ka}|${kb}`) });
        }
        continue;
      }
      const da = new Set(datesTouched(a.start_utc, a.end_utc, tz));
      const shared = datesTouched(c.start_utc, c.end_utc, tz).filter((d) => da.has(d));
      if (shared.length && intersects) {
        clashes.push({ a: ka, b: kb, type: 'possible', dates: shared, reason: 'Same day — times not confirmed, so an overlap is possible', reviewed: reviewed.has(`${ka}|${kb}`) });
      }
    }
  }
  return clashes;
}

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

const enc = new TextEncoder();
function fold(line: string) {
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const icsUtc = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");

export interface IcsItem {
  uid: string;
  title: string;
  start_local: string;
  start_utc: string;
  end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
  timezone: string;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  cancelled?: boolean;
}

/** Standard iCalendar (RFC 5545). Timed events use UTC; date-only events are all-day. */
export function buildIcs(appName: string, items: IcsItem[], now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${appName}//Events//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(appName)}`];
  const stamp = icsUtc(now.toISOString());
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:${it.uid}`, `DTSTAMP:${stamp}`);
    if (it.start_time_known) {
      lines.push(`DTSTART:${icsUtc(it.start_utc)}`, `DTEND:${icsUtc(it.end_utc)}`);
    } else {
      const sd = it.start_local.slice(0, 10).replace(/-/g, '');
      const endDate = DateTime.fromISO(it.end_utc).setZone(it.timezone).toISODate()!;
      const ed = DateTime.fromISO(endDate).plus({ days: 1 }).toFormat('yyyyMMdd');
      lines.push(`DTSTART;VALUE=DATE:${sd}`, `DTEND;VALUE=DATE:${ed}`);
    }
    lines.push(`SUMMARY:${icsEscape(it.title)}`);
    if (it.location) lines.push(`LOCATION:${icsEscape(it.location)}`);
    const desc = [it.description, !it.start_time_known ? 'Start time to be announced.' : !it.end_time_known ? 'Finish time not confirmed.' : null, `Times shown in ${it.timezone}.`]
      .filter(Boolean)
      .join('\n');
    lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (it.url) lines.push(`URL:${it.url}`);
    if (it.cancelled) lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
