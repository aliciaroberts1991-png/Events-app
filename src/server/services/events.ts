import type { Selectable } from 'kysely';
import { DateTime } from 'luxon';
import { resolveRange, type RangePreset } from '../../shared/dates';
import { CATEGORY_BY_SLUG, EUROPEAN_COUNTRIES, genreLineage, HUBS, IBIZA } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import type { EventsTable } from '../db/types';
import { HttpError, normalize, parseJson } from '../util';
import { distanceToHub, hubForCityName, isIbizaPlace, mapLink } from './geo';
import { loadPersonalContext, scoreEvent, type PersonalContext } from './preferences';

type EventRow = Selectable<EventsTable>;

export interface LineupEntry {
  id: string;
  artist_id: string;
  name: string;
  billing: string;
  format: string;
  date: string | null;
  set_start: string | null;
  set_end: string | null;
  stage: string | null;
  confirmed: boolean;
  followed: boolean;
  watch_status: string | null;
  description: string | null;
  description_verified: boolean;
  genres: string[];
}

export interface Occurrence {
  id: string;
  start_local: string;
  end_local: string | null;
  start_utc: string;
  end_utc: string;
  span_end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
}

export interface EventState {
  favourite: boolean;
  hidden: boolean;
  plan_status: string;
  occurrence_id: string | null;
  notes: string | null;
  version: number;
  booking_count: number;
}

export const EMPTY_STATE: EventState = {
  favourite: false,
  hidden: false,
  plan_status: 'none',
  occurrence_id: null,
  notes: null,
  version: 0,
  booking_count: 0,
};

export interface EventSummary {
  id: string;
  kind: string;
  title: string;
  status: string;
  status_note: string | null;
  origin: string;
  is_demo: boolean;
  timezone: string;
  start_local: string;
  end_local: string | null;
  start_utc: string;
  end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
  recurring: boolean;
  next_occurrence: Occurrence | null;
  occurrence_count: number;
  venue: { id: string; name: string; town: string | null; city: string | null; country: string | null } | null;
  location_text: string | null;
  town: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  hub: string | null;
  hub_distance_km: number | null;
  categories: string[];
  genres: string[];
  artists: LineupEntry[];
  festival: { series_id: string; name: string; edition: string | null } | null;
  residency_id: string | null;
  occasion: string | null;
  languages: string[] | null;
  language_importance: string | null;
  participation: string | null;
  performance_format: string | null;
  ticket_status: string;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  presale_at: string | null;
  onsale_at: string | null;
  sale_timezone: string | null;
  prominence: number;
  research_highlight: boolean;
  highlight: boolean;
  score: number;
  reasons: string[];
  why_suits_me: string | null;
  verification_state: string;
  last_verified_at: string | null;
  needs_review: boolean;
  camping: { available: boolean | null; note?: string; url?: string } | null;
  created_at: string;
  first_seen_at: string;
  archived: boolean;
  state: EventState;
}

