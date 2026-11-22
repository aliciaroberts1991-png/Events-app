// Personal records: saved state, notes, bookings, manual events, personal plans,
// watchlist, feedback and Ibiza stays. The research API never writes these.
import { z } from 'zod';
import { resolveTimes } from '../../shared/dates';
import { eventInput, type EventInput } from '../../shared/research-schema';
import { PLAN_STATUSES } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import { b, HttpError, newId, normalize, nowIso, parseJson } from '../util';
import { getEventRow } from './events';
import { upsertArtist, upsertEvent, findArtist } from './import';

// ---------------------------------------------------------------- event state

export const stateInput = z.object({
  favourite: z.boolean().optional(),
  hidden: z.boolean().optional(),
  plan_status: z.enum(PLAN_STATUSES).optional(),
  occurrence_id: z.string().max(120).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  /** Optimistic concurrency: the version the client last saw (0 = no state yet). */
  version: z.number().int().min(0).optional(),
});

export async function getState(ctx: AppContext, userId: string, eventId: string) {
  return ctx.db.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('event_id', '=', eventId).executeTakeFirst();
}

export async function setState(ctx: AppContext, userId: string, eventId: string, input: z.infer<typeof stateInput>) {
  await getEventRow(ctx, eventId, userId);
  const t = nowIso();
  return ctx.db.transaction().execute(async (tx) => {
    const cur = await tx.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('event_id', '=', eventId).executeTakeFirst();
    if (input.version !== undefined && (cur?.version ?? 0) !== input.version) {
      throw new HttpError(409, 'This event was changed on another device. Reload to see the latest version.', { current: cur ?? null });
    }
    if (input.occurrence_id) {
      const occ = await tx.selectFrom('event_occurrences').select('id').where('id', '=', input.occurrence_id).where('event_id', '=', eventId).executeTakeFirst();
      if (!occ) throw new HttpError(400, 'That date is not one of this event’s dates');
    }
    const next = {
      favourite: input.favourite !== undefined ? b(input.favourite) : cur?.favourite ?? 0,
      hidden: input.hidden !== undefined ? b(input.hidden) : cur?.hidden ?? 0,
      plan_status: input.plan_status ?? cur?.plan_status ?? 'none',
      occurrence_id: input.occurrence_id !== undefined ? input.occurrence_id : cur?.occurrence_id ?? null,
      notes: input.notes !== undefined ? (input.notes?.trim() ? input.notes : null) : cur?.notes ?? null,
    };
    if (cur) {
      await tx
        .updateTable('user_event_state')
        .set({ ...next, version: cur.version + 1, updated_at: t })
        .where('user_id', '=', userId)
        .where('event_id', '=', eventId)
        .where('version', '=', cur.version)
        .execute();
    } else {
      await tx.insertInto('user_event_state').values({ user_id: userId, event_id: eventId, ...next, version: 1, created_at: t, updated_at: t }).execute();
    }
    return tx.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('event_id', '=', eventId).executeTakeFirstOrThrow();
  });
}

// ---------------------------------------------------------------- bookings

