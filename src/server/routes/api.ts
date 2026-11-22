// Private API used by the web app (session cookie). Every route requires sign-in
// except /api/auth/login and /api/auth/state.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { preferencesSchema } from '../../shared/preferences';
import { CATEGORY_GROUPS, GENRES, HUBS, IBIZA } from '../../shared/taxonomy';
import { authenticateSession, checkLoginThrottle, clearLoginFailures, createApiToken, createSession, hashPassword, recordLoginFailure, SESSION_COOKIE, setSessionCookie, verifyPassword } from '../auth';
import type { AppContext } from '../context';
import { HttpError, newId, nowIso, parseJson } from '../util';
import { exportPersonal, importPersonal } from '../services/backup';
import { artistDetail, artistsOverview, citiesSummary, festivals, ibiza, search, venueEvents } from '../services/browse';
import { calendarIcs, calendarWithClashes, eventIcs, history, reviewClash } from '../services/calendar';
import { getEventDetail, listEvents, type ListFilters } from '../services/events';
import { extractFromUrl } from '../services/extract';
import { listFeed, markFeedRead } from '../services/feed';
import { getSetting, importBatch } from '../services/import';
import { emailStatus, sendPendingEmails, sendTestEmail } from '../services/notify';
import {
  addBooking,
  addFeedback,
  addToWatchlist,
  bookingInput,
  clearFeedback,
  deleteBooking,
  deleteManualEvent,
  listWatchlist,
  mergeManualInto,
  planInput,
  quickBooking,
  quickBookingInput,
  removeWatch,
  saveManualEvent,
  savePlan,
  setState,
  stateInput,
  updateBooking,
  updateWatch,
  watchInput,
} from '../services/personal';
import { getPreferences, savePreferences } from '../services/preferences';
import { cancelRun, createRun, getRun, researchStatus, serializeRun } from '../services/runs';
import { demoStatus, loadDemo, removeDemo } from '../services/seed';
import { parse } from './research';

const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const boolQ = (v: unknown) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : undefined);

export function filtersFromQuery(q: Record<string, unknown>): ListFilters {
  return {
    mode: q.mode === 'all' ? 'all' : q.mode === 'highlights' ? 'highlights' : undefined,
    scope: ['local', 'europe', 'ibiza', 'any'].includes(String(q.scope)) ? (q.scope as ListFilters['scope']) : undefined,
    hubs: list(q.hubs),
    nearby: boolQ(q.nearby),
    radiusKm: q.radius ? Number(q.radius) : undefined,
    range: ['today', 'this-weekend', 'next-weekend', 'this-month', 'custom', 'upcoming'].includes(String(q.range)) ? (q.range as ListFilters['range']) : undefined,
    from: typeof q.from === 'string' ? q.from : undefined,
    to: typeof q.to === 'string' ? q.to : undefined,
    categories: list(q.categories),
    genres: list(q.genres),
    q: typeof q.q === 'string' ? q.q : undefined,
    kind: typeof q.kind === 'string' ? q.kind : undefined,
    followed: boolQ(q.followed),
    englishFriendly: boolQ(q.english),
    countries: list(q.countries),
    festivalScope: q.festival_scope === 'nearby' ? 'nearby' : q.festival_scope === 'europe' ? 'europe' : undefined,
    saved: ['any', 'favourites', 'planned', 'hidden'].includes(String(q.saved)) ? (q.saved as ListFilters['saved']) : undefined,
    includeHidden: boolQ(q.include_hidden),
    includePast: boolQ(q.include_past),
    sort: ['date', 'relevance', 'recent'].includes(String(q.sort)) ? (q.sort as ListFilters['sort']) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  };
}

