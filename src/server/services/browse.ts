// Artists, festivals, Ibiza, cities and search.
import { DateTime } from 'luxon';
import { HUBS } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import { HttpError, normalize, parseJson } from '../util';
import { hydrate, listEvents, matchesLocation, type ListFilters } from './events';
import { getSetting } from './import';
import { loadPersonalContext } from './preferences';
import { listWatchlist } from './personal';

export async function artistsOverview(ctx: AppContext, userId: string) {
  const watch = await listWatchlist(ctx, userId);
  const p = await loadPersonalContext(ctx, userId);
  const nowIso = ctx.now().toISOString();
  const ids = watch.map((w) => w.artist_id);
  const appearances = ids.length
    ? await ctx.db
        .selectFrom('event_artists as ea')
        .innerJoin('events as e', 'e.id', 'ea.event_id')
        .select(['ea.artist_id', 'e.id as event_id'])
        .where('ea.artist_id', 'in', ids)
        .where('e.span_end_utc', '>=', nowIso)
        .where((w) => w.or([w('e.owner_user_id', 'is', null), w('e.owner_user_id', '=', userId)]))
        .execute()
    : [];
  const eventIds = [...new Set(appearances.map((a) => a.event_id))];
  const rows = eventIds.length ? await ctx.db.selectFrom('events').selectAll().where('id', 'in', eventIds).execute() : [];
  const events = new Map((await hydrate(ctx, rows, p)).map((e) => [e.id, e]));
  const residencies = ids.length
    ? await ctx.db
        .selectFrom('residency_artists as ra')
        .innerJoin('residencies as r', 'r.id', 'ra.residency_id')
        .innerJoin('venues as v', 'v.id', 'r.venue_id')
        .select(['ra.artist_id', 'r.id', 'r.title', 'r.season', 'r.weekday', 'r.start_date', 'r.end_date', 'r.status', 'v.name as venue_name'])
        .where('ra.artist_id', 'in', ids)
        .where('r.season', '>=', DateTime.fromJSDate(ctx.now()).year)
        .execute()
    : [];
  return watch.map((w) => {
    const evs = appearances
      .filter((a) => a.artist_id === w.artist_id)
      .map((a) => events.get(a.event_id)!)
      .filter((e) => e && !e.state.hidden)
      .sort((a, b) => (a.next_occurrence?.start_utc ?? a.start_utc).localeCompare(b.next_occurrence?.start_utc ?? b.start_utc));
    return { ...w, appearances: evs, residencies: residencies.filter((r) => r.artist_id === w.artist_id) };
  });
}

export async function artistDetail(ctx: AppContext, userId: string, id: string) {
  const a = await ctx.db.selectFrom('artists').selectAll().where('id', '=', id).executeTakeFirst();
  if (!a) throw new HttpError(404, 'Artist not found');
  const [keys, watch, upcoming, residencies] = await Promise.all([
    ctx.db.selectFrom('artist_keys').select('key').where('artist_id', '=', id).execute(),
    ctx.db.selectFrom('watchlist').selectAll().where('artist_id', '=', id).where('user_id', '=', userId).executeTakeFirst(),
    listEvents(ctx, userId, { scope: 'any', artistId: id, mode: 'all', limit: 200, includeHidden: true }),
    ctx.db
      .selectFrom('residency_artists as ra')
      .innerJoin('residencies as r', 'r.id', 'ra.residency_id')
      .innerJoin('venues as v', 'v.id', 'r.venue_id')
      .select(['r.id', 'r.title', 'r.brand', 'r.season', 'r.weekday', 'r.start_date', 'r.end_date', 'r.status', 'v.name as venue_name'])
      .where('ra.artist_id', '=', id)
      .orderBy('r.season', 'desc')
      .execute(),
  ]);
  return {
    id: a.id,
    name: a.name,
    aliases: parseJson<string[]>(a.aliases, []),
    description: a.description,
    description_verified: !!a.description_verified,
    description_source: a.description_source,
    genres: parseJson<string[]>(a.genres, []),
    links: parseJson<Record<string, string>>(a.links, {}),
    country: a.country,
    origin: a.origin,
    keys: keys.map((k) => k.key),
    watch: watch ?? null,
    appearances: upcoming.items,
    residencies,
  };
}

export async function festivals(ctx: AppContext, userId: string, f: ListFilters & { festivalScope: 'nearby' | 'europe' }) {
  const res = await listEvents(ctx, userId, { ...f, scope: 'europe', kind: 'festival', limit: 300 });
  return res;
}