const chunk = <T,>(arr: T[], n = 400): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Batch-load everything a card needs, for the given events. */
export async function hydrate(ctx: AppContext, rows: EventRow[], p: PersonalContext | null, opts: { occurrencesFrom?: string } = {}): Promise<EventSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const db = ctx.db;
  const venueIds = [...new Set(rows.map((r) => r.venue_id).filter(Boolean) as string[])];
  const seriesIds = [...new Set(rows.map((r) => r.festival_series_id).filter(Boolean) as string[])];

  const [cats, genres, lineup, venues, series, occs, states, bookingCounts] = await Promise.all([
    Promise.all(chunk(ids).map((c) => db.selectFrom('event_categories').selectAll().where('event_id', 'in', c).execute())).then((x) => x.flat()),
    Promise.all(chunk(ids).map((c) => db.selectFrom('event_genres').selectAll().where('event_id', 'in', c).execute())).then((x) => x.flat()),
    Promise.all(
      chunk(ids).map((c) =>
        db
          .selectFrom('event_artists as ea')
          .innerJoin('artists as a', 'a.id', 'ea.artist_id')
          .select([
            'ea.id', 'ea.event_id', 'ea.artist_id', 'ea.billing', 'ea.performance_format', 'ea.appearance_date', 'ea.set_start_local',
            'ea.set_end_local', 'ea.stage', 'ea.confirmed', 'ea.sort_order', 'a.name', 'a.description', 'a.description_verified', 'a.genres',
          ])
          .where('ea.event_id', 'in', c)
          .execute(),
      ),
    ).then((x) => x.flat()),
    venueIds.length ? db.selectFrom('venues').select(['id', 'name', 'town', 'city', 'country']).where('id', 'in', venueIds).execute() : [],
    seriesIds.length ? db.selectFrom('festival_series').select(['id', 'name']).where('id', 'in', seriesIds).execute() : [],
    Promise.all(chunk(ids).map((c) => db.selectFrom('event_occurrences').selectAll().where('event_id', 'in', c).orderBy('start_utc').execute())).then((x) => x.flat()),
    p
      ? Promise.all(chunk(ids).map((c) => db.selectFrom('user_event_state').selectAll().where('user_id', '=', p.userId).where('event_id', 'in', c).execute())).then((x) => x.flat())
      : [],
    p
      ? Promise.all(
          chunk(ids).map((c) =>
            db
              .selectFrom('bookings')
              .select(['event_id', db.fn.countAll<number>().as('n')])
              .where('user_id', '=', p.userId)
              .where('event_id', 'in', c)
              .groupBy('event_id')
              .execute(),
          ),
        ).then((x) => x.flat())
      : [],
  ]);

  const by = <T extends { event_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) {
      const arr = m.get(x.event_id);
      if (arr) arr.push(x);
      else m.set(x.event_id, [x]);
    }
    return m;
  };
  const catMap = by(cats);
  const genreMap = by(genres);
  const lineupMap = by(lineup);
  const occMap = by(occs);
  const stateMap = new Map(states.map((s) => [s.event_id, s]));
  const bookingMap = new Map(bookingCounts.map((b) => [b.event_id, Number(b.n)]));
  const venueMap = new Map(venues.map((v) => [v.id, v]));
  const seriesMap = new Map(series.map((s) => [s.id, s]));
  const cutoff = opts.occurrencesFrom ?? ctx.now().toISOString();

  return rows.map((r) => {
    const st = stateMap.get(r.id);
    const occList: Occurrence[] = (occMap.get(r.id) ?? []).map((o) => ({
      id: o.id,
      start_local: o.start_local,
      end_local: o.end_local,
      start_utc: o.start_utc,
      end_utc: o.end_utc,
      span_end_utc: o.span_end_utc,
      start_time_known: !!o.start_time_known,
      end_time_known: !!o.end_time_known,
    }));
    const next = occList.find((o) => o.span_end_utc >= cutoff) ?? null;
    const artists: LineupEntry[] = (lineupMap.get(r.id) ?? [])
      .sort((a, b) => billingRank(a.billing) - billingRank(b.billing) || a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((a) => ({
        id: a.id,
        artist_id: a.artist_id,
        name: a.name,
        billing: a.billing,
        format: a.performance_format,
        date: a.appearance_date,
        set_start: a.set_start_local,
        set_end: a.set_end_local,
        stage: a.stage,
        confirmed: !!a.confirmed,
        followed: p?.watch.get(a.artist_id) === 'active',
        watch_status: p?.watch.get(a.artist_id) ?? null,
        description: a.description,
        description_verified: !!a.description_verified,
        genres: parseJson<string[]>(a.genres, []),
      }));
    const v = r.venue_id ? venueMap.get(r.venue_id) : null;
    const s = r.festival_series_id ? seriesMap.get(r.festival_series_id) : null;
    const summary: EventSummary = {
      id: r.id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      status_note: r.status_note,
      origin: r.origin,
      is_demo: !!r.is_demo,
      timezone: r.timezone,
      start_local: r.start_local,
      end_local: r.end_local,
      start_utc: r.start_utc,
      end_utc: r.end_utc,
      start_time_known: !!r.start_time_known,
      end_time_known: !!r.end_time_known,
      recurring: !!r.recurrence,
      next_occurrence: next,
      occurrence_count: occList.length,
      venue: v ? { id: v.id, name: v.name, town: v.town, city: v.city, country: v.country } : null,
      location_text: r.location_text,
      town: r.town,
      city: r.city,
      country: r.country,
      lat: r.lat,
      lng: r.lng,
      hub: r.hub,
      hub_distance_km: r.hub_distance_km,
      categories: (catMap.get(r.id) ?? []).map((c) => c.category).sort(),
      genres: (genreMap.get(r.id) ?? []).map((g) => g.genre).sort(),
      artists,
      festival: s ? { series_id: s.id, name: s.name, edition: r.edition } : null,
      residency_id: r.residency_id,
      occasion: r.occasion,
      languages: parseJson<string[] | null>(r.languages, null),
      language_importance: r.language_importance,
      participation: r.participation,
      performance_format: r.performance_format,
      ticket_status: r.ticket_status,
      price_min: r.price_min,
      price_max: r.price_max,
      currency: r.currency,
      presale_at: r.presale_at,
      onsale_at: r.onsale_at,
      sale_timezone: r.sale_timezone,
      prominence: r.prominence,
      research_highlight: !!r.highlight,
      highlight: false,
      score: 0,
      reasons: [],
      why_suits_me: r.why_suits_me,
      verification_state: r.verification_state,
      last_verified_at: r.last_verified_at,
      needs_review: !!r.needs_review,
      camping: parseJson(r.camping, null),
      created_at: r.created_at,
      first_seen_at: r.first_seen_at,
      archived: !!r.archived_at,
      state: st
        ? {
            favourite: !!st.favourite,
            hidden: !!st.hidden,
            plan_status: st.plan_status,
            occurrence_id: st.occurrence_id,
            notes: st.notes,
            version: st.version,
            booking_count: bookingMap.get(r.id) ?? 0,
          }
        : { ...EMPTY_STATE, booking_count: bookingMap.get(r.id) ?? 0 },
    };
    if (p) {
      const sc = scoreEvent(
        {
          status: r.status,
          prominence: r.prominence,
          highlight: !!r.highlight,
          categories: summary.categories,
          genres: summary.genres,
          artists,
          languages: summary.languages,
          language_importance: r.language_importance,
          kind: r.kind,
        },
        p,
      );
      summary.highlight = sc.highlight;
      summary.score = sc.score;
      summary.reasons = sc.reasons;
    }
    return summary;
  });
}

