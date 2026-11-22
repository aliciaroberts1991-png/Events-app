import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { expandRecurrence, resolveRange, resolveTimes } from '../../src/shared/dates';

const tz = 'Europe/Bratislava';
const sunday = DateTime.fromISO('2026-11-22T10:00', { zone: tz });
const wednesday = DateTime.fromISO('2026-11-25T10:00', { zone: tz });

describe('date presets (planning timezone Europe/Bratislava)', () => {
  it('weekend runs Friday to Sunday and is labelled with explicit dates', () => {
    const thisW = resolveRange('this-weekend', tz, sunday);
    expect(thisW.fromDate).toBe('2026-11-20');
    expect(thisW.toDate).toBe('2026-11-22');
    expect(thisW.label).toBe('Fri 20 – Sun 22 Nov');
    const next = resolveRange('next-weekend', tz, sunday);
    expect([next.fromDate, next.toDate]).toEqual(['2026-11-27', '2026-11-29']);
    const midweek = resolveRange('this-weekend', tz, wednesday);
    expect([midweek.fromDate, midweek.toDate]).toEqual(['2026-11-27', '2026-11-29']);
  });

  it('today, this month and custom ranges', () => {
    expect(resolveRange('today', tz, sunday).label).toBe('Sun 22 Nov');
    const m = resolveRange('this-month', tz, sunday);
    expect([m.fromDate, m.toDate]).toEqual(['2026-11-01', '2026-11-30']);
    const c = resolveRange('custom', tz, sunday, { from: '2026-12-01', to: '2026-12-24' });
    expect(c.label).toBe('Tue 1 – Thu 24 Dec');
    expect(c.fromUtc).toBe('2026-11-30T23:00:00.000Z'); // local midnight CET = 23:00 UTC
  });
});

describe('event times', () => {
  it('rolls an earlier end time over to the next day (overnight)', () => {
    const r = resolveTimes('2026-11-28T22:00', '05:00', tz);
    expect(r.endLocal).toBe('2026-11-29T05:00');
    expect(r.overnight).toBe(true);
    // For date filters an overnight event belongs to its start date.
    expect(r.spanEndUtc).toBe('2026-11-28T22:59:59.999Z');
    expect(r.endUtc).toBe('2026-11-29T04:00:00.000Z');
  });

  it('handles the October daylight-saving change', () => {
    // Clocks go back at 03:00 CEST on 25 Oct 2026: 23:00 → 06:00 lasts 8 hours.
    const r = resolveTimes('2026-10-24T23:00', '06:00', tz);
    const hours = (Date.parse(r.endUtc) - Date.parse(r.startUtc)) / 3600_000;
    expect(hours).toBe(8);
    expect(r.startUtc).toBe('2026-10-24T21:00:00.000Z');
    expect(r.endUtc).toBe('2026-10-25T05:00:00.000Z');
  });

  it('handles the March daylight-saving change and other timezones', () => {
    const r = resolveTimes('2027-03-27T23:00', '06:00', 'Europe/London');
    expect((Date.parse(r.endUtc) - Date.parse(r.startUtc)) / 3600_000).toBe(6);
    expect(r.startUtc).toBe('2027-03-27T23:00:00.000Z');
  });

  it('keeps missing times as unknown rather than inventing them', () => {
    const r = resolveTimes('2026-12-05', null, tz);
    expect(r.startTimeKnown).toBe(false);
    expect(r.endTimeKnown).toBe(false);
    const late = resolveTimes('2026-12-05T23:00', null, tz);
    expect(late.endTimeKnown).toBe(false);
    expect(late.endUtc).toBe('2026-12-06T05:00:00.000Z'); // conservative estimate to 06:00
  });

  it('spans multi-day festivals across all their dates', () => {
    const r = resolveTimes('2027-07-09', '2027-07-11', tz);
    expect(r.startUtc).toBe('2027-07-08T22:00:00.000Z');
    expect(r.spanEndUtc).toBe('2027-07-11T21:59:59.999Z');
  });

  it('rejects an end before the start on a different day', () => {
    expect(() => resolveTimes('2026-12-05T20:00', '2026-12-04T20:00', tz)).toThrow();
  });
});

describe('recurrence', () => {
  it('expands weekly markets with exceptions and extra dates', () => {
    const dates = expandRecurrence({ freq: 'weekly', byweekday: ['SA'], from: '2026-11-01', until: '2026-12-31', exceptions: ['2026-12-26'], extra_dates: ['2026-12-23'] }, tz);
    expect(dates).toContain('2026-11-07');
    expect(dates).toContain('2026-12-23');
    expect(dates).not.toContain('2026-12-26');
    expect(dates.filter((d) => DateTime.fromISO(d).weekday === 6)).toHaveLength(7);
  });

  it('expands monthly "first Sunday" rules', () => {
    const dates = expandRecurrence({ freq: 'monthly', byweekday: ['SU'], setpos: 1, from: '2026-11-01', until: '2027-02-28' }, tz);
    expect(dates).toEqual(['2026-11-01', '2026-12-06', '2027-01-03', '2027-02-07']);
  });

  it('expands daily Christmas markets', () => {
    expect(expandRecurrence({ freq: 'daily', from: '2026-11-20', until: '2026-12-23' }, tz)).toHaveLength(34);
  });
});
