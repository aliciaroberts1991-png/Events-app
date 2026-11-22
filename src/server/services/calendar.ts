// My calendar: committed plans, clash detection, history and ICS export.
import { DateTime } from 'luxon';
import { datesTouched } from '../../shared/dates';
import type { AppContext } from '../context';
import { HttpError, newId, nowIso } from '../util';
import { hydrate, type EventSummary } from './events';
import { loadPersonalContext } from './preferences';

export interface CalendarEntry {
  key: string;
  kind: 'event' | 'plan';
  event_id: string | null;
  plan_id: string | null;
  occurrence_id: string | null;
  title: string;
  status: string; // plan status for events, 'plan' for personal plans
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
  categories: string[];
  needs_date: boolean;
  is_demo: boolean;
  booking_count: number;
}

export interface Clash {
  a: string;
  b: string;
  type: 'overlap' | 'possible';
  dates: string[];
  reason: string;
  reviewed: boolean;
}

function locationOf(e: EventSummary) {
  return [e.venue?.name ?? e.location_text, e.town ?? e.city].filter(Boolean).join(', ') || null;
}

export async function calendarEntries(
  ctx: AppContext,
  userId: string,
  opts: { from?: string; to?: string; includeInterested?: boolean; past?: boolean },
): Promise<CalendarEntry[]> {
  const p = await loadPersonalContext(ctx, userId);
  const statuses = opts.includeInterested ? ['going', 'booked', 'interested'] : ['going', 'booked'];
  const states = await ctx.db
    .selectFrom('user_event_state')
    .selectAll()
    .where('user_id', '=', userId)
    .where('plan_status', 'in', statuses)
    .where('hidden', '=', 0)
    .execute();
  const fromUtc = opts.from ? DateTime.fromISO(opts.from, { zone: p.prefs.planningTimezone }).toUTC().toISO()! : '0000';
  const toUtc = opts.to ? DateTime.fromISO(opts.to, { zone: p.prefs.planningTimezone }).endOf('day').toUTC().toISO()! : '9999';
  const out: CalendarEntry[] = [];
  if (states.length) {
    const rows = await ctx.db.selectFrom('events').selectAll().where('id', 'in', states.map((s) => s.event_id)).execute();
    const events = await hydrate(ctx, rows, p, { occurrencesFrom: '0000' });
    const occs = await ctx.db.selectFrom('event_occurrences').selectAll().where('event_id', 'in', rows.map((r) => r.id)).orderBy('start_utc').execute();
    for (const e of events) {
      const st = states.find((s) => s.event_id === e.id)!;
      let list = occs.filter((o) => o.event_id === e.id);
      let needsDate = false;
      if (e.recurring && list.length > 1) {
        if (st.occurrence_id) list = list.filter((o) => o.id === st.occurrence_id);
        else needsDate = true;
      }
      for (const o of list) {
        if (o.end_utc < fromUtc || o.start_utc > toUtc) continue;
        const multiDay = DateTime.fromISO(o.end_utc).diff(DateTime.fromISO(o.start_utc), 'hours').hours > 24;
        out.push({
          key: `event:${e.id}:${o.id}`,
          kind: 'event',
          event_id: e.id,
          plan_id: null,
          occurrence_id: o.id,
          title: e.title,
          status: st.plan_status,
          event_status: e.status,
          start_local: o.start_local,
          end_local: o.end_local,
          timezone: e.timezone,
          start_utc: o.start_utc,
          end_utc: o.end_utc,
          start_time_known: !!o.start_time_known,
          end_time_known: !!o.end_time_known,
          multi_day: multiDay,
          location: locationOf(e),
          categories: e.categories,
          needs_date: needsDate,
          is_demo: e.is_demo,
          booking_count: e.state.booking_count,
        });
      }
    }
  }
  let pq = ctx.db.selectFrom('personal_plans').selectAll().where('user_id', '=', userId);
  if (opts.from) pq = pq.where('end_utc', '>=', fromUtc);
  if (opts.to) pq = pq.where('start_utc', '<=', toUtc);
  for (const pl of await pq.execute()) {
    out.push({
      key: `plan:${pl.id}`,
      kind: 'plan',
      event_id: null,
      plan_id: pl.id,
      occurrence_id: null,
      title: pl.title,
      status: 'plan',
      event_status: null,
      start_local: pl.start_local,
      end_local: pl.end_local,
      timezone: pl.timezone,
      start_utc: pl.start_utc,
      end_utc: pl.end_utc,
      start_time_known: !!pl.start_time_known,
      end_time_known: !!pl.end_time_known,
      multi_day: DateTime.fromISO(pl.end_utc).diff(DateTime.fromISO(pl.start_utc), 'hours').hours > 24,
      location: pl.location,
      categories: [],
      needs_date: false,
      is_demo: false,
      booking_count: 0,
    });
  }
  return out.sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Overlap: both entries have known times and their intervals intersect.
 * Possible: they share a calendar day (planning timezone) but at least one time
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
      if (known) {
        if (a.start_utc < c.end_utc && c.start_utc < a.end_utc) {
          const dates = datesTouched(a.start_utc > c.start_utc ? a.start_utc : c.start_utc, a.end_utc < c.end_utc ? a.end_utc : c.end_utc, tz);
          clashes.push({ a: ka, b: kb, type: 'overlap', dates, reason: 'Times overlap', reviewed: reviewed.has(`${ka}|${kb}`) });
        }
        continue;
      }
      // Compare calendar days. A start time without an end gets a conservative day span.
      const da = new Set(datesTouched(a.start_utc, a.end_utc, tz));
      const shared = datesTouched(c.start_utc, c.end_utc, tz).filter((d) => da.has(d));
      if (shared.length) {
        if (a.start_utc < c.end_utc && c.start_utc < a.end_utc) {
          clashes.push({ a: ka, b: kb, type: 'possible', dates: shared, reason: 'Same day — times not confirmed, so an overlap is possible', reviewed: reviewed.has(`${ka}|${kb}`) });
        }
      }
    }
  }
  return clashes;
}