function billingRank(b: string) {
  return ({ headliner: 0, special_guest: 1, resident: 2, host: 2, support: 3 } as Record<string, number>)[b] ?? 4;
}

export interface ListFilters {
  mode?: 'highlights' | 'all';
  /** 'local' = the four cities, 'europe', 'ibiza' or 'any'. */
  scope?: 'local' | 'europe' | 'ibiza' | 'any';
  hubs?: string[];
  nearby?: boolean;
  radiusKm?: number;
  range?: RangePreset;
  from?: string | null;
  to?: string | null;
  categories?: string[];
  genres?: string[];
  q?: string;
  kind?: string;
  followed?: boolean;
  artistId?: string;
  englishFriendly?: boolean;
  countries?: string[];
  festivalScope?: 'nearby' | 'europe';
  festivalSeriesId?: string;
  residencyId?: string;
  saved?: 'any' | 'favourites' | 'planned' | 'hidden';
  includeHidden?: boolean;
  includePast?: boolean;
  sort?: 'date' | 'relevance' | 'recent';
  limit?: number;
  offset?: number;
}

export interface ListResult {
  items: EventSummary[];
  total: number;
  range: ReturnType<typeof resolveRange>;
  counts: { highlights: number; all: number };
}

export function matchesLocation(e: EventSummary, f: ListFilters, p: PersonalContext): boolean {
  const scope = f.scope ?? 'local';
  if (scope === 'any') return true;
  if (scope === 'europe') return !e.country || EUROPEAN_COUNTRIES.has(e.country);
  if (scope === 'ibiza') {
    if (e.hub === 'ibiza') return true;
    if (isIbizaPlace(e.town, e.city, null)) return true;
    const d = distanceToHub('ibiza', e.lat, e.lng);
    return d !== null && d <= IBIZA.radiusKm;
  }
  const hubs = f.hubs?.length ? f.hubs : p.prefs.defaultHubs;
  const nearby = f.nearby ?? p.prefs.includeNearby;
  const radius = f.radiusKm ?? p.prefs.nearbyRadiusKm;
  for (const h of hubs) {
    const cityHub = hubForCityName(e.city) ?? hubForCityName(e.town);
    if (cityHub === h) return true;
    if (nearby) {
      const d = distanceToHub(h, e.lat, e.lng);
      if (d !== null ? d <= radius : e.hub === h) return true;
    }
  }
  return false;
}

