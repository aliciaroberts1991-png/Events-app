// Authenticated research API: /api/research/v1
// Authorization: Bearer <token>   (create tokens in Settings → Research, or `npm run token:create`)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runCompleteInput, runCreateInput, runFailInput } from '../../shared/research-schema';
import { CATEGORIES, GENRES, HUBS, IBIZA } from '../../shared/taxonomy';
import { authenticateToken } from '../auth';
import type { AppContext } from '../context';
import { HttpError, nowIso, parseJson } from '../util';
import { getEventDetail, hydrate } from '../services/events';
import { importBatch, setSetting } from '../services/import';
import { getPreferences } from '../services/preferences';
import { listWatchlist } from '../services/personal';
import { claimNextRun, completeRun, createRun, failRun, getRun, heartbeat, runBrief, serializeRun, COVERAGE_AREAS } from '../services/runs';
import { buildOpenApi } from '../openapi';

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new HttpError(422, 'Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

async function ownerId(ctx: AppContext) {
  const u = await ctx.db.selectFrom('users').select('id').orderBy('created_at').executeTakeFirst();
  if (!u) throw new HttpError(409, 'No owner account exists yet');
  return u.id;
}

export async function researchRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/research/v1/openapi.json', async (req) => buildOpenApi(ctx, req));

  app.register(async (r) => {
    r.addHook('onRequest', async (req) => {
      req.researchToken = await authenticateToken(ctx, req);
    });

    /** Authenticated write that proves the connection works end to end. */
    r.post('/api/research/v1/ping', async (req) => {
      const body = parse(z.object({ executor: z.string().max(100).optional(), note: z.string().max(500).optional() }), req.body);
      const run = await createRun(ctx, { type: 'connection_test', trigger: 'api', status: 'running', executor: body.executor ?? req.researchToken!.name });
      const done = await completeRun(ctx, run.id, { outcome: 'success', summary: body.note ?? 'Connection test' });
      await setSetting(ctx, 'last_connection_test', { at: nowIso(), ok: true, executor: body.executor ?? req.researchToken!.name });
      return { ok: true, message: 'Authenticated and recorded a connection-test run.', run: serializeRun(done) };
    });

    r.get('/api/research/v1/context', async () => {
      const uid = await ownerId(ctx);
      const [{ data: prefs }, watchlist] = await Promise.all([getPreferences(ctx, uid), listWatchlist(ctx, uid)]);
      const cov = await ctx.db.selectFrom('coverage').selectAll().execute();
      return {
        generated_at: nowIso(),
        planning_timezone: prefs.planningTimezone,
        watchlist: {
          active: watchlist.filter((w) => w.status === 'active').map((w) => ({ artist_id: w.artist_id, name: w.name, aliases: w.aliases, links: w.links, keys: w.keys, genres: w.genres, note: w.note })),
          paused: watchlist.filter((w) => w.status === 'paused').map((w) => ({ artist_id: w.artist_id, name: w.name })),
        },
        geographic_scopes: {
          cities: HUBS.map((h) => ({ slug: h.slug, name: h.name, country: h.country, lat: h.lat, lng: h.lng, timezone: h.timezone, nearby_radius_km: prefs.nearbyRadiusKm })),
          festivals_nearby_radius_km: prefs.festivalNearbyRadiusKm,
          ibiza: IBIZA,
          artist_tracking: 'Europe (all European countries, including the UK and Ibiza)',
          coverage_areas: COVERAGE_AREAS,
        },
        interests: {
          categories: prefs.categoryWeights,
          genres: prefs.genreWeights,
          scale: '-3 (avoid) … 3 (top priority)',
          prefer_english_friendly: prefs.preferEnglishFriendly,
          spoken_languages: prefs.spokenLanguages,
        },
        coverage: cov,
        rules: [
          'Prefer official artist, venue, promoter, festival and ticketing sources; include source URLs for material claims.',
          'Use event-local times with an IANA timezone; send dates without times when times are not announced.',
          'Only report ticket status "available" or "sold_out" when checked on a live ticket page; otherwise "unknown".',
          'Use "unverified_fields" and "tba_fields" instead of guessing; record conflicting sources in "conflicts".',
          'Absent fields keep stored values; null clears a value.',
        ],
      };
    });

    r.get('/api/research/v1/watchlist', async () => {
      const uid = await ownerId(ctx);
      return { artists: await listWatchlist(ctx, uid) };
    });

    r.get('/api/research/v1/taxonomy', async () => ({ categories: CATEGORIES, genres: GENRES }));

    r.get('/api/research/v1/events', async (req) => {
      const q = parse(
        z.object({
          updated_since: z.string().optional(),
          upcoming: z.enum(['true', 'false']).default('true'),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
          q: z.string().optional(),
        }),
        req.query,
      );
      let query = ctx.db.selectFrom('events').selectAll().where('origin', '!=', 'manual');
      if (q.upcoming === 'true') query = query.where('span_end_utc', '>=', ctx.now().toISOString());
      if (q.updated_since) query = query.where('updated_at', '>=', q.updated_since);
      if (q.q) query = query.where('normalized_title', 'like', `%${q.q.toLowerCase()}%`);
      const rows = await query.orderBy('start_utc').limit(q.limit).offset(q.offset).execute();
      const keys = rows.length ? await ctx.db.selectFrom('event_keys').selectAll().where('event_id', 'in', rows.map((x) => x.id)).execute() : [];
      const items = await hydrate(ctx, rows, null);
      return {
        items: items.map((e) => ({ ...researchView(e), source_keys: keys.filter((k) => k.event_id === e.id).map((k) => k.key) })),
        limit: q.limit,
        offset: q.offset,
        next_offset: rows.length === q.limit ? q.offset + q.limit : null,
      };
    });

    r.get('/api/research/v1/events/:id', async (req) => {
      const uid = await ownerId(ctx);
      const d = await getEventDetail(ctx, uid, (req.params as { id: string }).id);
      if (d.origin === 'manual') throw new HttpError(404, 'Event not found');
      // Personal fields are never exposed to the research API.
      const { state, bookings, possible_matches, reasons, score, highlight, ...rest } = d;
      void state; void bookings; void possible_matches; void reasons; void score; void highlight;
      return rest;
    });

    /** Upcoming listings to recheck, most urgent first, in batches. */
    r.get('/api/research/v1/verification-queue', async (req) => {
      const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), stale_hours: z.coerce.number().min(0).default(120) }), req.query);
      const uid = await ownerId(ctx);
      const now = ctx.now();
      const nowIso2 = now.toISOString();
      const rows = await ctx.db
        .selectFrom('events')
        .selectAll()
        .where('origin', '!=', 'manual')
        .where('archived_at', 'is', null)
        .where('span_end_utc', '>=', nowIso2)
        .execute();
      const states = await ctx.db.selectFrom('user_event_state').select(['event_id', 'plan_status', 'favourite']).where('user_id', '=', uid).execute();
      const stateMap = new Map(states.map((s) => [s.event_id, s]));
      const staleCut = new Date(now.getTime() - q.stale_hours * 3600_000).toISOString();
      const scored = rows
        .map((e) => {
          const st = stateMap.get(e.id);
          const days = (Date.parse(e.start_utc) - now.getTime()) / 86400_000;
          const saleSoon = [e.presale_at, e.onsale_at].some((s) => s && Date.parse(s) - now.getTime() < 14 * 86400_000 && Date.parse(s) > now.getTime() - 86400_000);
          let priority = 0;
          const reasons: string[] = [];
          if (st?.plan_status === 'booked') (priority += 50), reasons.push('booked');
          else if (st?.plan_status === 'going') (priority += 35), reasons.push('going');
          else if (st?.plan_status === 'interested' || st?.favourite) (priority += 15), reasons.push('saved');
          if (days < 7) (priority += 30), reasons.push('within 7 days');
          else if (days < 30) (priority += 15), reasons.push('within 30 days');
          if (saleSoon) (priority += 25), reasons.push('ticket sale approaching');
          if (!e.last_verified_at || e.last_verified_at < staleCut) (priority += 10), reasons.push(e.last_verified_at ? 'not checked recently' : 'never verified');
          if (e.needs_review) (priority += 10), reasons.push('flagged for review');
          return { e, priority, reasons };
        })
        .sort((a, b) => b.priority - a.priority || a.e.start_utc.localeCompare(b.e.start_utc));
      const page = scored.slice(q.offset, q.offset + q.limit);
      const keys = page.length ? await ctx.db.selectFrom('event_keys').selectAll().where('event_id', 'in', page.map((x) => x.e.id)).execute() : [];
      const sources = page.length ? await ctx.db.selectFrom('event_sources').select(['event_id', 'url', 'source_type', 'status']).where('event_id', 'in', page.map((x) => x.e.id)).execute() : [];
      const hydrated = await hydrate(ctx, page.map((x) => x.e), null);
      return {
        total: scored.length,
        offset: q.offset,
        limit: q.limit,
        next_offset: q.offset + q.limit < scored.length ? q.offset + q.limit : null,
        items: page.map((x, i) => ({
          priority: x.priority,
          reasons: x.reasons,
          event: { ...researchView(hydrated[i]), source_keys: keys.filter((k) => k.event_id === x.e.id).map((k) => k.key), sources: sources.filter((s) => s.event_id === x.e.id) },
        })),
      };
    });

    r.post('/api/research/v1/runs', async (req) => {
      const body = parse(runCreateInput, req.body);
      const run = await createRun(ctx, { type: body.type, trigger: 'api', params: body.params, status: 'running', executor: body.executor ?? req.researchToken!.name });
      return { run: serializeRun(run), brief: await runBrief(ctx, run) };
    });

    r.post('/api/research/v1/runs/claim', async (req, reply) => {
      const body = parse(z.object({ executor: z.string().max(100).optional(), types: z.array(z.string()).optional() }), req.body);
      const run = await claimNextRun(ctx, body.executor ?? req.researchToken!.name, body.types);
      if (!run) return reply.code(204).send();
      return { run: serializeRun(run), brief: await runBrief(ctx, run) };
    });

    r.get('/api/research/v1/runs/:id', async (req) => {
      const run = await getRun(ctx, (req.params as { id: string }).id);
      const errors = await ctx.db.selectFrom('run_errors').selectAll().where('run_id', '=', run.id).orderBy('created_at').limit(200).execute();
      return { run: serializeRun(run), errors };
    });

    r.post('/api/research/v1/runs/:id/heartbeat', async (req) => ({ run: serializeRun(await heartbeat(ctx, (req.params as { id: string }).id)) }));
    r.post('/api/research/v1/runs/:id/complete', async (req) => ({ run: serializeRun(await completeRun(ctx, (req.params as { id: string }).id, parse(runCompleteInput, req.body))) }));
    r.post('/api/research/v1/runs/:id/fail', async (req) => ({ run: serializeRun(await failRun(ctx, (req.params as { id: string }).id, parse(runFailInput, req.body))) }));

    r.post('/api/research/v1/import', async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = req.headers['idempotency-key'];
      if (typeof key === 'string' && !body.idempotency_key) body.idempotency_key = key;
      return importBatch(ctx, body, { actor: 'research' });
    });
  });
}

/** Facts only — no personal data. */
function researchView(e: Awaited<ReturnType<typeof hydrate>>[number]) {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    status: e.status,
    start_local: e.start_local,
    end_local: e.end_local,
    timezone: e.timezone,
    venue: e.venue,
    town: e.town,
    city: e.city,
    country: e.country,
    categories: e.categories,
    genres: e.genres,
    lineup: e.artists.map((a) => ({ artist_id: a.artist_id, name: a.name, billing: a.billing, format: a.format, date: a.date, confirmed: a.confirmed })),
    festival: e.festival,
    residency_id: e.residency_id,
    ticket_status: e.ticket_status,
    presale_at: e.presale_at,
    onsale_at: e.onsale_at,
    sale_timezone: e.sale_timezone,
    price_min: e.price_min,
    price_max: e.price_max,
    currency: e.currency,
    why_suits_me: e.why_suits_me,
    verification_state: e.verification_state,
    last_verified_at: e.last_verified_at,
    needs_review: e.needs_review,
    is_demo: e.is_demo,
  };
}

export { parse, parseJson };
