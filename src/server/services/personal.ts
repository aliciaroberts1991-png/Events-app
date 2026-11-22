// Personal records: saved state, notes, bookings, manual events, personal plans,
// watchlist, feedback and Ibiza stays. The research API never writes these.
import { z } from 'zod';
import { eventInput, type EventInput } from '../../shared/research-schema';
import type { AppContext } from '../context';
import { HttpError, newId, normalize, nowIso, parseJson } from '../util';
import { getEventRow } from './events';
import { upsertArtist, upsertEvent, findArtist } from './import';

// ---------------------------------------------------------------- manual events

export const manualEventInput = eventInput.omit({ ref: true, source_keys: true, highlight: true, prominence: true, verified_at: true, why_suits_me: true });

/** A listing added through the app by the editor. Shared, and never changed by research imports. */
export async function saveManualEvent(ctx: AppContext, userId: string, input: EventInput, id?: string) {
  const parsed = manualEventInput.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'Please check the form', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data: EventInput = { ...parsed.data, id };
  if (data.sources) data.sources = data.sources.map((s) => ({ ...s, type: s.type ?? 'user' }));
  const res = await ctx.db.transaction().execute((tx) => upsertEvent(ctx, tx, data, { runId: null, isDemo: false, actor: 'user', ownerUserId: userId }));
  return res.id!;
}

export async function deleteManualEvent(ctx: AppContext, id: string) {
  const row = await getEventRow(ctx, id);
  if (row.origin !== 'manual') throw new HttpError(403, 'Only listings added through the app can be deleted. Researched listings are kept.');
  await ctx.db.deleteFrom('events').where('id', '=', id).execute();
}

// ---------------------------------------------------------------- shared priority events

export const priorityInput = z.object({
  device_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  events: z.record(z.string().max(60), z.enum(['going', 'booked'])),
});

/**
 * A device can share which listings it is Going to or has booked (ids and status only,
 * never notes or booking details) so verification checks them first and alerts
 * about changes to them. Each device replaces its own set.
 */
export async function setPriorityEvents(ctx: AppContext, input: z.infer<typeof priorityInput>) {
  const ids = Object.keys(input.events).slice(0, 1000);
  const existing = ids.length ? await ctx.db.selectFrom('events').select('id').where('id', 'in', ids).execute() : [];
  const valid = new Set(existing.map((e) => e.id));
  const t = nowIso();
  await ctx.db.transaction().execute(async (tx) => {
    await tx.deleteFrom('priority_events').where('device_id', '=', input.device_id).execute();
    const rows = ids.filter((id) => valid.has(id)).map((id) => ({ device_id: input.device_id, event_id: id, status: input.events[id], updated_at: t }));
    for (let i = 0; i < rows.length; i += 200) await tx.insertInto('priority_events').values(rows.slice(i, i + 200)).execute();
  });
  return { shared: valid.size, ignored: ids.length - valid.size };
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