function matchesCategories(e: EventSummary, wanted: string[]): boolean {
  if (!wanted.length) return true;
  const set = new Set<string>();
  for (const c of e.categories) {
    set.add(c);
    const parent = CATEGORY_BY_SLUG.get(c)?.parent;
    if (parent) set.add(parent);
  }
  // Festival editions always count as music festivals.
  if (e.kind === 'festival') {
    set.add('music-festival');
    set.add('music');
  }
  return wanted.some((w) => set.has(w));
}

function matchesGenres(e: EventSummary, wanted: string[]): boolean {
  if (!wanted.length) return true;
  const set = new Set<string>();
  for (const g of e.genres) for (const x of genreLineage(g)) set.add(x);
  // Artist genres count too (a festival featuring liquid DnB acts matches "dnb").
  for (const a of e.artists) for (const g of a.genres) for (const x of genreLineage(g)) set.add(x);
  // Category slugs that double as genres (dnb, techno, house, trance).
  for (const c of e.categories) set.add(c);
  return wanted.some((w) => set.has(w));
}

export function matchesText(e: EventSummary, q: string): boolean {
  const n = normalize(q);
  if (!n) return true;
  const hay = normalize(
    [e.title, e.venue?.name, e.town, e.city, e.location_text, e.festival?.name, ...e.artists.map((a) => a.name)].filter(Boolean).join(' '),
  );
  return n.split(' ').every((t) => hay.includes(t));
}

export function isEnglishFriendly(e: EventSummary): boolean {
  if (e.language_importance === 'none') return true;
  const l = e.languages ?? [];
  if (l.includes('en') || l.includes('none')) return true;
  // Music events without language information are treated as language-neutral.
  return !l.length && e.categories.some((c) => CATEGORY_BY_SLUG.get(c)?.parent === 'music' || c === 'music');
}

