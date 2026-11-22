// Initial watchlist and optional DEMO data.
// Demo records are fictional (venues, festivals and most artists are invented),
// flagged is_demo = 1, labelled "Demo" everywhere in the interface, and can be
// removed in one step. They exist only so every view can be tried before real
// research results arrive.
import { DateTime } from 'luxon';
import type { ImportPayload } from '../../shared/research-schema';
import type { AppContext } from '../context';
import { newId, normalize, nowIso } from '../util';
import { importBatch, getSetting, setSetting } from './import';

export const INITIAL_WATCHLIST = [
  {
    name: 'Maribou State',
    aliases: [],
    genres: ['downtempo', 'organic-house'],
    description:
      'British duo (Chris Davids and Liam Ivory) making warm, melodic electronica and downtempo with live instrumentation and vocals. Their tours are usually full live-band shows rather than DJ sets.',
  },
  {
    name: 'Bicep',
    aliases: [],
    genres: ['breakbeat', 'house', 'techno'],
    description:
      'Belfast-born duo (Andy Ferguson and Matt McBriar) known for euphoric, melodic breakbeat-led house and techno with a nostalgic rave feel. They tour a live audio-visual show as well as DJ sets.',
  },
  {
    name: 'Chase & Status',
    aliases: ['Chase and Status'],
    genres: ['dnb', 'dancefloor-dnb', 'jungle', 'bass'],
    description:
      'London duo (Saul Milton and Will Kennard) at the big-room end of drum and bass — dancefloor DnB, jungle and bass music. They play both high-energy live shows with MCs and DJ sets.',
  },
  {
    name: 'Damian Lazarus',
    aliases: [],
    genres: ['organic-house', 'afro-house', 'deep-house'],
    description:
      'British DJ and producer, founder of the Crosstown Rebels label and the Day Zero parties. Plays eclectic, hypnotic deep, organic and afro-leaning house, often in long sets.',
  },
  {
    name: 'Goddard.',
    aliases: ['Goddard'],
    genres: [],
    description: null,
  },
];

/** Adds the starting watchlist for a new owner (once). Seeded descriptions are marked unverified. */
export async function seedWatchlist(ctx: AppContext, userId: string) {
  const done = await getSetting<boolean>(ctx, `watchlist_seeded_${userId}`, false);
  if (done) return;
  const t = nowIso();
  for (const a of INITIAL_WATCHLIST) {
    let artist = await ctx.db.selectFrom('artists').select('id').where('normalized_name', '=', normalize(a.name)).executeTakeFirst();
    if (!artist) {
      const id = newId('art');
      await ctx.db
        .insertInto('artists')
        .values({
          id,
          name: a.name,
          normalized_name: normalize(a.name),
          aliases: JSON.stringify(a.aliases),
          description: a.description,
          description_source: null,
          description_verified: 0,
          genres: JSON.stringify(a.genres),
          links: '{}',
          country: null,
          origin: 'seed',
          is_demo: 0,
          created_at: t,
          updated_at: t,
        })
        .execute();
      artist = { id };
    }
    await ctx.db
      .insertInto('watchlist')
      .values({
        id: newId('wl'),
        user_id: userId,
        artist_id: artist.id,
        status: 'active',
        note: a.name === 'Goddard.' ? 'Add an official link so research can tell this act apart from others named Goddard.' : null,
        added_at: t,
        updated_at: t,
      })
      .onConflict((oc) => oc.columns(['user_id', 'artist_id']).doNothing())
      .execute();
  }
  await setSetting(ctx, `watchlist_seeded_${userId}`, true);
}