export const bookingInput = z.object({
  provider: z.string().max(200).nullable().optional(),
  amount: z.number().min(0).max(1_000_000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  quantity: z.number().int().min(1).max(100).nullable().optional(),
  ticket_type: z.string().max(200).nullable().optional(),
  links: z.array(z.url()).max(10).optional(),
  notes: z.string().max(5000).nullable().optional(),
  booked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function addBooking(ctx: AppContext, userId: string, eventId: string, input: z.infer<typeof bookingInput>, setBooked = true) {
  await getEventRow(ctx, eventId, userId);
  const t = nowIso();
  const id = newId('bkg');
  await ctx.db
    .insertInto('bookings')
    .values({
      id,
      user_id: userId,
      event_id: eventId,
      provider: input.provider ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      reference: input.reference ?? null,
      quantity: input.quantity ?? null,
      ticket_type: input.ticket_type ?? null,
      links: JSON.stringify(input.links ?? []),
      notes: input.notes ?? null,
      booked_on: input.booked_on ?? null,
      created_at: t,
      updated_at: t,
    })
    .execute();
  if (setBooked) await setState(ctx, userId, eventId, { plan_status: 'booked' });
  return ctx.db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function updateBooking(ctx: AppContext, userId: string, id: string, input: z.infer<typeof bookingInput>) {
  const row = await ctx.db.selectFrom('bookings').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw new HttpError(404, 'Booking not found');
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = k === 'links' ? JSON.stringify(v) : v;
  await ctx.db.updateTable('bookings').set(patch).where('id', '=', id).execute();
  return ctx.db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function deleteBooking(ctx: AppContext, userId: string, id: string) {
  const res = await ctx.db.deleteFrom('bookings').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!Number(res.numDeletedRows)) throw new HttpError(404, 'Booking not found');
}

// ---------------------------------------------------------------- manual events

export const manualEventInput = eventInput.omit({ ref: true, source_keys: true, highlight: true, prominence: true, verified_at: true, why_suits_me: true });

export async function saveManualEvent(ctx: AppContext, userId: string, input: EventInput, id?: string) {
  const parsed = manualEventInput.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'Please check the form', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data: EventInput = { ...parsed.data, id };
  if (data.sources) data.sources = data.sources.map((s) => ({ ...s, type: s.type ?? 'user' }));
  const res = await ctx.db.transaction().execute((tx) => upsertEvent(ctx, tx, data, { runId: null, isDemo: false, actor: 'user', ownerUserId: userId }));
  return res.id!;
}

export async function deleteManualEvent(ctx: AppContext, userId: string, id: string) {
  const row = await getEventRow(ctx, id, userId);
  if (row.origin !== 'manual' || row.owner_user_id !== userId) throw new HttpError(403, 'Only events you entered yourself can be deleted. Hide it instead.');
  await ctx.db.deleteFrom('events').where('id', '=', id).execute();
}

/** Move plans, notes and bookings from a manual entry onto a researched listing. */
export async function mergeManualInto(ctx: AppContext, userId: string, manualId: string, targetId: string) {
  const manual = await getEventRow(ctx, manualId, userId);
  if (manual.origin !== 'manual') throw new HttpError(400, 'Only a manual entry can be merged');
  const target = await getEventRow(ctx, targetId, userId);
  if (target.origin === 'manual') throw new HttpError(400, 'Choose a researched listing to merge into');
  const rank = (s: string) => PLAN_STATUSES.indexOf(s as (typeof PLAN_STATUSES)[number]);
  await ctx.db.transaction().execute(async (tx) => {
    const ms = await tx.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('event_id', '=', manualId).executeTakeFirst();
    const ts = await tx.selectFrom('user_event_state').selectAll().where('user_id', '=', userId).where('event_id', '=', targetId).executeTakeFirst();
    if (ms) {
      const notes = [ts?.notes, ms.notes].filter(Boolean).join('\n\n') || null;
      const status = rank(ms.plan_status) > rank(ts?.plan_status ?? 'none') ? ms.plan_status : ts?.plan_status ?? 'none';
      const t = nowIso();
      if (ts) {
        await tx
          .updateTable('user_event_state')
          .set({ plan_status: status, notes, favourite: ms.favourite || ts.favourite ? 1 : 0, version: ts.version + 1, updated_at: t })
          .where('user_id', '=', userId)
          .where('event_id', '=', targetId)
          .execute();
      } else {
        await tx
          .insertInto('user_event_state')
          .values({ user_id: userId, event_id: targetId, favourite: ms.favourite, hidden: 0, plan_status: status, occurrence_id: null, notes, version: 1, created_at: t, updated_at: t })
          .execute();
      }
    }
    await tx.updateTable('bookings').set({ event_id: targetId, updated_at: nowIso() }).where('event_id', '=', manualId).where('user_id', '=', userId).execute();
    await tx.deleteFrom('events').where('id', '=', manualId).execute();
  });
  return targetId;
}

export const quickBookingInput = z.object({
  title: z.string().trim().max(300).optional(),
  artist_name: z.string().trim().max(200).optional(),
  artist_id: z.string().max(60).optional(),
  format: z.enum(['live', 'dj_set', 'hybrid', 'av_show', 'b2b', 'talk', 'unknown']).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  venue_name: z.string().trim().max(200).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  city: z.string().trim().min(1).max(200),
  country: z.string().regex(/^[A-Z]{2}$/),
  timezone: z.string().optional(),
  categories: z.array(z.string()).optional(),
  genres: z.array(z.string()).optional(),
  source_url: z.url().nullable().optional(),
  booking: bookingInput.optional(),
  notes: z.string().max(10000).optional(),
});

/** "I've already booked this": creates the event, marks it booked and stores the booking. */
export async function quickBooking(ctx: AppContext, userId: string, input: z.infer<typeof quickBookingInput>) {
  let artistName = input.artist_name;
  if (input.artist_id) {
    const a = await ctx.db.selectFrom('artists').select(['name']).where('id', '=', input.artist_id).executeTakeFirst();
    if (!a) throw new HttpError(400, 'Unknown artist');
    artistName = a.name;
  }
  const title = input.title || artistName;
  if (!title) throw new HttpError(400, 'Give a title or an artist');
  const ev: EventInput = {
    title,
    start: input.time ? `${input.date}T${input.time}` : input.date,
    end: input.end_time ?? null,
    timezone: input.timezone,
    venue: { name: input.venue_name || input.city, address: input.address ?? null, city: input.city, country: input.country },
    categories: input.categories ?? ['concert'],
    genres: input.genres,
    lineup: artistName ? [{ ...(input.artist_id ? { artist_id: input.artist_id } : { name: artistName }), billing: 'headliner', format: input.format ?? 'unknown' }] : undefined,
    sources: input.source_url ? [{ url: input.source_url, type: 'user' }] : undefined,
  };
  const id = await saveManualEvent(ctx, userId, ev);
  await setState(ctx, userId, id, { plan_status: 'booked', notes: input.notes ?? null });
  await addBooking(ctx, userId, id, input.booking ?? {}, false);
  return id;
}

// ---------------------------------------------------------------- personal plans

export const planInput = z.object({
  title: z.string().trim().min(1).max(300),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/),
  end: z.string().regex(/^(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?|\d{2}:\d{2})$/).nullable().optional(),
  timezone: z.string().default('Europe/Bratislava'),
  location: z.string().max(300).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export async function savePlan(ctx: AppContext, userId: string, input: z.infer<typeof planInput>, id?: string) {
  let r;
  try {
    r = resolveTimes(input.start, input.end ?? null, input.timezone);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Invalid dates');
  }
  const t = nowIso();
  const vals = {
    title: input.title,
    start_local: r.startLocal,
    end_local: r.endLocal,
    timezone: input.timezone,
    start_utc: r.startUtc,
    end_utc: r.endUtc,
    start_time_known: b(r.startTimeKnown),
    end_time_known: b(r.endTimeKnown),
    location: input.location ?? null,
    notes: input.notes ?? null,
    updated_at: t,
  };
  if (id) {
    const res = await ctx.db.updateTable('personal_plans').set(vals).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!Number(res.numUpdatedRows)) throw new HttpError(404, 'Plan not found');
    return id;
  }
  const nid = newId('pln');
  await ctx.db.insertInto('personal_plans').values({ id: nid, user_id: userId, ...vals, created_at: t }).execute();
  return nid;
}

// ---------------------------------------------------------------- watchlist

export const watchInput = z.object({
  artist_id: z.string().max(60).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  links: z.record(z.string().max(40), z.url()).optional(),
  status: z.enum(['active', 'paused']).optional(),
  note: z.string().max(2000).nullable().optional(),
});

export async function listWatchlist(ctx: AppContext, userId: string) {
  const rows = await ctx.db
    .selectFrom('watchlist as w')
    .innerJoin('artists as a', 'a.id', 'w.artist_id')
    .select(['w.id', 'w.artist_id', 'w.status', 'w.note', 'w.added_at', 'w.updated_at', 'a.name', 'a.aliases', 'a.links', 'a.description', 'a.description_verified', 'a.genres', 'a.country'])
    .where('w.user_id', '=', userId)
    .orderBy('a.name')
    .execute();
  const keys = rows.length ? await ctx.db.selectFrom('artist_keys').selectAll().where('artist_id', 'in', rows.map((r) => r.artist_id)).execute() : [];
  return rows.map((r) => ({
    ...r,
    aliases: parseJson<string[]>(r.aliases, []),
    links: parseJson<Record<string, string>>(r.links, {}),
    genres: parseJson<string[]>(r.genres, []),
    description_verified: !!r.description_verified,
    keys: keys.filter((k) => k.artist_id === r.artist_id).map((k) => k.key),
  }));
}

export async function addToWatchlist(ctx: AppContext, userId: string, input: z.infer<typeof watchInput>) {
  return ctx.db.transaction().execute(async (tx) => {
    let artistId = input.artist_id;
    if (!artistId) {
      if (!input.name) throw new HttpError(400, 'Give an artist name');
      // An explicitly different identity (links) gets its own record instead of
      // merging into a similarly named act.
      const existing = await findArtist(tx, { name: input.name });
      const existingLinks = existing ? parseJson<Record<string, string>>(existing.links, {}) : {};
      const conflictingLinks =
        existing && input.links && Object.entries(input.links).some(([k, v]) => existingLinks[k] && existingLinks[k] !== v);
      if (existing && !conflictingLinks) {
        artistId = existing.id;
        await upsertArtist(tx, { id: existing.id, name: existing.name, aliases: input.aliases, links: input.links }, { isDemo: false, origin: 'user' });
      } else {
        const t = nowIso();
        artistId = newId('art');
        await tx
          .insertInto('artists')
          .values({
            id: artistId,
            name: input.name,
            normalized_name: normalize(input.name),
            aliases: JSON.stringify(input.aliases ?? []),
            description: null,
            description_source: null,
            description_verified: 0,
            genres: '[]',
            links: JSON.stringify(input.links ?? {}),
            country: null,
            origin: 'user',
            is_demo: 0,
            created_at: t,
            updated_at: t,
          })
          .execute();
      }
    }
    const cur = await tx.selectFrom('watchlist').selectAll().where('user_id', '=', userId).where('artist_id', '=', artistId).executeTakeFirst();
    const t = nowIso();
    if (cur) {
      await tx.updateTable('watchlist').set({ status: input.status ?? 'active', note: input.note ?? cur.note, updated_at: t }).where('id', '=', cur.id).execute();
      return cur.id;
    }
    const id = newId('wl');
    await tx.insertInto('watchlist').values({ id, user_id: userId, artist_id: artistId, status: input.status ?? 'active', note: input.note ?? null, added_at: t, updated_at: t }).execute();
    return id;
  });
}

export async function updateWatch(ctx: AppContext, userId: string, id: string, input: z.infer<typeof watchInput>) {
  const w = await ctx.db.selectFrom('watchlist').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!w) throw new HttpError(404, 'Not on your watchlist');
  const t = nowIso();
  await ctx.db.transaction().execute(async (tx) => {
    await tx
      .updateTable('watchlist')
      .set({ status: input.status ?? w.status, note: input.note !== undefined ? input.note : w.note, updated_at: t })
      .where('id', '=', id)
      .execute();
    const a = await tx.selectFrom('artists').selectAll().where('id', '=', w.artist_id).executeTakeFirstOrThrow();
    const patch: Record<string, unknown> = {};
    if (input.aliases) patch.aliases = JSON.stringify([...new Set(input.aliases)]);
    if (input.links) patch.links = JSON.stringify(input.links);
    if (input.name && input.name !== a.name && a.origin === 'user') {
      patch.name = input.name;
      patch.normalized_name = normalize(input.name);
    }
    if (Object.keys(patch).length) await tx.updateTable('artists').set({ ...patch, updated_at: t }).where('id', '=', a.id).execute();
  });
}

/** Removing an artist never touches saved events or bookings. */
export async function removeWatch(ctx: AppContext, userId: string, id: string) {
  const res = await ctx.db.deleteFrom('watchlist').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!Number(res.numDeletedRows)) throw new HttpError(404, 'Not on your watchlist');
}

// ---------------------------------------------------------------- feedback

export async function addFeedback(ctx: AppContext, userId: string, eventId: string, kind: 'less_similar' | 'more_similar') {
  await getEventRow(ctx, eventId, userId);
  const [cats, genres] = await Promise.all([
    ctx.db.selectFrom('event_categories').select('category').where('event_id', '=', eventId).execute(),
    ctx.db.selectFrom('event_genres').select('genre').where('event_id', '=', eventId).execute(),
  ]);
  await ctx.db
    .insertInto('feedback')
    .values({ id: newId('fb'), user_id: userId, event_id: eventId, kind, categories: JSON.stringify(cats.map((c) => c.category)), genres: JSON.stringify(genres.map((g) => g.genre)), created_at: nowIso() })
    .execute();
}

export async function clearFeedback(ctx: AppContext, userId: string) {
  await ctx.db.deleteFrom('feedback').where('user_id', '=', userId).execute();
}