/** List events with combined filters. */
export async function listEvents(ctx: AppContext, userId: string, f: ListFilters): Promise<ListResult> {
  const p = await loadPersonalContext(ctx, userId);
  const now = DateTime.fromJSDate(ctx.now());
  const range = resolveRange(f.range ?? 'upcoming', p.prefs.planningTimezone, now, { from: f.from, to: f.to });
  const nowIso = ctx.now().toISOString();
  const lower = f.includePast ? range.fromUtc : range.fromUtc > nowIso ? range.fromUtc : nowIso;

  let q = ctx.db
    .selectFrom('event_occurrences as o')
    .innerJoin('events as e', 'e.id', 'o.event_id')
    .select(['o.event_id', 'o.start_utc', 'o.span_end_utc'])
    .where('o.span_end_utc', '>=', lower)
    .where((w) => w.or([w('e.owner_user_id', 'is', null), w('e.owner_user_id', '=', userId)]));
  if (range.toUtc) q = q.where('o.start_utc', '<=', range.toUtc);
  if (!f.includePast) q = q.where('e.archived_at', 'is', null);
  if (f.kind) q = q.where('e.kind', '=', f.kind);
  if (f.festivalSeriesId) q = q.where('e.festival_series_id', '=', f.festivalSeriesId);
  if (f.residencyId) q = q.where('e.residency_id', '=', f.residencyId);
  if (f.artistId) q = q.where('e.id', 'in', ctx.db.selectFrom('event_artists').select('event_id').where('artist_id', '=', f.artistId));
  const occRows = await q.orderBy('o.start_utc').execute();

  // First matching occurrence per event within the range.
  const firstOcc = new Map<string, { start_utc: string; span_end_utc: string }>();
  for (const o of occRows) if (!firstOcc.has(o.event_id)) firstOcc.set(o.event_id, o);
  const ids = [...firstOcc.keys()];
  const rows: EventRow[] = [];
  for (const c of chunk(ids)) rows.push(...(await ctx.db.selectFrom('events').selectAll().where('id', 'in', c).execute()));
  let items = await hydrate(ctx, rows, p, { occurrencesFrom: lower });

  items = items.filter((e) => {
    if (!matchesLocation(e, f, p)) return false;
    if (f.countries?.length && !(e.country && f.countries.includes(e.country))) return false;
    if (!matchesCategories(e, f.categories ?? [])) return false;
    if (!matchesGenres(e, f.genres ?? [])) return false;
    if (f.q && !matchesText(e, f.q)) return false;
    if (f.followed && !e.artists.some((a) => a.followed)) return false;
    if (f.englishFriendly && !isEnglishFriendly(e)) return false;
    if (f.festivalScope === 'nearby') {
      const near = HUBS.some((h) => {
        const d = distanceToHub(h.slug, e.lat, e.lng);
        return d !== null ? d <= p.prefs.festivalNearbyRadiusKm : hubForCityName(e.city) === h.slug || e.hub === h.slug;
      });
      if (!near) return false;
    }
    if (f.saved === 'favourites' && !e.state.favourite) return false;
    if (f.saved === 'planned' && e.state.plan_status === 'none') return false;
    if (f.saved === 'hidden') return e.state.hidden;
    if (e.state.hidden && !f.includeHidden) return false;
    return true;
  });

  // Next matching occurrence inside the range becomes the display occurrence.
  for (const e of items) {
    const o = firstOcc.get(e.id);
    if (o && e.next_occurrence && e.next_occurrence.start_utc < o.start_utc && e.next_occurrence.span_end_utc < lower) e.next_occurrence = null;
  }

  const highlightsCount = items.filter((e) => e.highlight).length;
  const allCount = items.length;
  if (f.mode === 'highlights') items = items.filter((e) => e.highlight);

  const sort = f.sort ?? 'date';
  const dateKey = (e: EventSummary) => firstOcc.get(e.id)?.start_utc ?? e.start_utc;
  items.sort((a, b) => {
    if (sort === 'relevance') return b.score - a.score || dateKey(a).localeCompare(dateKey(b));
    if (sort === 'recent') return b.first_seen_at.localeCompare(a.first_seen_at) || dateKey(a).localeCompare(dateKey(b));
    return dateKey(a).localeCompare(dateKey(b)) || b.score - a.score;
  });

  const total = items.length;
  const offset = f.offset ?? 0;
  const limit = Math.min(f.limit ?? 60, 500);
  return { items: items.slice(offset, offset + limit), total, range, counts: { highlights: highlightsCount, all: allCount } };
}

export async function getEventRow(ctx: AppContext, id: string, userId?: string): Promise<EventRow> {
  const row = await ctx.db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row || (row.owner_user_id && userId && row.owner_user_id !== userId)) throw new HttpError(404, 'Event not found');
  return row;
}