const V = {
  dock: { key: 'demo:venue:dock7', name: 'Dock 7 (demo venue)', address: 'Nábrežie 7', city: 'Bratislava', town: 'Bratislava', country: 'SK', lat: 48.1405, lng: 17.1205 },
  halle: { key: 'demo:venue:halle', name: 'Halle Süd (demo venue)', address: 'Gürtel 120', city: 'Vienna', town: 'Vienna', country: 'AT', lat: 48.185, lng: 16.36 },
  square: { key: 'demo:venue:square', name: 'Main Square market (demo)', city: 'Bratislava', town: 'Bratislava', country: 'SK', lat: 48.1437, lng: 17.1088 },
  pincer: { key: 'demo:venue:pincer', name: 'Pincér Hall (demo venue)', city: 'Budapest', town: 'Budapest', country: 'HU', lat: 47.4925, lng: 19.0513 },
  cellar: { key: 'demo:venue:cellar', name: 'The Cellar Stage (demo venue)', city: 'Prague', town: 'Prague', country: 'CZ', lat: 50.0835, lng: 14.4211 },
  arenaW: { key: 'demo:venue:arena-w', name: 'Donau Arena (demo venue)', city: 'Vienna', town: 'Vienna', country: 'AT', lat: 48.2, lng: 16.42 },
  arenaP: { key: 'demo:venue:arena-p', name: 'Vltava Arena (demo venue)', city: 'Prague', town: 'Prague', country: 'CZ', lat: 50.104, lng: 14.492 },
  island: { key: 'demo:venue:island', name: 'Riverside Island grounds (demo)', city: 'Šamorín', town: 'Šamorín', country: 'SK', lat: 48.03, lng: 17.31 },
  costa: { key: 'demo:venue:costa', name: 'Costa Bloom grounds (demo)', city: 'Valencia', town: 'Valencia', country: 'ES', lat: 39.47, lng: -0.376 },
  laguna: { key: 'demo:venue:laguna', name: 'Casa Laguna (demo club)', city: 'Sant Josep de sa Talaia', town: 'Platja d’en Bossa', region: 'Ibiza', country: 'ES', lat: 38.88, lng: 1.405 },
  faro: { key: 'demo:venue:faro', name: 'El Faro Club (demo club)', city: 'Sant Antoni de Portmany', town: 'Sant Antoni', region: 'Ibiza', country: 'ES', lat: 38.98, lng: 1.3 },
  market: { key: 'demo:venue:naschmarkt-demo', name: 'Canal Farmers’ Market (demo)', city: 'Vienna', town: 'Vienna', country: 'AT', lat: 48.199, lng: 16.364 },
  hainburg: { key: 'demo:venue:hainburg', name: 'Schlossberg trailhead (demo)', city: 'Hainburg an der Donau', town: 'Hainburg an der Donau', country: 'AT', lat: 48.1468, lng: 16.9419 },
};

