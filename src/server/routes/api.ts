// App API.
// - Read routes are open: browsing needs no sign-in.
// - Write routes change central data and require an unlocked editor session.
// Personal planning data (favourites, statuses, notes, bookings, plans) lives on each
// device and never reaches these routes, except the optional shared priority list.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { preferencesSchema } from '../../shared/preferences';
import { CATEGORY_GROUPS, GENRES, HUBS, IBIZA } from '../../shared/taxonomy';
import {
  authenticateEditor,
  checkLoginThrottle,
  clearLoginFailures,
  createApiToken,
  createSession,
  editingConfigured,
  recordLoginFailure,
  SESSION_COOKIE,
  setEditorPassword,
  setSessionCookie,
  siteId,
  verifyPassword,
} from '../auth';
import type { AppContext } from '../context';
import { HttpError, nowIso, parseJson } from '../util';
import { artistDetail, artistsOverview, citiesSummary, festivals, ibiza, search, venueEvents } from '../services/browse';
import { getEventDetail, listEvents, type ListFilters } from '../services/events';
import { extractFromUrl } from '../services/extract';
import { listFeed } from '../services/feed';
import { getSetting, importBatch } from '../services/import';
import { emailStatus, sendPendingEmails, sendTestEmail } from '../services/notify';
import { addToWatchlist, deleteManualEvent, listWatchlist, priorityInput, removeWatch, saveManualEvent, setPriorityEvents, updateWatch, watchInput } from '../services/personal';
import { getPreferences, savePreferences } from '../services/preferences';
import { cancelRun, completeRun, createRun, failRun, getRun, researchStatus, serializeRun } from '../services/runs';
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
    ids: list(q.ids),
    includeOccurrences: boolQ(q.occurrences),
    includePast: boolQ(q.include_past),
    sort: ['date', 'relevance', 'recent'].includes(String(q.sort)) ? (q.sort as ListFilters['sort']) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  };
}

/** Public view of preferences: no notification address. */
function publicPrefs(p: Awaited<ReturnType<typeof getPreferences>>) {
  const { notifications, ...rest } = p.data;
  return { data: { ...rest, notifications: { ...notifications, email: { ...notifications.email, address: notifications.email.address ? '(set)' : null } } }, version: p.version };
}

