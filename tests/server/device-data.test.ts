// Device-local planning: clash detection, ICS output and backup merge (pure functions
// shared with the browser).
import { describe, expect, it } from 'vitest';
import { buildIcs, detectClashes, isMultiDay, type CalendarEntry } from '../../src/shared/calendar';
import { resolveTimes } from '../../src/shared/dates';
import { demotedScore, emptyLocalData, makeExport, mergeLocalData, parseExport } from '../../src/shared/local-data';

const tz = 'Europe/Bratislava';
function entry(key: string, start: string, end: string | null, zone = tz, extra: Partial<CalendarEntry> = {}): CalendarEntry {
  const r = resolveTimes(start, end, zone);
  return {
    key,
    kind: 'event',
    event_id: key,
    title: key,
    status: 'going',
    event_status: 'scheduled',
    start_local: r.startLocal,
    end_local: r.endLocal,
    timezone: zone,
    start_utc: r.startUtc,
    end_utc: r.endUtc,
    start_time_known: r.startTimeKnown,
    end_time_known: r.endTimeKnown,
    multi_day: isMultiDay(r.startUtc, r.endUtc),
    location: null,
    needs_date: false,
    is_demo: false,
    ...extra,
  };
}

describe('clash detection', () => {
  it('finds real overlaps, possible same-day clashes, and ignores overnight tails and cancelled events', () => {
    const club = entry('club', '2026-11-28T22:00', '05:00');
    const dinner = entry('dinner', '2026-11-28T21:00', '2026-11-28T23:00', tz, { kind: 'plan', event_id: null });
    const brunch = entry('brunch', '2026-11-29T11:00', '2026-11-29T13:00', tz, { kind: 'plan', event_id: null });
    const wine = entry('wine', '2026-11-28', '2026-11-29', 'Europe/Vienna');
    const cancelled = entry('cancelled', '2026-11-28T20:00', '23:00', tz, { event_status: 'cancelled' });
    const clashes = detectClashes([club, dinner, brunch, wine, cancelled], tz, new Set());
    const pairs = clashes.map((c) => `${c.a}+${c.b}:${c.type}`);
    expect(pairs).toContain('club+dinner:overlap');
    expect(pairs).toContain('club+wine:possible');
    expect(pairs).toContain('brunch+wine:possible');
    expect(pairs.some((p) => p.startsWith('brunch+club') || p.startsWith('club+brunch'))).toBe(false);
    expect(pairs.some((p) => p.includes('cancelled'))).toBe(false);
  });

  it('compares different time zones correctly and remembers reviewed pairs', () => {
    const comedy = entry('comedy', '2026-11-27T20:00', '22:00', 'Europe/Prague');
    const london = entry('london', '2026-11-27T19:30', '2026-11-27T20:30', 'Europe/London', { kind: 'plan', event_id: null }); // 20:30–21:30 CET
    const lisbon = entry('lisbon', '2026-11-27T22:30', '2026-11-27T23:00', 'Europe/Lisbon', { kind: 'plan', event_id: null }); // 23:30 CET
    const c = detectClashes([comedy, london, lisbon], tz, new Set(['comedy|london']));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ a: 'comedy', b: 'london', type: 'overlap', reviewed: true });
  });

  it('skips recurring events that still need a chosen date', () => {
    const market = entry('market', '2026-11-28T10:00', '22:00', tz, { needs_date: true });
    expect(detectClashes([market, entry('x', '2026-11-28T12:00', '13:00')], tz, new Set())).toHaveLength(0);
  });
});