export async function apiRoutes(app: FastifyInstance, ctx: AppContext) {
  // ------------------------------------------------------------------ auth
  app.get('/api/auth/state', async (req, reply) => {
    const users = await ctx.db.selectFrom('users').select(ctx.db.fn.countAll<number>().as('n')).executeTakeFirst();
    const user = await authenticateSession(ctx, req, reply);
    return { app_name: ctx.config.appName, has_owner: Number(users?.n ?? 0) > 0, user: user ? { id: user.id, email: user.email, display_name: user.display_name } : null };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(500) }), req.body);
    const key = `${req.ip}|${body.email.toLowerCase()}`;
    checkLoginThrottle(key);
    const user = await ctx.db.selectFrom('users').selectAll().where('email', '=', body.email.toLowerCase().trim()).executeTakeFirst();
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      recordLoginFailure(key);
      throw new HttpError(401, 'Email or password is incorrect');
    }
    clearLoginFailures(key);
    const s = await createSession(ctx, user.id, req.headers['user-agent']);
    setSessionCookie(ctx, reply, s.token, s.expires);
    return { user: { id: user.id, email: user.email, display_name: user.display_name } };
  });

  app.register(async (r) => {
    r.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await authenticateSession(ctx, req, reply);
      if (!user) throw new HttpError(401, 'Please sign in');
      req.user = user;
      // CSRF defence: cookie-authenticated writes must carry a custom header,
      // which browsers will not send cross-site without a CORS preflight.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-quartet-csrf'] !== '1') {
        throw new HttpError(403, 'Missing request header');
      }
    });
    const uid = (req: FastifyRequest) => req.user!.id;
    const P = (req: FastifyRequest) => req.params as Record<string, string>;

    r.post('/api/auth/logout', async (req, reply) => {
      await ctx.db.deleteFrom('sessions').where('id', '=', req.user!.session_id).execute();
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });
    r.post('/api/auth/password', async (req) => {
      const body = parse(z.object({ current: z.string(), next: z.string().min(10).max(500) }), req.body);
      const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', uid(req)).executeTakeFirstOrThrow();
      if (!(await verifyPassword(body.current, user.password_hash))) throw new HttpError(400, 'Current password is incorrect');
      await ctx.db.updateTable('users').set({ password_hash: await hashPassword(body.next), updated_at: nowIso() }).where('id', '=', user.id).execute();
      await ctx.db.deleteFrom('sessions').where('user_id', '=', user.id).where('id', '!=', req.user!.session_id).execute();
      return { ok: true };
    });
    r.get('/api/auth/sessions', async (req) => {
      const rows = await ctx.db.selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'expires_at', 'user_agent']).where('user_id', '=', uid(req)).orderBy('last_seen_at', 'desc').execute();
      return { sessions: rows.map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === req.user!.session_id })) };
    });
    r.delete('/api/auth/sessions/:id', async (req) => {
      const rows = await ctx.db.selectFrom('sessions').select('id').where('user_id', '=', uid(req)).execute();
      const target = rows.find((s) => s.id.startsWith(P(req).id));
      if (target) await ctx.db.deleteFrom('sessions').where('id', '=', target.id).execute();
      return { ok: true };
    });

    // ---------------------------------------------------------------- meta
    r.get('/api/meta', async () => ({
      app_name: ctx.config.appName,
      category_groups: CATEGORY_GROUPS,
      genres: GENRES,
      hubs: HUBS.map((h) => ({ slug: h.slug, name: h.name, country: h.country })),
      ibiza: IBIZA,
      demo: await demoStatus(ctx),
    }));

    r.get('/api/status', async (req) => researchStatus(ctx, uid(req)));

    // -------------------------------------------------------------- events
    r.get('/api/events', async (req) => listEvents(ctx, uid(req), filtersFromQuery(req.query as Record<string, unknown>)));
    r.get('/api/events/:id', async (req) => getEventDetail(ctx, uid(req), P(req).id));
    r.post('/api/events', async (req) => ({ id: await saveManualEvent(ctx, uid(req), req.body as never) }));
    r.put('/api/events/:id', async (req) => {
      const row = await ctx.db.selectFrom('events').select(['origin', 'owner_user_id']).where('id', '=', P(req).id).executeTakeFirst();
      if (!row || row.origin !== 'manual' || row.owner_user_id !== uid(req)) throw new HttpError(403, 'Only events you added yourself can be edited');
      return { id: await saveManualEvent(ctx, uid(req), req.body as never, P(req).id) };
    });
    r.delete('/api/events/:id', async (req) => {
      await deleteManualEvent(ctx, uid(req), P(req).id);
      return { ok: true };
    });
    r.post('/api/events/:id/merge', async (req) => {
      const body = parse(z.object({ target_id: z.string() }), req.body);
      return { id: await mergeManualInto(ctx, uid(req), P(req).id, body.target_id) };
    });
    r.post('/api/events/extract', async (req) => {
      if (!ctx.config.allowLinkExtraction) return { extracted: false, method: 'none', message: 'Reading links is turned off on this server. Fill in the form instead.', draft: {} };
      const body = parse(z.object({ url: z.url() }), req.body);
      return extractFromUrl(body.url);
    });
    r.put('/api/events/:id/state', async (req) => ({ state: await setState(ctx, uid(req), P(req).id, parse(stateInput, req.body)) }));
    r.post('/api/events/:id/feedback', async (req) => {
      const body = parse(z.object({ kind: z.enum(['less_similar', 'more_similar']) }), req.body);
      await addFeedback(ctx, uid(req), P(req).id, body.kind);
      return { ok: true };
    });
    r.delete('/api/feedback', async (req) => {
      await clearFeedback(ctx, uid(req));
      return { ok: true };
    });
    r.get('/api/events/:id/ics', async (req, reply) => {
      reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', `attachment; filename="event-${P(req).id}.ics"`);
      return eventIcs(ctx, uid(req), P(req).id);
    });

    // ------------------------------------------------------------ bookings
    r.post('/api/events/:id/bookings', async (req) => ({ booking: await addBooking(ctx, uid(req), P(req).id, parse(bookingInput, req.body)) }));
    r.put('/api/bookings/:id', async (req) => ({ booking: await updateBooking(ctx, uid(req), P(req).id, parse(bookingInput, req.body)) }));
    r.delete('/api/bookings/:id', async (req) => {
      await deleteBooking(ctx, uid(req), P(req).id);
      return { ok: true };
    });
    r.post('/api/bookings/quick', async (req) => ({ id: await quickBooking(ctx, uid(req), parse(quickBookingInput, req.body)) }));

    // --------------------------------------------------------------- plans
    r.get('/api/plans', async (req) => ({ plans: await ctx.db.selectFrom('personal_plans').selectAll().where('user_id', '=', uid(req)).orderBy('start_utc').execute() }));
    r.post('/api/plans', async (req) => ({ id: await savePlan(ctx, uid(req), parse(planInput, req.body)) }));
    r.put('/api/plans/:id', async (req) => ({ id: await savePlan(ctx, uid(req), parse(planInput, req.body), P(req).id) }));
    r.delete('/api/plans/:id', async (req) => {
      await ctx.db.deleteFrom('personal_plans').where('id', '=', P(req).id).where('user_id', '=', uid(req)).execute();
      return { ok: true };
    });

    // ------------------------------------------------------------ calendar
    r.get('/api/calendar', async (req) => {
      const q = req.query as Record<string, string>;
      return calendarWithClashes(ctx, uid(req), { from: q.from, to: q.to, includeInterested: q.include_interested === '1' });
    });
    r.get('/api/calendar/history', async (req) => ({ items: await history(ctx, uid(req)) }));
    r.post('/api/calendar/clashes/review', async (req) => {
      const body = parse(z.object({ a: z.string(), b: z.string(), decision: z.enum(['keep_both', 'unreviewed']) }), req.body);
      await reviewClash(ctx, uid(req), body.a, body.b, body.decision);
      return { ok: true };
    });
    r.get('/api/calendar.ics', async (req, reply) => {
      const q = req.query as Record<string, string>;
      reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', 'attachment; filename="my-calendar.ics"');
      return calendarIcs(ctx, uid(req), q.include_interested === '1');
    });

    // ------------------------------------------------------------- artists
    r.get('/api/artists', async (req) => ({ artists: await artistsOverview(ctx, uid(req)) }));
    r.get('/api/artists/:id', async (req) => artistDetail(ctx, uid(req), P(req).id));
    r.get('/api/watchlist', async (req) => ({ artists: await listWatchlist(ctx, uid(req)) }));
    r.post('/api/watchlist', async (req) => ({ id: await addToWatchlist(ctx, uid(req), parse(watchInput, req.body)) }));
    r.put('/api/watchlist/:id', async (req) => {
      await updateWatch(ctx, uid(req), P(req).id, parse(watchInput, req.body));
      return { ok: true };
    });
    r.delete('/api/watchlist/:id', async (req) => {
      await removeWatch(ctx, uid(req), P(req).id);
      return { ok: true };
    });

    // --------------------------------------------------- festivals / ibiza
    r.get('/api/festivals', async (req) => {
      const q = req.query as Record<string, unknown>;
      return festivals(ctx, uid(req), { ...filtersFromQuery(q), festivalScope: q.festival_scope === 'nearby' ? 'nearby' : 'europe' });
    });
    r.get('/api/ibiza', async (req) => {
      const q = req.query as Record<string, string>;
      const season = Number(q.season) || new Date().getFullYear();
      const stay = q.stay_from && q.stay_to ? { from: q.stay_from, to: q.stay_to } : null;
      return ibiza(ctx, uid(req), season, stay);
    });
    r.get('/api/ibiza/stays', async (req) => ({ stays: await ctx.db.selectFrom('ibiza_stays').selectAll().where('user_id', '=', uid(req)).orderBy('start_date').execute() }));
    r.post('/api/ibiza/stays', async (req) => {
      const body = parse(z.object({ label: z.string().max(100).nullable().optional(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).refine((v) => v.end_date >= v.start_date, 'The stay must end on or after it starts'), req.body);
      const id = newId('stay');
      await ctx.db.insertInto('ibiza_stays').values({ id, user_id: uid(req), label: body.label ?? null, start_date: body.start_date, end_date: body.end_date, created_at: nowIso() }).execute();
      return { id };
    });
    r.delete('/api/ibiza/stays/:id', async (req) => {
      await ctx.db.deleteFrom('ibiza_stays').where('id', '=', P(req).id).where('user_id', '=', uid(req)).execute();
      return { ok: true };
    });

    r.get('/api/cities', async (req) => ({ cities: await citiesSummary(ctx, uid(req)) }));
    r.get('/api/venues/:id', async (req) => venueEvents(ctx, uid(req), P(req).id));
    r.get('/api/search', async (req) => search(ctx, uid(req), String((req.query as Record<string, string>).q ?? '')));

    // --------------------------------------------------------- preferences
    r.get('/api/preferences', async (req) => getPreferences(ctx, uid(req)));
    r.put('/api/preferences', async (req) => {
      const body = parse(z.object({ data: preferencesSchema, version: z.number().int().min(0) }), req.body);
      const cur = await getPreferences(ctx, uid(req));
      if (cur.version !== body.version) throw new HttpError(409, 'Preferences were changed on another device. Reload and try again.', cur);
      return savePreferences(ctx, uid(req), body.data);
    });

    // ---------------------------------------------------------------- feed
    r.get('/api/feed', async (req) => listFeed(ctx, uid(req)));
    r.post('/api/feed/read', async (req) => {
      const body = parse(z.object({ ids: z.union([z.array(z.string()), z.literal('all')]) }), req.body);
      await markFeedRead(ctx, uid(req), body.ids);
      return { ok: true };
    });

    r.get('/api/notifications/status', async (req) => emailStatus(ctx, uid(req)));
    r.post('/api/notifications/test', async (req) => {
      const { data } = await getPreferences(ctx, uid(req));
      const to = data.notifications.email.address ?? req.user!.email;
      return sendTestEmail(ctx, uid(req), to);
    });
    r.post('/api/notifications/send-pending', async (req) => sendPendingEmails(ctx, uid(req)));

    // ------------------------------------------------------ research jobs
    r.post('/api/runs', async (req) => {
      const body = parse(z.object({ type: z.enum(['discovery', 'verification', 'adhoc']).default('adhoc'), params: z.record(z.string(), z.unknown()).optional() }), req.body);
      const pending = await ctx.db.selectFrom('research_runs').select('id').where('type', '=', body.type).where('status', 'in', ['queued', 'running']).executeTakeFirst();
      if (pending) return { run: serializeRun(await getRun(ctx, pending.id)), existing: true };
      return { run: serializeRun(await createRun(ctx, { type: body.type, trigger: 'user', userId: uid(req), params: body.params ?? { requested: 'search-now' } })), existing: false };
    });
    r.get('/api/runs/:id', async (req) => {
      const run = await getRun(ctx, P(req).id);
      const errors = await ctx.db.selectFrom('run_errors').selectAll().where('run_id', '=', run.id).orderBy('created_at').limit(200).execute();
      return { run: serializeRun(run), errors };
    });
    r.post('/api/runs/:id/cancel', async (req) => ({ run: serializeRun(await cancelRun(ctx, P(req).id)) }));

    r.post('/api/import', async (req) => {
      const run = await createRun(ctx, { type: 'import', trigger: 'manual_import', userId: uid(req), status: 'running', executor: 'Manual import' });
      try {
        const result = await importBatch(ctx, { ...(req.body as object), run_id: run.id }, { actor: 'user', runId: run.id });
        const { completeRun } = await import('../services/runs');
        const body = req.body as { coverage?: never };
        await completeRun(ctx, run.id, { outcome: result.counts.error ? 'partial' : 'success', summary: `Manual import: ${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.unchanged} unchanged, ${result.counts.error} errors`, coverage: body.coverage });
        return result;
      } catch (e) {
        const { failRun } = await import('../services/runs');
        await failRun(ctx, run.id, { error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
        throw e;
      }
    });

    r.get('/api/research-tokens', async () => ({
      tokens: await ctx.db.selectFrom('api_tokens').select(['id', 'name', 'token_prefix', 'created_at', 'last_used_at', 'revoked_at']).orderBy('created_at', 'desc').execute(),
    }));
    r.post('/api/research-tokens', async (req) => {
      const body = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
      return createApiToken(ctx, body.name, uid(req));
    });
    r.delete('/api/research-tokens/:id', async (req) => {
      await ctx.db.updateTable('api_tokens').set({ revoked_at: nowIso() }).where('id', '=', P(req).id).execute();
      return { ok: true };
    });

    // ---------------------------------------------------------- your data
    r.get('/api/export', async (req, reply) => {
      const data = await exportPersonal(ctx, uid(req));
      reply.header('content-disposition', `attachment; filename="personal-data-${nowIso().slice(0, 10)}.json"`);
      return data;
    });
    r.post('/api/import-personal', async (req) => {
      const q = req.query as Record<string, string>;
      return importPersonal(ctx, uid(req), req.body, { dryRun: q.dry_run === '1', replacePreferences: q.replace_preferences === '1' });
    });

    r.post('/api/demo', async () => ({ result: await loadDemo(ctx) }));
    r.delete('/api/demo', async () => removeDemo(ctx));

    r.get('/api/settings/server', async () => ({
      database: ctx.dialect,
      public_url: ctx.config.publicUrl,
      scheduler_enabled: ctx.config.schedulerEnabled,
      webhook_configured: !!ctx.config.researchWebhookUrl,
      link_extraction: ctx.config.allowLinkExtraction,
      demo_loaded_at: await getSetting(ctx, 'demo_loaded_at', null),
      version: process.env.npm_package_version ?? '1.0.0',
    }));
  });

  void parseJson;
}