export async function ibiza(ctx: AppContext, userId: string, season: number, stay?: { from: string; to: string } | null) {
  const p = await loadPersonalContext(ctx, userId);
  const residencies = await ctx.db
    .selectFrom('residencies as r')
    .innerJoin('venues as v', 'v.id', 'r.venue_id')
    .select([
      'r.id', 'r.title', 'r.brand', 'r.season', 'r.weekday', 'r.start_date', 'r.end_date', 'r.status', 'r.announced_at', 'r.announcement_url',
      'r.description', 'r.ticket_url', 'r.sources', 'r.last_verified_at', 'r.is_demo', 'v.id as venue_id', 'v.name as venue_name', 'v.town as venue_town',
    ])
    .where('r.season', '=', season)
    .orderBy('v.name')
    .execute();
  const residents = residencies.length
    ? await ctx.db
        .selectFrom('residency_artists as ra')
        .innerJoin('artists as a', 'a.id', 'ra.artist_id')
        .select(['ra.residency_id', 'a.id', 'a.name'])
        .where('ra.residency_id', 'in', residencies.map((r) => r.id))
        .execute()
    : [];
  const from = `${season}-01-01`;
  const to = `${season}-12-31`;
  const parties = await listEvents(ctx, userId, { scope: 'ibiza', range: 'custom', from, to, mode: 'all', limit: 500, includePast: true, includeHidden: false });
  const stayParties = stay
    ? (await listEvents(ctx, userId, { scope: 'ibiza', range: 'custom', from: stay.from, to: stay.to, mode: 'all', limit: 500, includePast: true })).items
    : null;
  const resList = residencies.map((r) => ({
    ...r,
    is_demo: !!r.is_demo,
    sources: parseJson(r.sources, []),
    residents: residents.filter((x) => x.residency_id === r.id).map((x) => ({ id: x.id, name: x.name, followed: p.watch.get(x.id) === 'active' })),
    party_count: parties.items.filter((e) => e.residency_id === r.id).length,
    overlaps_stay: stay ? !!(r.start_date && r.end_date && r.start_date <= stay.to && r.end_date >= stay.from) : null,
  }));
  const venues = [...new Map(resList.map((r) => [r.venue_id, { id: r.venue_id, name: r.venue_name, town: r.venue_town }])).values()];
  return {
    season,
    residencies: resList,
    venues,
    parties: parties.items,
    openings: parties.items.filter((e) => e.occasion === 'opening' || e.occasion === 'closing'),
    stay: stay ?? null,
    stay_parties: stayParties,
  };
}

export async function citiesSummary(ctx: AppContext, userId: string) {
  const [coverage, all] = await Promise.all([
    ctx.db.selectFrom('coverage').selectAll().execute(),
    listEvents(ctx, userId, { scope: 'local', hubs: HUBS.map((h) => h.slug), mode: 'all', limit: 5000 }),
  ]);
  const p = await loadPersonalContext(ctx, userId);
  const now = DateTime.fromJSDate(ctx.now()).setZone(p.prefs.planningTimezone);
  const weekEnd = now.plus({ days: 7 }).toUTC().toISO()!;
  return HUBS.map((h) => {
    const items = all.items.filter((e) => matchesLocation(e, { scope: 'local', hubs: [h.slug] }, p));
    const c = coverage.find((x) => x.area === h.slug);
    return {
      slug: h.slug,
      name: h.name,
      country: h.country,
      upcoming: items.length,
      highlights: items.filter((e) => e.highlight).length,
      this_week: items.filter((e) => (e.next_occurrence?.start_utc ?? e.start_utc) <= weekEnd).length,
      top: items.filter((e) => e.highlight).sort((a, b) => b.score - a.score).slice(0, 3).map((e) => ({ id: e.id, title: e.title, start_local: e.next_occurrence?.start_local ?? e.start_local })),
      last_discovery_at: c?.last_discovery_at ?? null,
      last_verification_at: c?.last_verification_at ?? null,
    };
  });
}

export async function search(ctx: AppContext, userId: string, q: string) {
  const n = normalize(q);
  if (n.length < 2) return { events: [], artists: [], venues: [], cities: [] };
  const like = `%${n}%`;
  const [events, artists, venues] = await Promise.all([
    listEvents(ctx, userId, { scope: 'any', q, mode: 'all', limit: 12, sort: 'date' }),
    ctx.db.selectFrom('artists').select(['id', 'name', 'aliases', 'genres']).where((w) => w.or([w('normalized_name', 'like', like), w('aliases', 'like', `%${q.replace(/[%_]/g, '')}%`)])).limit(10).execute(),
    ctx.db.selectFrom('venues').select(['id', 'name', 'town', 'city', 'country']).where('normalized_name', 'like', like).limit(10).execute(),
  ]);
  const watch = await ctx.db.selectFrom('watchlist').select(['artist_id', 'status']).where('user_id', '=', userId).execute();
  const cities = HUBS.filter((h) => h.aliases.some((a) => normalize(a).includes(n)) || normalize(h.name).includes(n)).map((h) => ({ slug: h.slug, name: h.name }));
  if ('ibiza'.includes(n) || n.includes('ibiza') || n.includes('eivissa')) cities.push({ slug: 'ibiza', name: 'Ibiza' });
  return {
    events: events.items,
    artists: artists.map((a) => ({ id: a.id, name: a.name, aliases: parseJson<string[]>(a.aliases, []), watch_status: watch.find((w) => w.artist_id === a.id)?.status ?? null })),
    venues,
    cities,
  };
}

export async function venueEvents(ctx: AppContext, userId: string, venueId: string) {
  const v = await ctx.db.selectFrom('venues').selectAll().where('id', '=', venueId).executeTakeFirst();
  if (!v) throw new HttpError(404, 'Venue not found');
  const rows = await ctx.db.selectFrom('events').select('id').where('venue_id', '=', venueId).execute();
  const list = await listEvents(ctx, userId, { scope: 'any', mode: 'all', limit: 200 });
  const ids = new Set(rows.map((r) => r.id));
  return { venue: v, events: list.items.filter((e) => ids.has(e.id)) };
}

export async function lastUpdated(ctx: AppContext) {
  return getSetting<string | null>(ctx, 'last_successful_run_at', null);
}
