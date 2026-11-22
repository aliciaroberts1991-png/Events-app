// Validated export and import of personal data (preferences, watchlist, saved
// statuses, notes, bookings, manual events, plans, clash reviews, feedback, stays).
// Event references carry ids plus identifying facts, so they can be matched in
// a fresh database after the research collection has been rebuilt.
import { z } from 'zod';
import { preferencesSchema } from '../../shared/preferences';
import { PLAN_STATUSES } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import { HttpError, newId, normalize, nowIso, parseJson } from '../util';
import { dedupeKey } from './import';
import { getPreferences, savePreferences } from './preferences';
import { addToWatchlist, saveManualEvent, savePlan } from './personal';

const eventRef = z.object({
  id: z.string(),
  title: z.string(),
  start_local: z.string(),
  city: z.string().nullable(),
  source_keys: z.array(z.string()).default([]),
});

export const exportSchema = z.object({
  format: z.literal('quartet-personal-export'),
  version: z.literal(1),
  exported_at: z.string(),
  preferences: z.unknown().optional(),
  watchlist: z
    .array(
      z.object({
        artist: z.object({ id: z.string(), name: z.string(), aliases: z.array(z.string()).default([]), links: z.record(z.string(), z.string()).default({}), keys: z.array(z.string()).default([]) }),
        status: z.enum(['active', 'paused']),
        note: z.string().nullable().optional(),
      }),
    )
    .default([]),
  manual_events: z.array(z.object({ id: z.string(), input: z.record(z.string(), z.unknown()) })).default([]),
  event_states: z
    .array(
      z.object({
        event: eventRef,
        favourite: z.boolean(),
        hidden: z.boolean(),
        plan_status: z.enum(PLAN_STATUSES),
        occurrence_id: z.string().nullable(),
        notes: z.string().nullable(),
      }),
    )
    .default([]),
  bookings: z
    .array(
      z.object({
        id: z.string(),
        event: eventRef,
        provider: z.string().nullable(),
        amount: z.number().nullable(),
        currency: z.string().nullable(),
        reference: z.string().nullable(),
        quantity: z.number().nullable(),
        ticket_type: z.string().nullable(),
        links: z.array(z.string()).default([]),
        notes: z.string().nullable(),
        booked_on: z.string().nullable(),
      }),
    )
    .default([]),
  plans: z
    .array(z.object({ id: z.string(), title: z.string(), start_local: z.string(), end_local: z.string().nullable(), timezone: z.string(), location: z.string().nullable(), notes: z.string().nullable() }))
    .default([]),
  clash_reviews: z.array(z.object({ item_a: z.string(), item_b: z.string(), decision: z.string() })).default([]),
  feedback: z.array(z.object({ event_id: z.string(), kind: z.string(), categories: z.array(z.string()), genres: z.array(z.string()), created_at: z.string() })).default([]),
  ibiza_stays: z.array(z.object({ label: z.string().nullable(), start_date: z.string(), end_date: z.string() })).default([]),
});
export type PersonalExport = z.infer<typeof exportSchema>;