export function buildDemoPayload(now: Date): ImportPayload {
  const tz = 'Europe/Bratislava';
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day');
  const d = (days: number) => today.plus({ days }).toISODate()!;
  const fri = today.plus({ days: (5 - today.weekday + 7) % 7 });
  const nextFri = fri.weekday === today.weekday && today.weekday >= 5 ? fri : fri;
  const f = (days: number) => nextFri.plus({ days }).toISODate()!;
  const summer = today.month >= 8 ? today.year + 1 : today.year;
  const ibizaSeason = today.month >= 10 ? today.year + 1 : today.year;
  const demoSource = (slug: string) => [{ url: `https://example.org/demo/${slug}`, type: 'other' as const, name: 'Demo data — not a real listing' }];
  const sale = today.plus({ days: 10 }).toISODate()!;

  return {
    artists: [
      { name: 'Velvet Circuit', keys: ['demo:artist:velvet-circuit'], genres: ['liquid-dnb'], description: 'Fictional demo act: rolling, soulful liquid drum and bass with live vocals.' },
      { name: 'Mara Kova', keys: ['demo:artist:mara-kova'], genres: ['melodic-techno'], description: 'Fictional demo DJ: melodic, driving techno with long hypnotic builds.' },
      { name: 'Sub Alpine', keys: ['demo:artist:sub-alpine'], genres: ['neurofunk'], description: 'Fictional demo act: heavier, technical neurofunk.' },
      { name: 'Noemi Rhys', keys: ['demo:artist:noemi-rhys'], genres: ['deep-house'], description: 'Fictional demo DJ: warm deep house and disco edits.' },
      { name: 'Kolektiv Tide', keys: ['demo:artist:kolektiv-tide'], genres: ['house'], description: 'Fictional demo local collective playing house and garage.' },
      { name: 'The Lanterns', keys: ['demo:artist:the-lanterns'], genres: ['indie', 'rock'], description: 'Fictional demo band: anthemic indie rock.' },
      { name: 'Lumen Drift', keys: ['demo:artist:lumen-drift'], genres: ['afro-house'], description: 'Fictional demo DJ: percussive afro house.' },
    ],
    residencies: [
      {
        keys: ['demo:res:rebel-sundays'],
        season: ibizaSeason,
        title: 'Rebel Sundays (demo)',
        brand: 'Rebel Sundays',
        venue: V.laguna,
        weekday: 7,
        start_date: `${ibizaSeason}-06-07`,
        end_date: `${ibizaSeason}-10-04`,
        status: 'confirmed',
        description: 'Demo residency for trying the Ibiza view. Not a real announcement.',
        residents: [{ name: 'Damian Lazarus' }, { artist_key: 'demo:artist:lumen-drift' }],
        sources: demoSource('rebel-sundays'),
      },
      {
        keys: ['demo:res:bass-theory'],
        season: ibizaSeason,
        title: 'Bass Theory (demo)',
        brand: 'Bass Theory',
        venue: V.faro,
        weekday: 2,
        start_date: `${ibizaSeason}-06-16`,
        end_date: `${ibizaSeason}-09-22`,
        status: 'announced',
        description: 'Demo drum and bass residency. Lineups to be announced.',
        residents: [{ artist_key: 'demo:artist:velvet-circuit' }],
        sources: demoSource('bass-theory'),
      },
      {
        keys: ['demo:res:melodic-mondays'],
        season: ibizaSeason,
        title: 'Melodic Mondays (demo)',
        brand: 'Melodic Mondays',
        venue: V.laguna,
        weekday: 1,
        start_date: `${ibizaSeason}-06-15`,
        end_date: `${ibizaSeason}-09-28`,
        status: 'announced',
        residents: [{ artist_key: 'demo:artist:mara-kova' }],
        sources: demoSource('melodic-mondays'),
      },
    ],
    events: [
      {
        source_keys: ['demo:evt:liquid-sessions'],
        title: 'Liquid Sessions (demo)',
        start: `${f(1)}T22:00`,
        end: '05:00',
        doors: '22:00',
        timezone: tz,
        venue: V.dock,
        categories: ['dnb'],
        genres: ['liquid-dnb', 'dancefloor-dnb'],
        lineup: [
          { artist_key: 'demo:artist:velvet-circuit', billing: 'headliner', format: 'live', set_start: '00:30', set_end: '02:00' },
          { artist_key: 'demo:artist:sub-alpine', billing: 'support', format: 'dj_set' },
        ],
        description: 'Demo club night to show an overnight event (22:00 to 05:00).',
        expectation: 'Roller-heavy liquid DnB in a mid-sized riverside room; busy after midnight.',
        why_suits_me: 'Liquid and dancefloor drum and bass — your top priority genre — ten minutes from home.',
        tickets: { url: 'https://example.org/demo/liquid-sessions/tickets', price_min: 15, price_max: 22, currency: 'EUR', status: 'available', status_checked_at: now.toISOString(), booking_fee_note: '€1.50 booking fee per ticket' },
        age_restriction: '18+',
        languages: ['none'],
        language_importance: 'none',
        prominence: 55,
        highlight: true,
        sources: demoSource('liquid-sessions'),
        verified_at: now.toISOString(),
      },
      {
        source_keys: ['demo:evt:halle-techno'],
        title: 'Halle Süd: Mara Kova all night long (demo)',
        start: `${f(1)}T23:00`,
        end: '06:00',
        timezone: 'Europe/Vienna',
        venue: V.halle,
        categories: ['techno'],
        genres: ['melodic-techno'],
        lineup: [{ artist_key: 'demo:artist:mara-kova', billing: 'headliner', format: 'dj_set', set_start: '23:00', set_end: '06:00' }],
        why_suits_me: 'A seven-hour melodic techno set — exactly the long-form techno you rate highly.',
        tickets: { price_min: 25, currency: 'EUR', status: 'unknown', presale_at: `${sale}T10:00`, sale_timezone: 'Europe/Vienna' },
        prominence: 62,
        sources: demoSource('halle-techno'),
        tba_fields: ['doors'],
      },
      {
        source_keys: ['demo:evt:kolektiv-tide'],
        title: 'Kolektiv Tide residents night (demo)',
        start: `${f(0)}T22:00`,
        timezone: tz,
        venue: V.dock,
        categories: ['house'],
        genres: ['house', 'uk-garage'],
        lineup: [{ artist_key: 'demo:artist:kolektiv-tide', billing: 'resident', format: 'dj_set' }],
        description: 'Small demo club night: shows in All events only.',
        tickets: { status: 'door_only', price_min: 8, currency: 'EUR' },
        prominence: 12,
        unverified_fields: ['end'],
        sources: demoSource('kolektiv-tide'),
      },
      {
        source_keys: ['demo:evt:xmas-market'],
        kind: 'recurring',
        title: 'Main Square Christmas Market (demo)',
        timezone: tz,
        recurrence: { freq: 'daily', from: d(-2), until: `${today.year}-12-23`, start_time: '10:00', end_time: '22:00', exceptions: [] },
        venue: V.square,
        categories: ['christmas-market', 'food-market'],
        description: 'Demo recurring market (daily occurrences) to show how markets work in filters and the calendar.',
        expectation: 'Mulled wine, lokše and crafts; busiest on weekend evenings.',
        languages: ['sk', 'en'],
        language_importance: 'none',
        tickets: { status: 'free' },
        prominence: 50,
        highlight: true,
        sources: demoSource('xmas-market'),
      },
      {
        source_keys: ['demo:evt:farmers'],
        kind: 'recurring',
        title: 'Canal Farmers’ Market (demo)',
        timezone: 'Europe/Vienna',
        recurrence: { freq: 'weekly', byweekday: ['SA'], from: d(0), until: d(120), start_time: '08:00', end_time: '13:00', exceptions: [f(29)] },
        venue: V.market,
        categories: ['farmers-market'],
        tickets: { status: 'free' },
        prominence: 25,
        sources: demoSource('farmers'),
      },
      {
        source_keys: ['demo:evt:wine-fest'],
        title: 'Danube Wine Days (demo)',
        start: f(7),
        end: f(9),
        timezone: 'Europe/Budapest',
        venue: V.pincer,
        categories: ['wine', 'food-festival'],
        description: 'Demo multi-day food and drink festival with dates but no times yet.',
        tickets: { price_min: 6000, price_max: 9000, currency: 'HUF', status: 'available' },
        languages: ['hu', 'en'],
        language_importance: 'helpful',
        prominence: 45,
        tba_fields: ['start_time', 'end_time'],
        sources: demoSource('wine-fest'),
      },
      {
        source_keys: ['demo:evt:comedy'],
        title: 'Cellar Comedy: English stand-up showcase (demo)',
        start: `${f(0)}T20:00`,
        end: `${f(0)}T22:00`,
        doors: '19:30',
        timezone: 'Europe/Prague',
        venue: V.cellar,
        categories: ['stand-up', 'english-comedy'],
        languages: ['en'],
        language_importance: 'essential',
        tickets: { price_min: 350, currency: 'CZK', status: 'limited' },
        prominence: 40,
        sources: demoSource('comedy'),
      },
      {
        source_keys: ['demo:evt:boxing'],
        title: 'Donau Fight Night (demo)',
        start: `${f(8)}T19:00`,
        timezone: 'Europe/Vienna',
        venue: V.arenaW,
        categories: ['boxing', 'mma'],
        participation: 'spectator',
        tickets: { price_min: 39, price_max: 149, currency: 'EUR', status: 'sale_not_started', onsale_at: `${sale}T09:00`, sale_timezone: 'Europe/Vienna' },
        prominence: 60,
        sources: demoSource('boxing'),
      },
      {
        source_keys: ['demo:evt:lanterns'],
        title: 'The Lanterns — arena tour (demo)',
        start: `${f(14)}T20:30`,
        doors: '18:30',
        timezone: 'Europe/Prague',
        venue: V.arenaP,
        categories: ['concert', 'rock'],
        genres: ['indie', 'rock'],
        lineup: [{ artist_key: 'demo:artist:the-lanterns', billing: 'headliner', format: 'live' }],
        tickets: { price_min: 1290, price_max: 2890, currency: 'CZK', status: 'available' },
        prominence: 85,
        sources: demoSource('lanterns'),
      },
      {
        source_keys: ['demo:evt:hike'],
        title: 'Guided winter hike: Hainburg ridges (demo)',
        start: `${f(2)}T09:00`,
        end: `${f(2)}T14:00`,
        timezone: 'Europe/Vienna',
        venue: V.hainburg,
        categories: ['hike'],
        participation: 'participant',
        languages: ['de', 'en'],
        language_importance: 'helpful',
        tickets: { price_min: 12, currency: 'EUR', status: 'available' },
        prominence: 30,
        sources: demoSource('hike'),
      },
      {
        source_keys: ['demo:evt:danube-pulse'],
        kind: 'festival',
        title: `Danube Pulse Festival ${summer} (demo)`,
        festival: { name: 'Danube Pulse Festival (demo)', edition: String(summer), series_key: 'demo:fes:danube-pulse' },
        start: `${summer}-07-09`,
        end: `${summer}-07-11`,
        timezone: tz,
        venue: V.island,
        categories: ['music-festival', 'dnb', 'techno'],
        genres: ['dnb', 'techno', 'house'],
        lineup: [
          { name: 'Chase & Status', billing: 'headliner', format: 'live', date: `${summer}-07-10`, set_start: '23:30', set_end: '01:00', stage: 'Main stage' },
          { name: 'Bicep', billing: 'headliner', format: 'dj_set', date: `${summer}-07-11`, stage: 'Main stage' },
          { artist_key: 'demo:artist:velvet-circuit', billing: 'support', format: 'live', date: `${summer}-07-10` },
          { artist_key: 'demo:artist:mara-kova', billing: 'support', format: 'dj_set', date: `${summer}-07-09` },
        ],
        tickets: {
          price_min: 59,
          price_max: 149,
          currency: 'EUR',
          status: 'available',
          tiers: [
            { name: '3-day pass', price: 149, currency: 'EUR' },
            { name: 'Day ticket (Friday)', price: 59, currency: 'EUR', day: `${summer}-07-10` },
            { name: 'Camping add-on', price: 35, currency: 'EUR' },
          ],
        },
        camping: { available: true, note: 'Demo: on-site camping with lockers' },
        accommodation: { note: 'Demo: shuttle buses from Bratislava' },
        why_suits_me: 'Chase & Status and Bicep on one nearby weekend, with a strong drum and bass and techno undercard.',
        prominence: 80,
        highlight: true,
        sources: demoSource('danube-pulse'),
        unverified_fields: ['set_times'],
      },
      {
        source_keys: ['demo:evt:costa-bloom'],
        kind: 'festival',
        title: `Costa Bloom ${summer} (demo)`,
        festival: { name: 'Costa Bloom (demo)', edition: String(summer), series_key: 'demo:fes:costa-bloom' },
        start: `${summer}-06-19`,
        end: `${summer}-06-21`,
        timezone: 'Europe/Madrid',
        venue: V.costa,
        categories: ['music-festival', 'electronic'],
        genres: ['house', 'downtempo'],
        lineup: [
          { name: 'Maribou State', billing: 'headliner', format: 'live', date: `${summer}-06-20` },
          { name: 'Bicep', billing: 'headliner', format: 'av_show', date: `${summer}-06-21` },
          { artist_key: 'demo:artist:noemi-rhys', billing: 'support', format: 'dj_set', date: `${summer}-06-19` },
        ],
        tickets: { price_min: 95, price_max: 220, currency: 'EUR', status: 'sale_not_started', presale_at: `${today.plus({ days: 20 }).toISODate()}T10:00`, sale_timezone: 'Europe/Madrid' },
        camping: { available: false },
        prominence: 75,
        sources: demoSource('costa-bloom'),
      },
      {
        source_keys: ['demo:evt:ibiza-opening'],
        title: `Rebel Sundays opening party ${ibizaSeason} (demo)`,
        start: `${ibizaSeason}-06-07T16:00`,
        end: '04:00',
        timezone: 'Europe/Madrid',
        venue: V.laguna,
        residency_key: 'demo:res:rebel-sundays',
        occasion: 'opening',
        categories: ['house'],
        genres: ['organic-house', 'afro-house'],
        lineup: [
          { name: 'Damian Lazarus', billing: 'headliner', format: 'dj_set' },
          { artist_key: 'demo:artist:lumen-drift', billing: 'support', format: 'dj_set' },
        ],
        tickets: { price_min: 60, price_max: 90, currency: 'EUR', status: 'sale_not_started' },
        prominence: 70,
        sources: demoSource('ibiza-opening'),
      },
      {
        source_keys: ['demo:evt:ibiza-rebel-july'],
        title: 'Rebel Sundays (demo)',
        start: `${ibizaSeason}-07-19T17:00`,
        end: '04:00',
        timezone: 'Europe/Madrid',
        venue: V.laguna,
        residency_key: 'demo:res:rebel-sundays',
        categories: ['house'],
        genres: ['organic-house'],
        lineup: [{ name: 'Damian Lazarus', billing: 'headliner', format: 'dj_set' }],
        tickets: { price_min: 55, currency: 'EUR', status: 'unknown' },
        prominence: 55,
        sources: demoSource('ibiza-rebel-july'),
      },
      {
        source_keys: ['demo:evt:ibiza-bass-theory'],
        title: 'Bass Theory: Velvet Circuit (demo)',
        start: `${ibizaSeason}-07-21T23:00`,
        end: '06:00',
        timezone: 'Europe/Madrid',
        venue: V.faro,
        residency_key: 'demo:res:bass-theory',
        categories: ['dnb'],
        genres: ['liquid-dnb'],
        lineup: [{ artist_key: 'demo:artist:velvet-circuit', billing: 'headliner', format: 'live' }],
        tickets: { price_min: 40, currency: 'EUR', status: 'available' },
        prominence: 45,
        sources: demoSource('ibiza-bass-theory'),
      },
      {
        source_keys: ['demo:evt:ibiza-closing'],
        title: `Rebel Sundays closing party ${ibizaSeason} (demo)`,
        start: `${ibizaSeason}-10-04T16:00`,
        end: '04:00',
        timezone: 'Europe/Madrid',
        venue: V.laguna,
        residency_key: 'demo:res:rebel-sundays',
        occasion: 'closing',
        categories: ['house'],
        lineup: [{ name: 'Damian Lazarus', billing: 'headliner', format: 'dj_set' }],
        tickets: { status: 'sale_not_started' },
        prominence: 70,
        sources: demoSource('ibiza-closing'),
        tba_fields: ['price'],
      },
    ],
  };
}

