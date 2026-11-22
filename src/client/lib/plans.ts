// Builds this device's calendar from its local plans plus the central listings they refer to.
import { useQuery } from '@tanstack/react-query';
import { buildIcs, detectClashes, isMultiDay, type CalendarEntry } from '../../shared/calendar';
import { resolveTimes } from '../../shared/dates';
import type { LocalData } from '../../shared/local-data';
import { get, qs } from './api';
import { PLANNING_TZ } from './format';
import { useLocal } from './local';
import type { EventSummary, ListResult } from './types';

/** Central listings this device has any state for (saved, hidden, planned or booked). */
export function useSavedEvents() {
  const d = useLocal();
  const ids = Object.keys(d.states).filter((id) => !id.startsWith('loc_')).sort();
  const q = useQuery({
    queryKey: ['saved-events', ids.join(',')],
    queryFn: () => get<ListResult>(`/api/events${qs({ ids: ids.join(','), occurrences: '1' })}`),
    enabled: ids.length > 0,
    placeholderData: (p) => p,
  });
  const byId = new Map((q.data?.items ?? []).map((e) => [e.id, e]));
  return { d, ids, byId, missing: q.data?.missing ?? [], isLoading: ids.length > 0 && q.isLoading, error: q.error };
}

function locationOf(e: EventSummary) {
  return [e.venue?.name ?? e.location_text, e.town ?? e.city].filter(Boolean).join(', ') || null;
}

export function buildEntries(d: LocalData, byId: Map<string, EventSummary>, includeInterested: boolean): CalendarEntry[] {
  const want = includeInterested ? ['going', 'booked', 'interested'] : ['going', 'booked'];
  const out: CalendarEntry[] = [];
  for (const [id, st] of Object.entries(d.states)) {
    if (st.hidden || !want.includes(st.plan_status)) continue;
    if (id.startsWith('loc_')) {
      const en = d.entries.find((x) => x.id === id);
      if (!en) continue;
      try {
        const r = resolveTimes(en.start, en.end, en.timezone);
        out.push({
          key: `entry:${id}`,
          kind: 'entry',
          event_id: null,
          title: en.title,
          status: st.plan_status,
          event_status: null,
          start_local: r.startLocal,
          end_local: r.endLocal,
          timezone: en.timezone,
          start_utc: r.startUtc,
          end_utc: r.endUtc,
          start_time_known: r.startTimeKnown,
          end_time_known: r.endTimeKnown,
          multi_day: isMultiDay(r.startUtc, r.endUtc),
          location: [en.venue, en.city].filter(Boolean).join(', ') || null,
          needs_date: false,
          is_demo: false,
        });
      } catch {
        /* unreadable dates are skipped */
      }
      continue;
    }
    const e = byId.get(id);
    if (!e) continue;
    let occs = e.occurrences ?? [];
    let needsDate = false;
    if (e.recurring && occs.length > 1) {
      if (st.occurrence_id) occs = occs.filter((o) => o.id === st.occurrence_id);
      else needsDate = true;
    }
    for (const o of occs) {
      out.push({
        key: `event:${e.id}:${o.id}`,
        kind: 'event',
        event_id: e.id,
        title: e.title,
        status: st.plan_status,
        event_status: e.status,
        start_local: o.start_local,
        end_local: o.end_local,
        timezone: e.timezone,
        start_utc: o.start_utc,
        end_utc: o.end_utc,
        start_time_known: o.start_time_known,
        end_time_known: o.end_time_known,
        multi_day: isMultiDay(o.start_utc, o.end_utc),
        location: locationOf(e),
        needs_date: needsDate,
        is_demo: e.is_demo,
      });
    }
  }
  for (const p of d.plans) {
    try {
      const r = resolveTimes(p.start, p.end, p.timezone);
      out.push({
        key: `plan:${p.id}`,
        kind: 'plan',
        event_id: null,
        title: p.title,
        status: 'plan',
        event_status: null,
        start_local: r.startLocal,
        end_local: r.endLocal,
        timezone: p.timezone,
        start_utc: r.startUtc,
        end_utc: r.endUtc,
        start_time_known: r.startTimeKnown,
        end_time_known: r.endTimeKnown,
        multi_day: isMultiDay(r.startUtc, r.endUtc),
        location: p.location,
        needs_date: false,
        is_demo: false,
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

export function useCalendar(includeInterested: boolean) {
  const s = useSavedEvents();
  const all = buildEntries(s.d, s.byId, includeInterested);
  const nowIso = new Date().toISOString();
  const upcoming = all.filter((e) => e.end_utc >= nowIso);
  const past = all.filter((e) => e.end_utc < nowIso && e.kind !== 'plan' && ['going', 'booked'].includes(e.status)).reverse();
  const clashes = detectClashes(upcoming, PLANNING_TZ, new Set(s.d.clash_reviews));
  return { ...s, entries: upcoming, past, clashes };
}

export function downloadText(text: string, filename: string, type = 'text/calendar;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function entriesToIcs(appName: string, entries: CalendarEntry[]) {
  const base = window.location.origin;
  return buildIcs(
    appName,
    entries
      .filter((e) => !e.needs_date)
      .map((e) => ({
        uid: `${e.key.replace(/[^a-zA-Z0-9_:-]/g, '')}@quartet`,
        title: e.status === 'interested' ? `(Interested) ${e.title}` : e.title,
        start_local: e.start_local,
        start_utc: e.start_utc,
        end_utc: e.end_utc,
        start_time_known: e.start_time_known,
        end_time_known: e.end_time_known,
        timezone: e.timezone,
        location: e.location,
        url: e.event_id ? `${base}/events/${e.event_id}` : null,
        cancelled: e.event_status === 'cancelled',
      })),
  );
}