export async function calendarWithClashes(ctx: AppContext, userId: string, opts: { from?: string; to?: string; includeInterested?: boolean }) {
  const p = await loadPersonalContext(ctx, userId);
  const entries = await calendarEntries(ctx, userId, opts);
  const reviews = await ctx.db.selectFrom('clash_reviews').select(['item_a', 'item_b']).where('user_id', '=', userId).execute();
  const clashes = detectClashes(entries, p.prefs.planningTimezone, new Set(reviews.map((r) => `${r.item_a}|${r.item_b}`)));
  return { entries, clashes, timezone: p.prefs.planningTimezone };
}

export async function reviewClash(ctx: AppContext, userId: string, a: string, bKey: string, decision: 'keep_both' | 'unreviewed') {
  const [ka, kb] = pairKey(a, bKey);
  await ctx.db.deleteFrom('clash_reviews').where('user_id', '=', userId).where('item_a', '=', ka).where('item_b', '=', kb).execute();
  if (decision === 'keep_both') {
    await ctx.db.insertInto('clash_reviews').values({ id: newId('clr'), user_id: userId, item_a: ka, item_b: kb, decision, reviewed_at: nowIso() }).execute();
  }
}

/** Past events you went to or booked, newest first, with booking details. */
export async function history(ctx: AppContext, userId: string) {
  const p = await loadPersonalContext(ctx, userId);
  const now = ctx.now().toISOString();
  const states = await ctx.db.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('plan_status', 'in', ['going', 'booked']).execute();
  if (!states.length) return [];
  const rows = await ctx.db.selectFrom('events').selectAll().where('id', 'in', states.map((s) => s.event_id)).where('span_end_utc', '<', now).execute();
  const events = await hydrate(ctx, rows, p, { occurrencesFrom: '0000' });
  const bookings = rows.length ? await ctx.db.selectFrom('bookings').selectAll().where('user_id', '=', userId).where('event_id', 'in', rows.map((r) => r.id)).execute() : [];
  return events
    .map((e) => ({ ...e, bookings: bookings.filter((b) => b.event_id === e.id) }))
    .sort((a, b) => b.start_utc.localeCompare(a.start_utc));
}

