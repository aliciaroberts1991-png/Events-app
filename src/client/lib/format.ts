import { DateTime } from 'luxon';
import {
  CATEGORY_BY_SLUG,
  COUNTRY_NAMES,
  FORMAT_LABELS,
  GENRE_BY_SLUG,
  LANGUAGE_NAMES,
  TICKET_STATUS_LABELS,
  categoryGroup,
  type PerformanceFormat,
  type TicketStatus,
} from '../../shared/taxonomy';
import type { EventSummary, Occurrence } from './types';

export const PLANNING_TZ = 'Europe/Bratislava';
const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function dt(local: string, tz: string) {
  return DateTime.fromISO(local, { zone: tz }).setLocale('en-GB');
}

export function dayLabel(local: string) {
  const d = DateTime.fromISO(local.slice(0, 10)).setLocale('en-GB');
  return d.toFormat(d.year === DateTime.now().year ? 'ccc d LLL' : 'ccc d LLL yyyy');
}

export function fullDay(local: string) {
  return DateTime.fromISO(local.slice(0, 10)).setLocale('en-GB').toFormat('cccc d LLLL yyyy');
}

export function zoneAbbr(local: string, tz: string) {
  return dt(isDateOnly(local) ? `${local}T12:00` : local, tz).toFormat('ZZZZ');
}

/** "Sat 28 Nov, 22:00 – 05:00 (next day)", "Fri 9 – Sun 11 Jul 2027", "Sat 5 Dec (time to be announced)". */
export function whenText(o: { start_local: string; end_local: string | null; start_time_known: boolean; end_time_known: boolean }, tz: string, opts: { year?: boolean } = {}) {
  const s = dt(o.start_local, tz);
  const now = DateTime.now();
  const showYear = opts.year || s.year !== now.year;
  const dayFmt = showYear ? 'ccc d LLL yyyy' : 'ccc d LLL';
  const startDay = s.toFormat(dayFmt);
  const e = o.end_local ? dt(o.end_local, tz) : null;
  const multiDay = e && e.startOf('day').diff(s.startOf('day'), 'days').days >= 1;
  const overnight = multiDay && e && o.end_time_known && e.diff(s, 'hours').hours <= 16;
  if (multiDay && !overnight && e) {
    const sameMonth = s.hasSame(e, 'month');
    const left = sameMonth ? s.toFormat('ccc d') : s.toFormat(showYear && !s.hasSame(e, 'year') ? dayFmt : 'ccc d LLL');
    return `${left} – ${e.toFormat(dayFmt)}${o.start_time_known ? `, from ${s.toFormat('HH:mm')}` : ''}`;
  }
  if (!o.start_time_known) return `${startDay} · time to be announced`;
  const end = e && o.end_time_known ? ` – ${e.toFormat('HH:mm')}${overnight ? ' (next day)' : ''}` : '';
  return `${startDay}, ${s.toFormat('HH:mm')}${end}`;
}

/** Event-local time plus the zone; adds the planning-zone time when the zone differs. */
export function whenWithZone(o: { start_local: string; end_local: string | null; start_time_known: boolean; end_time_known: boolean; start_utc?: string }, tz: string) {
  const base = whenText(o, tz);
  const abbr = zoneAbbr(o.start_local, tz);
  if (!o.start_time_known) return { text: base, zone: tz === PLANNING_TZ ? null : abbr, home: null as string | null };
  const sameOffset = dt(o.start_local, tz).offset === dt(o.start_local, tz).setZone(PLANNING_TZ).offset;
  const home = sameOffset ? null : dt(o.start_local, tz).setZone(PLANNING_TZ).toFormat('HH:mm');
  return { text: base, zone: abbr, home };
}

export function displayOccurrence(e: EventSummary): Occurrence {
  return e.next_occurrence ?? { id: e.id, start_local: e.start_local, end_local: e.end_local, start_utc: e.start_utc, end_utc: e.end_utc, start_time_known: e.start_time_known, end_time_known: e.end_time_known };
}

export function relative(iso: string | null | undefined) {
  if (!iso) return 'never';
  return DateTime.fromISO(iso).setLocale('en-GB').toRelative() ?? iso;
}

export function stamp(iso: string | null | undefined) {
  if (!iso) return '—';
  return DateTime.fromISO(iso).setZone(PLANNING_TZ).setLocale('en-GB').toFormat('d LLL yyyy, HH:mm');
}

export function money(amount: number | null | undefined, currency: string | null | undefined) {
  if (amount === null || amount === undefined) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

export function priceText(e: { price_min: number | null; price_max: number | null; currency: string | null; ticket_status: string }) {
  if (e.ticket_status === 'free') return 'Free';
  const a = money(e.price_min, e.currency);
  const b = money(e.price_max, e.currency);
  if (a && b && a !== b) return `${a} – ${b}`;
  return a ?? b ?? null;
}

export const catLabel = (s: string) => CATEGORY_BY_SLUG.get(s)?.label ?? GENRE_BY_SLUG.get(s)?.label ?? s;
export const genreLabel = (s: string) => GENRE_BY_SLUG.get(s)?.label ?? s.replace(/-/g, ' ');
export const formatLabel = (f: string) => FORMAT_LABELS[f as PerformanceFormat] ?? f;
export const ticketLabel = (s: string) => TICKET_STATUS_LABELS[s as TicketStatus] ?? s;
export const countryName = (c: string | null | undefined) => (c ? COUNTRY_NAMES[c] ?? c : '');
export const languageName = (l: string) => LANGUAGE_NAMES[l] ?? l.toUpperCase();

export function groupOf(e: { categories: string[]; kind: string }) {
  if (e.kind === 'festival') return 'music';
  for (const c of e.categories) {
    const g = categoryGroup(c);
    if (g) return g;
  }
  return 'other';
}

export function placeText(e: EventSummary) {
  const venue = e.venue?.name ?? e.location_text;
  const town = e.town ?? e.city;
  return [venue, town && town !== venue ? town : null].filter(Boolean).join(' · ');
}

export function nearText(e: EventSummary, hubNames: Record<string, string>) {
  if (!e.hub || !e.hub_distance_km || e.hub_distance_km < 8 || e.hub === 'ibiza') return null;
  const hubName = hubNames[e.hub];
  if (!hubName || (e.city ?? '').toLowerCase() === hubName.toLowerCase()) return null;
  return `${Math.round(e.hub_distance_km)} km from ${hubName}`;
}

export function saleText(e: { presale_at: string | null; onsale_at: string | null; sale_timezone: string | null; timezone: string }) {
  const tz = e.sale_timezone ?? e.timezone;
  const now = DateTime.now();
  const parts: string[] = [];
  if (e.presale_at && dt(e.presale_at, tz) > now) parts.push(`Presale ${dt(e.presale_at, tz).toFormat('ccc d LLL, HH:mm')}`);
  if (e.onsale_at && dt(e.onsale_at, tz) > now) parts.push(`On sale ${dt(e.onsale_at, tz).toFormat('ccc d LLL, HH:mm')}`);
  return parts.length ? `${parts.join(' · ')} ${zoneAbbr(e.presale_at ?? e.onsale_at!, tz)}` : null;
}