export async function apiRoutes(app: FastifyInstance, ctx: AppContext) {
  const site = () => siteId(ctx);
  const P = (req: FastifyRequest) => req.params as Record<string, string>;

  // CSRF defence for every write: browsers will not send this custom header cross-site
  // without a CORS preflight, which this server never grants.
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/research/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-quartet-csrf'] !== '1') {
      throw new HttpError(403, 'Missing request header');
    }
  });

  // ================================================================ open (no sign-in)

  app.get('/api/auth/state', async (req, reply) => {
    const editor = await authenticateEditor(ctx, req, reply);
    return { app_name: ctx.config.appName, editing_configured: await editingConfigured(ctx), editor: !!editor };
  });

  app.post('/api/auth/unlock', async (req, reply) => {
    const body = parse(z.object({ password: z.string().min(1).max(500) }), req.body);
    const key = `unlock|${req.ip}`;
    checkLoginThrottle(key);
    const id = await site();
    const row = await ctx.db.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow();
    if (!row.password_hash) throw new HttpError(409, 'Editing has not been set up on this server. Set EDITOR_PASSWORD and restart.');
    if (!(await verifyPassword(body.password, row.password_hash))) {
      recordLoginFailure(key);
      throw new HttpError(401, 'That passphrase is not correct');
    }
    clearLoginFailures(key);
    const s = await createSession(ctx, id, req.headers['user-agent']);
    setSessionCookie(ctx, reply, s.token, s.expires);
    return { editor: true };
  });

  app.get('/api/meta', async () => ({
    app_name: ctx.config.appName,
    category_groups: CATEGORY_GROUPS,
    genres: GENRES,
    hubs: HUBS.map((h) => ({ slug: h.slug, name: h.name, country: h.country })),
    ibiza: IBIZA,
    demo: await demoStatus(ctx),
  }));

  app.get('/api/status', async () => {
    const s = await researchStatus(ctx, await site());
    return { ...s, executor: { ...s.executor, active_tokens: undefined } };
  });

  app.get('/api/events', async (req) => listEvents(ctx, await site(), filtersFromQuery(req.query as Record<string, unknown>)));
  app.get('/api/events/:id', async (req) => getEventDetail(ctx, await site(), P(req).id));

  /** Changes to the given events since a time — lets each device flag changes to what it saved. */
  app.get('/api/changes', async (req) => {
    const q = req.query as Record<string, string>;
    const ids = list(q.ids)?.slice(0, 500) ?? [];
    if (!ids.length) return { changes: [] };
    let query = ctx.db
      .selectFrom('event_changes as c')
      .innerJoin('events as e', 'e.id', 'c.event_id')
      .select(['c.id', 'c.event_id', 'c.change_type', 'c.field', 'c.old_value', 'c.new_value', 'c.created_at', 'e.title'])
      .where('c.event_id', 'in', ids)
      .where('c.change_type', 'in', ['date_changed', 'venue_changed', 'status_changed', 'lineup_added', 'lineup_removed', 'ticket_sale', 'ticket_status']);
    if (q.since) query = query.where('c.created_at', '>', q.since);
    const rows = await query.orderBy('c.created_at', 'desc').limit(200).execute();
    return { changes: rows.map((r) => ({ ...r, old_value: parseJson(r.old_value, r.old_value), new_value: parseJson(r.new_value, r.new_value) })) };
  });

  app.get('/api/artists', async () => ({ artists: await artistsOverview(ctx, await site()) }));
  app.get('/api/artists/:id', async (req) => artistDetail(ctx, await site(), P(req).id));
  app.get('/api/watchlist', async () => ({ artists: await listWatchlist(ctx, await site()) }));

  app.get('/api/festivals', async (req) => {
    const q = req.query as Record<string, unknown>;
    return festivals(ctx, await site(), { ...filtersFromQuery(q), festivalScope: q.festival_scope === 'nearby' ? 'nearby' : 'europe' });
  });
  app.get('/api/ibiza', async (req) => {
    const q = req.query as Record<string, string>;
    const season = Number(q.season) || new Date().getFullYear();
    const stay = q.stay_from && q.stay_to ? { from: q.stay_from, to: q.stay_to } : null;
    return ibiza(ctx, await site(), season, stay);
  });
  app.get('/api/cities', async () => ({ cities: await citiesSummary(ctx, await site()) }));
  app.get('/api/venues/:id', async (req) => venueEvents(ctx, await site(), P(req).id));
  app.get('/api/search', async (req) => search(ctx, await site(), String((req.query as Record<string, string>).q ?? '')));
  app.get('/api/preferences', async () => publicPrefs(await getPreferences(ctx, await site())));
  app.get('/api/feed', async () => listFeed(ctx, await site()));
  app.get('/api/runs/:id', async (req) => {
    const run = await getRun(ctx, P(req).id);
    const errors = await ctx.db.selectFrom('run_errors').selectAll().where('run_id', '=', run.id).orderBy('created_at').limit(200).execute();
    return { run: serializeRun(run), errors };
  });

  /** Reading a pasted link is a convenience for adding your own entries; no data is stored. */
  app.post('/api/events/extract', async (req) => {
    if (!ctx.config.allowLinkExtraction) return { extracted: false, method: 'none', message: 'Reading links is turned off on this server. Fill in the form instead.', draft: {} };
    const body = parse(z.object({ url: z.url() }), req.body);
    return extractFromUrl(body.url);
  });

  // ================================================================ editor only

  app.register(async (r) => {
    r.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const editor = await authenticateEditor(ctx, req, reply);
      if (!editor) throw new HttpError(401, 'Unlock editing to change shared settings');
      req.editor = editor;
    });

    r.post('/api/auth/lock', async (req, reply) => {
      await ctx.db.deleteFrom('sessions').where('id', '=', req.editor!.session_id).execute();
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { editor: false };
    });
    r.post('/api/auth/password', async (req) => {
      const body = parse(z.object({ current: z.string(), next: z.string().min(10).max(500) }), req.body);
      const id = await site();
      const row = await ctx.db.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow();
      if (!(await verifyPassword(body.current, row.password_hash))) throw new HttpError(400, 'Current passphrase is incorrect');
      await setEditorPassword(ctx, body.next);
      await ctx.db.deleteFrom('sessions').where('id', '!=', req.editor!.session_id).execute();
      return { ok: true, env_override: !!ctx.config.editorPassword };
    });
    r.get('/api/auth/sessions', async (req) => {
      const rows = await ctx.db.selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'expires_at', 'user_agent']).orderBy('last_seen_at', 'desc').execute();
      return { sessions: rows.map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === req.editor!.session_id })) };
    });
    r.delete('/api/auth/sessions/:id', async (req) => {
      const rows = await ctx.db.selectFrom('sessions').select('id').execute();
      const target = rows.find((s) => s.id.startsWith(P(req).id));
      if (target) await ctx.db.deleteFrom('sessions').where('id', '=', target.id).execute();
      return { ok: true };
    });

    // Followed artists (central: shared by every device and read by research runs)
    r.post('/api/watchlist', async (req) => ({ id: await addToWatchlist(ctx, await site(), parse(watchInput, req.body)) }));
    r.put('/api/watchlist/:id', async (req) => {
      await updateWatch(ctx, await site(), P(req).id, parse(watchInput, req.body));
      return { ok: true };
    });
    r.delete('/api/watchlist/:id', async (req) => {
      await removeWatch(ctx, await site(), P(req).id);
      return { ok: true };
    });

    r.get('/api/preferences/full', async () => getPreferences(ctx, await site()));
    r.put('/api/preferences', async (req) => {
      const body = parse(z.object({ data: preferencesSchema, version: z.number().int().min(0) }), req.body);
      const id = await site();
      const cur = await getPreferences(ctx, id);
      if (cur.version !== body.version) throw new HttpError(409, 'Settings were changed on another device. Reload and try again.', publicPrefs(cur));
      return savePreferences(ctx, id, body.data);
    });

    // Shared listings added through the app
    r.post('/api/events', async (req) => ({ id: await saveManualEvent(ctx, await site(), req.body as never) }));
    r.put('/api/events/:id', async (req) => {
      const row = await ctx.db.selectFrom('events').select(['origin']).where('id', '=', P(req).id).executeTakeFirst();
      if (!row || row.origin !== 'manual') throw new HttpError(403, 'Only listings added through the app can be edited here; researched listings are updated by research.');
      return { id: await saveManualEvent(ctx, await site(), req.body as never, P(req).id) };
    });
    r.delete('/api/events/:id', async (req) => {
      await deleteManualEvent(ctx, P(req).id);
      return { ok: true };
    });

    /** Optional: a device shares which listings it is Going to or has booked (ids only). */
    r.put('/api/priority-events', async (req) => setPriorityEvents(ctx, parse(priorityInput, req.body)));

    r.get('/api/notifications/status', async () => emailStatus(ctx, await site()));
    r.post('/api/notifications/test', async () => {
      const id = await site();
      const { data } = await getPreferences(ctx, id);
      if (!data.notifications.email.address) return { ok: false, error: 'Add an email address first' };
      return sendTestEmail(ctx, id, data.notifications.email.address);
    });
    r.post('/api/notifications/send-pending', async () => sendPendingEmails(ctx, await site()));

    // Research jobs
    r.post('/api/runs', async (req) => {
      const body = parse(z.object({ type: z.enum(['discovery', 'verification', 'adhoc']).default('adhoc'), params: z.record(z.string(), z.unknown()).optional() }), req.body);
      const pending = await ctx.db.selectFrom('research_runs').select('id').where('type', '=', body.type).where('status', 'in', ['queued', 'running']).executeTakeFirst();
      if (pending) return { run: serializeRun(await getRun(ctx, pending.id)), existing: true };
      return { run: serializeRun(await createRun(ctx, { type: body.type, trigger: 'user', userId: await site(), params: body.params ?? { requested: 'search-now' } })), existing: false };
    });
    r.post('/api/runs/:id/cancel', async (req) => ({ run: serializeRun(await cancelRun(ctx, P(req).id)) }));

    r.post('/api/import', async (req) => {
      const run = await createRun(ctx, { type: 'import', trigger: 'manual_import', userId: await site(), status: 'running', executor: 'Manual import' });
      try {
        const body = req.body as { coverage?: never };
        const result = await importBatch(ctx, { ...(req.body as object), coverage: undefined, run_id: run.id }, { actor: 'user', runId: run.id });
        await completeRun(ctx, run.id, {
          outcome: result.counts.error ? 'partial' : 'success',
          summary: `Manual import: ${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.unchanged} unchanged, ${result.counts.error} errors`,
          coverage: body.coverage,
        });
        return result;
      } catch (e) {
        await failRun(ctx, run.id, { error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
        throw e;
      }
    });

    r.get('/api/research-tokens', async () => ({
      tokens: await ctx.db.selectFrom('api_tokens').select(['id', 'name', 'token_prefix', 'created_at', 'last_used_at', 'revoked_at']).orderBy('created_at', 'desc').execute(),
    }));
    r.post('/api/research-tokens', async (req) => {
      const body = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
      return createApiToken(ctx, body.name, await site());
    });
    r.delete('/api/research-tokens/:id', async (req) => {
      await ctx.db.updateTable('api_tokens').set({ revoked_at: nowIso() }).where('id', '=', P(req).id).execute();
      return { ok: true };
    });

    r.post('/api/demo', async () => ({ result: await loadDemo(ctx) }));
    r.delete('/api/demo', async () => removeDemo(ctx));

    r.get('/api/settings/server', async () => ({
      database: ctx.dialect,
      public_url: ctx.config.publicUrl,
      scheduler_enabled: ctx.config.schedulerEnabled,
      webhook_configured: !!ctx.config.researchWebhookUrl,
      link_extraction: ctx.config.allowLinkExtraction,
      editor_password_from_env: !!ctx.config.editorPassword,
      demo_loaded_at: await getSetting(ctx, 'demo_loaded_at', null),
      version: process.env.npm_package_version ?? '1.0.0',
    }));
  });
}