// ---------------------------------------------------------------- ICS

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function fold(line: string) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const icsUtc = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");

export function buildIcs(
  appName: string,
  items: { uid: string; title: string; start_local: string; end_local: string | null; start_utc: string; end_utc: string; start_time_known: boolean; end_time_known: boolean; timezone: string; location?: string | null; description?: string | null; url?: string | null; cancelled?: boolean }[],
) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${appName}//Events//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(appName)}`];
  const stamp = icsUtc(new Date().toISOString());
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:${it.uid}`, `DTSTAMP:${stamp}`);
    if (it.start_time_known) {
      lines.push(`DTSTART:${icsUtc(it.start_utc)}`);
      // Unknown end: leave DTEND out for timed events would make it zero-length; use the estimate.
      lines.push(`DTEND:${icsUtc(it.end_utc)}`);
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

export async function calendarIcs(ctx: AppContext, userId: string, includeInterested: boolean) {
  const entries = await calendarEntries(ctx, userId, { includeInterested });
  const base = ctx.config.publicUrl?.replace(/\/$/, '');
  return buildIcs(
    ctx.config.appName,
    entries
      .filter((e) => !e.needs_date)
      .map((e) => ({
        uid: `${e.key.replace(/[^a-zA-Z0-9_:-]/g, '')}@quartet`,
        title: e.status === 'interested' ? `(Interested) ${e.title}` : e.title,
        start_local: e.start_local,
        end_local: e.end_local,
        start_utc: e.start_utc,
        end_utc: e.end_utc,
        start_time_known: e.start_time_known,
        end_time_known: e.end_time_known,
        timezone: e.timezone,
        location: e.location,
        url: base && e.event_id ? `${base}/events/${e.event_id}` : null,
        cancelled: e.event_status === 'cancelled',
      })),
  );
}

export async function eventIcs(ctx: AppContext, userId: string, eventId: string) {
  const p = await loadPersonalContext(ctx, userId);
  const row = await ctx.db.selectFrom('events').selectAll().where('id', '=', eventId).executeTakeFirst();
  if (!row || (row.owner_user_id && row.owner_user_id !== userId)) throw new HttpError(404, 'Event not found');
  const [e] = await hydrate(ctx, [row], p, { occurrencesFrom: '0000' });
  let occs = await ctx.db.selectFrom('event_occurrences').selectAll().where('event_id', '=', eventId).orderBy('start_utc').execute();
  if (e.state.occurrence_id) occs = occs.filter((o) => o.id === e.state.occurrence_id);
  else if (occs.length > 1) occs = occs.filter((o) => o.span_end_utc >= ctx.now().toISOString()).slice(0, 1);
  const base = ctx.config.publicUrl?.replace(/\/$/, '');
  return buildIcs(
    ctx.config.appName,
    occs.map((o) => ({
      uid: `${o.id}@quartet`,
      title: e.title,
      start_local: o.start_local,
      end_local: o.end_local,
      start_utc: o.start_utc,
      end_utc: o.end_utc,
      start_time_known: !!o.start_time_known,
      end_time_known: !!o.end_time_known,
      timezone: e.timezone,
      location: [e.venue?.name, e.town ?? e.city, e.country].filter(Boolean).join(', '),
      description: row.description,
      url: row.ticket_url ?? (base ? `${base}/events/${e.id}` : null),
      cancelled: e.status === 'cancelled',
    })),
  );
}