describe('ICS', () => {
  it('writes UTC times, all-day dates, escaping and folded lines', () => {
    const club = resolveTimes('2026-11-28T22:00', '05:00', tz);
    const fest = resolveTimes('2027-07-09', '2027-07-11', tz);
    const ics = buildIcs('Quartet', [
      { uid: 'a@q', title: 'Club; night, with commas', start_local: club.startLocal, start_utc: club.startUtc, end_utc: club.endUtc, start_time_known: true, end_time_known: true, timezone: tz, location: 'Dock 7, Bratislava' },
      { uid: 'b@q', title: 'Festival '.repeat(12), start_local: fest.startLocal, start_utc: fest.startUtc, end_utc: fest.endUtc, start_time_known: false, end_time_known: false, timezone: tz, cancelled: true },
    ]);
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain('DTSTART:20261128T210000Z');
    expect(ics).toContain('DTEND:20261129T040000Z');
    expect(ics).toContain('SUMMARY:Club\\; night\\, with commas');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270709');
    expect(ics).toContain('DTEND;VALUE=DATE:20270712');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});

describe('device data backup', () => {
  const t1 = '2026-11-20T10:00:00.000Z';
  const t2 = '2026-11-21T10:00:00.000Z';
  function sample(device: string) {
    const d = emptyLocalData(device);
    d.states.evt_a = { favourite: true, hidden: false, plan_status: 'going', occurrence_id: null, notes: 'Bring earplugs', updated_at: t1 };
    d.entries.push({ id: 'loc_cs', title: 'Chase & Status', start: '2026-12-12T20:00', end: null, timezone: 'Europe/Prague', venue: 'Arena', city: 'Prague', country: 'CZ', artist: 'Chase & Status', format: 'live', source_url: null, linked_event_id: null, created_at: t1, updated_at: t1 });
    d.states.loc_cs = { favourite: false, hidden: false, plan_status: 'booked', occurrence_id: null, notes: null, updated_at: t1 };
    d.bookings.push({ id: 'bkg_1', target: 'loc_cs', provider: 'Ticketmaster', amount: 1290, currency: 'CZK', reference: 'CS-1', quantity: 2, ticket_type: null, links: [], notes: null, created_at: t1, updated_at: t1 });
    d.plans.push({ id: 'pln_1', title: 'Dentist', start: '2026-12-01T09:00', end: '10:00', timezone: tz, location: null, notes: null, created_at: t1, updated_at: t1 });
    d.stays.push({ id: 'st_1', label: 'Summer', start_date: '2027-07-18', end_date: '2027-07-22' });
    return d;
  }

  it('round-trips through an export file and validates it', () => {
    const file = JSON.parse(JSON.stringify(makeExport(sample('phone'))));
    expect(parseExport(file).data.bookings[0].reference).toBe('CS-1');
    expect(() => parseExport({ format: 'something-else' })).toThrow(/not a valid/);
  });

  it('merges into another device without duplicates, keeping the stronger status and both notes', () => {
    const laptop = emptyLocalData('laptop');
    laptop.states.evt_a = { favourite: false, hidden: false, plan_status: 'booked', occurrence_id: null, notes: 'Row 3', updated_at: t2 };
    // same entry created independently on the laptop, with a different id
    laptop.entries.push({ ...sample('x').entries[0], id: 'loc_other' });
    const { data, report } = mergeLocalData(laptop, sample('phone'));
    expect(data.states.evt_a).toMatchObject({ favourite: true, plan_status: 'booked', notes: 'Row 3\n\nBring earplugs' });
    expect(report.entries).toEqual({ added: 0, duplicates: 1 });
    expect(data.bookings[0].target).toBe('loc_other'); // booking re-pointed at the existing entry
    expect(report.plans.added).toBe(1);
    const again = mergeLocalData(data, sample('phone'));
    expect(again.report.bookings).toEqual({ added: 0, duplicates: 1 });
    expect(again.report.plans).toEqual({ added: 0, duplicates: 1 });
    expect(again.report.stays).toEqual({ added: 0, duplicates: 1 });
    expect(again.report.states.updated).toBe(0);
  });

  it('applies "fewer like this" feedback to highlight scores', () => {
    const fb = [{ event_id: 'x', categories: ['wine'], genres: [], at: t1 }];
    expect(demotedScore({ score: 60, categories: ['wine'], genres: [] }, fb)).toBe(52);
    expect(demotedScore({ score: 60, categories: ['dnb'], genres: [] }, fb)).toBe(60);
  });
});