export async function loadDemo(ctx: AppContext) {
  const res = await importBatch(ctx, buildDemoPayload(ctx.now()), { actor: 'research', isDemo: true });
  await setSetting(ctx, 'demo_loaded_at', nowIso());
  return res;
}

export async function removeDemo(ctx: AppContext) {
  const db = ctx.db;
  const events = await db.deleteFrom('events').where('is_demo', '=', 1).executeTakeFirst();
  await db.deleteFrom('residencies').where('is_demo', '=', 1).execute();
  await db.deleteFrom('festival_series').where('is_demo', '=', 1).execute();
  const watched = db.selectFrom('watchlist').select('artist_id');
  await db.deleteFrom('artists').where('is_demo', '=', 1).where('id', 'not in', watched).where('id', 'not in', db.selectFrom('event_artists').select('artist_id')).execute();
  await db.deleteFrom('venues').where('is_demo', '=', 1).where('id', 'not in', db.selectFrom('events').select('venue_id').where('venue_id', 'is not', null)).execute();
  await setSetting(ctx, 'demo_loaded_at', null);
  return { events_removed: Number(events.numDeletedRows ?? 0) };
}

export async function demoStatus(ctx: AppContext) {
  const n = await ctx.db.selectFrom('events').select(ctx.db.fn.countAll<number>().as('n')).where('is_demo', '=', 1).executeTakeFirst();
  return { loaded: Number(n?.n ?? 0) > 0, events: Number(n?.n ?? 0) };
}