/** Everything for the detail page. */
export async function getEventDetail(ctx: AppContext, userId: string, id: string) {
  const row = await getEventRow(ctx, id, userId);
  const p = await loadPersonalContext(ctx, userId);
  const [summary] = await hydrate(ctx, [row], p, { occurrencesFrom: '0000' });
  const [venue, sources, changes, bookings, occurrences, residency, keys] = await Promise.all([
    row.venue_id ? ctx.db.selectFrom('venues').selectAll().where('id', '=', row.venue_id).executeTakeFirst() : null,
    ctx.db.selectFrom('event_sources').selectAll().where('event_id', '=', id).orderBy('created_at').execute(),
    ctx.db.selectFrom('event_changes').selectAll().where('event_id', '=', id).orderBy('created_at', 'desc').limit(30).execute(),
    ctx.db.selectFrom('bookings').selectAll().where('event_id', '=', id).where('user_id', '=', userId).orderBy('created_at').execute(),
    ctx.db.selectFrom('event_occurrences').selectAll().where('event_id', '=', id).orderBy('start_utc').execute(),
    row.residency_id ? ctx.db.selectFrom('residencies').select(['id', 'title', 'brand', 'season', 'status', 'weekday', 'start_date', 'end_date']).where('id', '=', row.residency_id).executeTakeFirst() : null,
    ctx.db.selectFrom('event_keys').select('key').where('event_id', '=', id).execute(),
  ]);
  const nowIso = ctx.now().toISOString();
  let possibleMatches: { id: string; title: string; start_local: string; city: string | null }[] = [];
  if (row.origin === 'manual') {
    const day = row.start_local.slice(0, 10);
    const cands = await ctx.db
      .selectFrom('events')
      .select(['id', 'title', 'start_local', 'city', 'normalized_title'])
      .where('origin', '!=', 'manual')
      .where('start_local', '>=', day)
      .where('start_local', '<=', `${day}T99`)
      .execute();
    const words = new Set(row.normalized_title.split(' ').filter((w) => w.length > 2));
    possibleMatches = cands
      .filter((c) => {
        const cw = c.normalized_title.split(' ').filter((w) => w.length > 2);
        return cw.some((w) => words.has(w)) || (row.city && c.city && normalize(row.city) === normalize(c.city));
      })
      .map(({ id: cid, title, start_local, city }) => ({ id: cid, title, start_local, city }));
  }
  return {
    ...summary,
    description: row.description,
    expectation: row.expectation,
    why_suits_me_updated_at: row.why_suits_me_updated_at,
    doors_local: row.doors_local,
    age_restriction: row.age_restriction,
    ticket_url: row.ticket_url,
    price_note: row.price_note,
    booking_fee_note: row.booking_fee_note,
    ticket_status_checked_at: row.ticket_status_checked_at,
    sale_note: row.sale_note,
    ticket_tiers: parseJson(row.ticket_tiers, []),
    accommodation: parseJson(row.accommodation, null),
    announced_at: row.announced_at,
    review_reason: row.review_reason,
    unverified_fields: parseJson<string[]>(row.unverified_fields, []),
    tba_fields: parseJson<string[]>(row.tba_fields, []),
    conflicts: parseJson(row.conflicts, []),
    previous_schedule: parseJson(row.previous_schedule, []),
    travel: parseJson(row.travel, null),
    recurrence: parseJson(row.recurrence, null),
    last_changed_at: row.last_changed_at,
    updated_at: row.updated_at,
    version: row.version,
    source_keys: keys.map((k) => k.key),
    venue_detail: venue
      ? { ...venue, map_url: mapLink({ lat: venue.lat, lng: venue.lng, name: venue.name, address: venue.address, city: venue.city }) }
      : null,
    map_url: venue
      ? mapLink({ lat: venue.lat ?? row.lat, lng: venue.lng ?? row.lng, name: venue.name, address: venue.address, city: venue.city })
      : mapLink({ lat: row.lat, lng: row.lng, name: row.location_text, city: row.city }),
    sources: sources.map((s) => ({ ...s, claims: parseJson<string[]>(s.claims, []) })),
    changes: changes.map((c) => ({ ...c, old_value: parseJson(c.old_value, c.old_value), new_value: parseJson(c.new_value, c.new_value) })),
    bookings: bookings.map((b) => ({ ...b, links: parseJson<string[]>(b.links, []) })),
    occurrences: occurrences.map((o) => ({
      id: o.id,
      start_local: o.start_local,
      end_local: o.end_local,
      start_utc: o.start_utc,
      end_utc: o.end_utc,
      start_time_known: !!o.start_time_known,
      end_time_known: !!o.end_time_known,
      past: o.span_end_utc < nowIso,
    })),
    residency: residency ?? null,
    possible_matches: possibleMatches,
  };
}