async function refFor(ctx: AppContext, ids: string[]) {
  if (!ids.length) return new Map<string, z.infer<typeof eventRef>>();
  const rows = await ctx.db.selectFrom('events').select(['id', 'title', 'start_local', 'city']).where('id', 'in', ids).execute();
  const keys = await ctx.db.selectFrom('event_keys').selectAll().where('event_id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, { ...r, source_keys: keys.filter((k) => k.event_id === r.id).map((k) => k.key) }]));
}

export async function exportPersonal(ctx: AppContext, userId: string): Promise<PersonalExport> {
  const db = ctx.db;
  const [prefs, watch, states, bookings, plans, reviews, feedback, stays, manual] = await Promise.all([
    getPreferences(ctx, userId),
    db.selectFrom('watchlist as w').innerJoin('artists as a', 'a.id', 'w.artist_id').select(['w.status', 'w.note', 'a.id', 'a.name', 'a.aliases', 'a.links']).where('w.user_id', '=', userId).execute(),
    db.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('bookings').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('personal_plans').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('clash_reviews').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('feedback').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('ibiza_stays').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('events').selectAll().where('owner_user_id', '=', userId).where('origin', '=', 'manual').execute(),
  ]);
  const artistKeys = watch.length ? await db.selectFrom('artist_keys').selectAll().where('artist_id', 'in', watch.map((w) => w.id)).execute() : [];
  const refs = await refFor(ctx, [...new Set([...states.map((s) => s.event_id), ...bookings.map((b) => b.event_id)])]);

  const manualEvents = [];
  for (const m of manual) {
    const [cats, genres, lineup, venue, sources] = await Promise.all([
      db.selectFrom('event_categories').select('category').where('event_id', '=', m.id).execute(),
      db.selectFrom('event_genres').select('genre').where('event_id', '=', m.id).execute(),
      db.selectFrom('event_artists as ea').innerJoin('artists as a', 'a.id', 'ea.artist_id').select(['a.name', 'ea.billing', 'ea.performance_format', 'ea.appearance_date']).where('ea.event_id', '=', m.id).execute(),
      m.venue_id ? db.selectFrom('venues').selectAll().where('id', '=', m.venue_id).executeTakeFirst() : null,
      db.selectFrom('event_sources').select(['url', 'source_type', 'name']).where('event_id', '=', m.id).execute(),
    ]);
    const recurrence = parseJson(m.recurrence, null);
    manualEvents.push({
      id: m.id,
      input: {
        kind: m.kind,
        title: m.title,
        description: m.description,
        status: m.status,
        start: recurrence ? undefined : m.start_local,
        end: recurrence ? undefined : m.end_local,
        doors: m.doors_local,
        timezone: m.timezone,
        recurrence: recurrence ?? undefined,
        venue: venue ? { name: venue.name, address: venue.address, town: venue.town, city: venue.city, country: venue.country, lat: venue.lat, lng: venue.lng } : undefined,
        location_text: m.location_text,
        categories: cats.map((c) => c.category),
        genres: genres.map((g) => g.genre),
        lineup: lineup.map((l) => ({ name: l.name, billing: l.billing, format: l.performance_format, date: l.appearance_date })),
        languages: parseJson(m.languages, null),
        tickets: { url: m.ticket_url, price_min: m.price_min, price_max: m.price_max, currency: m.currency },
        sources: sources.map((s) => ({ url: s.url, type: s.source_type, name: s.name ?? undefined })),
      },
    });
  }

  return {
    format: 'quartet-personal-export',
    version: 1,
    exported_at: nowIso(),
    preferences: prefs.data,
    watchlist: watch.map((w) => ({
      artist: { id: w.id, name: w.name, aliases: parseJson(w.aliases, []), links: parseJson(w.links, {}), keys: artistKeys.filter((k) => k.artist_id === w.id).map((k) => k.key) },
      status: w.status as 'active' | 'paused',
      note: w.note,
    })),
    manual_events: manualEvents,
    event_states: states.filter((s) => refs.has(s.event_id)).map((s) => ({
      event: refs.get(s.event_id)!,
      favourite: !!s.favourite,
      hidden: !!s.hidden,
      plan_status: s.plan_status as (typeof PLAN_STATUSES)[number],
      occurrence_id: s.occurrence_id,
      notes: s.notes,
    })),
    bookings: bookings.filter((b) => refs.has(b.event_id)).map((b) => ({
      id: b.id,
      event: refs.get(b.event_id)!,
      provider: b.provider,
      amount: b.amount,
      currency: b.currency,
      reference: b.reference,
      quantity: b.quantity,
      ticket_type: b.ticket_type,
      links: parseJson(b.links, []),
      notes: b.notes,
      booked_on: b.booked_on,
    })),
    plans: plans.map((p) => ({ id: p.id, title: p.title, start_local: p.start_local, end_local: p.end_local, timezone: p.timezone, location: p.location, notes: p.notes })),
    clash_reviews: reviews.map((r) => ({ item_a: r.item_a, item_b: r.item_b, decision: r.decision })),
    feedback: feedback.map((f) => ({ event_id: f.event_id, kind: f.kind, categories: parseJson(f.categories, []), genres: parseJson(f.genres, []), created_at: f.created_at })),
    ibiza_stays: stays.map((s) => ({ label: s.label, start_date: s.start_date, end_date: s.end_date })),
  };
}

export interface ImportReport {
  dry_run: boolean;
  preferences: 'kept' | 'replaced';
  watchlist: { added: number; existing: number };
  manual_events: { created: number; existing: number; errors: string[] };
  event_states: { applied: number; unmatched: number; kept_newer: number };
  bookings: { added: number; duplicates: number; unmatched: number };
  plans: { added: number; duplicates: number };
  clash_reviews: number;
  feedback: number;
  ibiza_stays: { added: number; duplicates: number };
}

/**
 * Merge an export into the current account. Existing records win when they are
 * identical; duplicates are skipped; nothing is deleted.
 */
export async function importPersonal(ctx: AppContext, userId: string, raw: unknown, opts: { dryRun: boolean; replacePreferences: boolean }): Promise<ImportReport> {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, 'This file is not a valid personal export', parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data = parsed.data;
  const r: ImportReport = {
    dry_run: opts.dryRun,
    preferences: 'kept',
    watchlist: { added: 0, existing: 0 },
    manual_events: { created: 0, existing: 0, errors: [] },
    event_states: { applied: 0, unmatched: 0, kept_newer: 0 },
    bookings: { added: 0, duplicates: 0, unmatched: 0 },
    plans: { added: 0, duplicates: 0 },
    clash_reviews: 0,
    feedback: 0,
    ibiza_stays: { added: 0, duplicates: 0 },
  };
  const db = ctx.db;

  if (opts.replacePreferences && data.preferences) {
    const p = preferencesSchema.safeParse(data.preferences);
    if (!p.success) throw new HttpError(422, 'Preferences in the file are invalid');
    if (!opts.dryRun) await savePreferences(ctx, userId, p.data);
    r.preferences = 'replaced';
  }

  for (const w of data.watchlist) {
    const existing = await db
      .selectFrom('watchlist as wl')
      .innerJoin('artists as a', 'a.id', 'wl.artist_id')
      .select(['wl.id'])
      .where('wl.user_id', '=', userId)
      .where((x) => x.or([x('a.id', '=', w.artist.id), x('a.normalized_name', '=', normalize(w.artist.name))]))
      .executeTakeFirst();
    if (existing) {
      r.watchlist.existing++;
      continue;
    }
    r.watchlist.added++;
    if (!opts.dryRun) {
      const sameId = await db.selectFrom('artists').select('id').where('id', '=', w.artist.id).executeTakeFirst();
      await addToWatchlist(ctx, userId, sameId ? { artist_id: sameId.id, status: w.status, note: w.note ?? null } : { name: w.artist.name, aliases: w.artist.aliases, links: w.artist.links, status: w.status, note: w.note ?? null });
    }
  }

  // Manual events first, so states and bookings can point at them.
  const idMap = new Map<string, string>();
  for (const m of data.manual_events) {
    const exists = await db.selectFrom('events').select('id').where('id', '=', m.id).where('owner_user_id', '=', userId).executeTakeFirst();
    if (exists) {
      r.manual_events.existing++;
      idMap.set(m.id, m.id);
      continue;
    }
    const input = m.input as { title?: string; start?: string; venue?: { city?: string } };
    const dupe =
      input.title && input.start
        ? await db.selectFrom('events').select('id').where('owner_user_id', '=', userId).where('dedupe_key', '=', `manual:${dedupeKey(input.title, input.start, input.venue?.city)}`).executeTakeFirst()
        : undefined;
    if (dupe) {
      r.manual_events.existing++;
      idMap.set(m.id, dupe.id);
      continue;
    }
    if (opts.dryRun) {
      r.manual_events.created++;
      continue;
    }
    try {
      const clean = Object.fromEntries(Object.entries(m.input).filter(([, v]) => v !== undefined));
      const id = await saveManualEvent(ctx, userId, clean as never);
      idMap.set(m.id, id);
      r.manual_events.created++;
    } catch (e) {
      r.manual_events.errors.push(`${input.title ?? m.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const resolve = async (ref: z.infer<typeof eventRef>) => {
    if (idMap.has(ref.id)) return idMap.get(ref.id)!;
    const byId = await db.selectFrom('events').select('id').where('id', '=', ref.id).executeTakeFirst();
    if (byId) return byId.id;
    for (const k of ref.source_keys) {
      const hit = await db.selectFrom('event_keys').select('event_id').where('key', '=', k).executeTakeFirst();
      if (hit) return hit.event_id;
    }
    const hit = await db.selectFrom('events').select('id').where('dedupe_key', '=', dedupeKey(ref.title, ref.start_local, ref.city)).executeTakeFirst();
    return hit?.id ?? null;
  };

  const rank = (s: string) => PLAN_STATUSES.indexOf(s as (typeof PLAN_STATUSES)[number]);
  for (const s of data.event_states) {
    const id = await resolve(s.event);
    if (!id) {
      r.event_states.unmatched++;
      continue;
    }
    const cur = await db.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('event_id', '=', id).executeTakeFirst();
    if (cur && rank(cur.plan_status) >= rank(s.plan_status) && (cur.notes ?? '') === (s.notes ?? '') && !!cur.favourite === s.favourite && !!cur.hidden === s.hidden) {
      r.event_states.kept_newer++;
      continue;
    }
    r.event_states.applied++;
    if (opts.dryRun) continue;
    const t = nowIso();
    const merged = {
      favourite: cur?.favourite || s.favourite ? 1 : 0,
      hidden: cur?.hidden || s.hidden ? 1 : 0,
      plan_status: cur && rank(cur.plan_status) > rank(s.plan_status) ? cur.plan_status : s.plan_status,
      occurrence_id: cur?.occurrence_id ?? s.occurrence_id,
      notes: cur?.notes && s.notes && cur.notes !== s.notes ? `${cur.notes}\n\n${s.notes}` : cur?.notes ?? s.notes,
    };
    if (cur) await db.updateTable('user_event_state').set({ ...merged, version: cur.version + 1, updated_at: t }).where('user_id', '=', userId).where('event_id', '=', id).execute();
    else await db.insertInto('user_event_state').values({ user_id: userId, event_id: id, ...merged, version: 1, created_at: t, updated_at: t }).execute();
  }

  for (const bk of data.bookings) {
    const id = await resolve(bk.event);
    if (!id) {
      r.bookings.unmatched++;
      continue;
    }
    const existing = await db.selectFrom('bookings').selectAll().where('user_id', '=', userId).where('event_id', '=', id).execute();
    const dup = existing.some((e) => e.id === bk.id || ((e.reference ?? '') === (bk.reference ?? '') && (e.provider ?? '') === (bk.provider ?? '') && (e.amount ?? null) === (bk.amount ?? null)));
    if (dup) {
      r.bookings.duplicates++;
      continue;
    }
    r.bookings.added++;
    if (opts.dryRun) continue;
    const t = nowIso();
    await db
      .insertInto('bookings')
      .values({ id: newId('bkg'), user_id: userId, event_id: id, provider: bk.provider, amount: bk.amount, currency: bk.currency, reference: bk.reference, quantity: bk.quantity, ticket_type: bk.ticket_type, links: JSON.stringify(bk.links), notes: bk.notes, booked_on: bk.booked_on, created_at: t, updated_at: t })
      .execute();
  }

  for (const p of data.plans) {
    const dup = await db.selectFrom('personal_plans').select('id').where('user_id', '=', userId).where('title', '=', p.title).where('start_local', '=', p.start_local).executeTakeFirst();
    if (dup) {
      r.plans.duplicates++;
      continue;
    }
    r.plans.added++;
    if (!opts.dryRun) await savePlan(ctx, userId, { title: p.title, start: p.start_local, end: p.end_local, timezone: p.timezone, location: p.location, notes: p.notes });
  }

  for (const c of data.clash_reviews) {
    if (opts.dryRun) {
      r.clash_reviews++;
      continue;
    }
    const res = await db
      .insertInto('clash_reviews')
      .values({ id: newId('clr'), user_id: userId, item_a: c.item_a, item_b: c.item_b, decision: c.decision, reviewed_at: nowIso() })
      .onConflict((oc) => oc.columns(['user_id', 'item_a', 'item_b']).doNothing())
      .executeTakeFirst();
    r.clash_reviews += Number(res.numInsertedOrUpdatedRows ?? 0);
  }

  const existingFb = await db.selectFrom('feedback').select(['event_id', 'kind', 'created_at']).where('user_id', '=', userId).execute();
  for (const f of data.feedback) {
    if (existingFb.some((e) => e.event_id === f.event_id && e.kind === f.kind && e.created_at === f.created_at)) continue;
    r.feedback++;
    if (!opts.dryRun)
      await db.insertInto('feedback').values({ id: newId('fb'), user_id: userId, event_id: f.event_id, kind: f.kind, categories: JSON.stringify(f.categories), genres: JSON.stringify(f.genres), created_at: f.created_at }).execute();
  }

  for (const s of data.ibiza_stays) {
    const dup = await db.selectFrom('ibiza_stays').select('id').where('user_id', '=', userId).where('start_date', '=', s.start_date).where('end_date', '=', s.end_date).executeTakeFirst();
    if (dup) {
      r.ibiza_stays.duplicates++;
      continue;
    }
    r.ibiza_stays.added++;
    if (!opts.dryRun) await db.insertInto('ibiza_stays').values({ id: newId('stay'), user_id: userId, label: s.label, start_date: s.start_date, end_date: s.end_date, created_at: nowIso() }).execute();
  }
  return r;
}
