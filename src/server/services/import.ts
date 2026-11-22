// Research import engine.
//
// Guarantees
// - Idempotent: the same payload (or the same idempotency key) can be sent any
//   number of times; unchanged items are reported as "unchanged".
// - Partial: absent fields keep their stored value; null clears a field.
// - Atomic per item: each record is written in its own transaction, so an
//   interrupted batch leaves every record either fully applied or untouched,
//   and re-sending the batch completes it.
// - Personal records (state, notes, bookings, plans, manual events) are never
//   touched here.
import type { Selectable, Transaction } from 'kysely';
import { expandRecurrence, resolveTimes, type RecurrenceRule } from '../../shared/dates';
import {
  importPayload,
  type ArtistInput,
  type EventInput,
  type FestivalSeriesInput,
  type ImportPayload,
  type LineupInput,
  type ResidencyInput,
  type VenueInput,
  type VerificationInput,
} from '../../shared/research-schema';
import { CATEGORY_BY_SLUG, GENRE_BY_SLUG } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import type { Database, EventsTable } from '../db/types';
import { b, HttpError, newId, normalize, nowIso, parseJson, sha256, stableStringify, toJson } from '../util';
import { generateFeedForChanges, type EventChangeSummary } from './feed';
import { COUNTRY_TIMEZONES, nearestHub } from './geo';

type Tx = Transaction<Database>;
type EventRow = Selectable<EventsTable>;

export interface ItemResult {
  type: 'artist' | 'festival' | 'residency' | 'event' | 'verification';
  ref?: string;
  index: number;
  status: 'created' | 'updated' | 'unchanged' | 'error';
  id?: string;
  changes?: string[];
  warnings?: string[];
  error?: string;
  matched_by?: string;
}

export interface ImportResult {
  batch_id: string;
  idempotency_key: string | null;
  replayed: boolean;
  run_id: string | null;
  counts: Record<'created' | 'updated' | 'unchanged' | 'error', number>;
  items: ItemResult[];
  feed_items_created: number;
}

export interface ImportOptions {
  runId?: string | null;
  /** 'research' for API tokens, 'user' for manual JSON import from the UI. */
  actor: 'research' | 'user';
  isDemo?: boolean;
}

export async function importBatch(ctx: AppContext, raw: unknown, opts: ImportOptions): Promise<ImportResult> {
  const parsed = importPayload.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'Payload failed validation', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const payload = parsed.data;
  const runId = payload.run_id ?? opts.runId ?? null;
  if (runId) {
    const run = await ctx.db.selectFrom('research_runs').select(['id', 'status']).where('id', '=', runId).executeTakeFirst();
    if (!run) throw new HttpError(404, `Run ${runId} not found`);
    if (run.status !== 'running') throw new HttpError(409, `Run ${runId} is ${run.status}; imports need a running run (or omit run_id)`);
  }

  const { idempotency_key: key, ...rest } = payload;
  const hash = sha256(stableStringify(rest));
  const itemCount =
    (payload.events?.length ?? 0) + (payload.artists?.length ?? 0) + (payload.festivals?.length ?? 0) + (payload.residencies?.length ?? 0) + (payload.verifications?.length ?? 0);

  let batchId = newId('imp');
  if (key) {
    const existing = await ctx.db.selectFrom('import_batches').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
    if (existing) {
      if (existing.payload_hash !== hash) throw new HttpError(409, 'This idempotency_key was already used with a different payload');
      if (existing.status === 'completed' && existing.result) {
        return { ...(JSON.parse(existing.result) as ImportResult), replayed: true };
      }
      batchId = existing.id; // interrupted earlier: process again (safe, items are idempotent)
    } else {
      await ctx.db
        .insertInto('import_batches')
        .values({ id: batchId, idempotency_key: key, payload_hash: hash, run_id: runId, status: 'processing', item_count: itemCount, result: null, received_at: nowIso(), completed_at: null })
        .execute();
    }
  }

  const items: ItemResult[] = [];
  const changeSummaries: EventChangeSummary[] = [];
  const isDemo = !!opts.isDemo;

  const run = async <T>(
    type: ItemResult['type'],
    list: T[] | undefined,
    fn: (tx: Tx, item: T) => Promise<Omit<ItemResult, 'type' | 'index' | 'ref'> & { summary?: EventChangeSummary }>,
  ) => {
    for (const [index, item] of (list ?? []).entries()) {
      const ref = (item as { ref?: string }).ref;
      try {
        const r = await ctx.db.transaction().execute((tx) => fn(tx, item));
        if (r.summary) changeSummaries.push(r.summary);
        delete r.summary;
        items.push({ type, index, ...(ref ? { ref } : {}), ...r });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        items.push({ type, index, ...(ref ? { ref } : {}), status: 'error', error: message });
        if (runId) {
          await ctx.db.insertInto('run_errors').values({ id: newId('rer'), run_id: runId, item_ref: ref ?? `${type}[${index}]`, message, created_at: nowIso() }).execute();
        }
      }
    }
  };

  await run('artist', payload.artists, (tx, a) => upsertArtist(tx, a, { isDemo, origin: opts.actor === 'user' ? 'user' : 'research' }));
  await run('festival', payload.festivals, (tx, f) => upsertFestivalSeries(tx, f, isDemo));
  await run('residency', payload.residencies, (tx, r) => upsertResidency(tx, r, isDemo));
  await run('event', payload.events, (tx, e) => upsertEvent(ctx, tx, e, { runId, isDemo, actor: opts.actor }));
  await run('verification', payload.verifications, (tx, v) => applyVerification(ctx, tx, v, runId));

  const counts = { created: 0, updated: 0, unchanged: 0, error: 0 };
  for (const i of items) counts[i.status]++;

  const feedCreated = await generateFeedForChanges(ctx, changeSummaries);

  const result: ImportResult = { batch_id: batchId, idempotency_key: key ?? null, replayed: false, run_id: runId, counts, items, feed_items_created: feedCreated };

  if (key) {
    await ctx.db
      .updateTable('import_batches')
      .set({ status: 'completed', result: JSON.stringify(result), completed_at: nowIso(), run_id: runId })
      .where('id', '=', batchId)
      .execute();
  }
  if (runId) {
    const r = await ctx.db.selectFrom('research_runs').select(['stats']).where('id', '=', runId).executeTakeFirst();
    const stats = parseJson<Record<string, number>>(r?.stats, {});
    for (const [k, v] of Object.entries(counts)) stats[k] = (stats[k] ?? 0) + v;
    stats.batches = (stats.batches ?? 0) + 1;
    await ctx.db.updateTable('research_runs').set({ stats: JSON.stringify(stats), heartbeat_at: nowIso(), updated_at: nowIso() }).where('id', '=', runId).execute();
  }
  // Demo data never counts as a real update.
  if (!isDemo && counts.created + counts.updated + counts.unchanged > 0) {
    await setSetting(ctx, 'last_successful_import_at', nowIso());
  }
  return result;
}

export async function setSetting(ctx: AppContext | { db: Tx }, key: string, value: unknown) {
  const v = JSON.stringify(value);
  const t = nowIso();
  await ctx.db
    .insertInto('app_settings')
    .values({ key, value: v, updated_at: t })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: v, updated_at: t }))
    .execute();
}

export async function getSetting<T>(ctx: AppContext, key: string, fallback: T): Promise<T> {
  const r = await ctx.db.selectFrom('app_settings').select('value').where('key', '=', key).executeTakeFirst();
  return r ? parseJson<T>(r.value, fallback) : fallback;
}

// ---------------------------------------------------------------- artists

export async function findArtist(tx: Tx, ref: { artist_id?: string; artist_key?: string; name?: string; keys?: string[] }) {
  if (ref.artist_id) {
    const a = await tx.selectFrom('artists').selectAll().where('id', '=', ref.artist_id).executeTakeFirst();
    if (!a) throw new Error(`Unknown artist_id ${ref.artist_id}`);
    return a;
  }
  for (const key of [ref.artist_key, ...(ref.keys ?? [])].filter(Boolean) as string[]) {
    const k = await tx.selectFrom('artist_keys').select('artist_id').where('key', '=', key).executeTakeFirst();
    if (k) return tx.selectFrom('artists').selectAll().where('id', '=', k.artist_id).executeTakeFirstOrThrow();
  }
  if (ref.name) {
    const n = normalize(ref.name);
    const exact = await tx.selectFrom('artists').selectAll().where('normalized_name', '=', n).orderBy('created_at').execute();
    if (exact.length) {
      // Prefer an artist the owner follows when several share a name.
      if (exact.length > 1) {
        const watched = await tx.selectFrom('watchlist').select('artist_id').where('artist_id', 'in', exact.map((x) => x.id)).execute();
        const w = exact.find((x) => watched.some((y) => y.artist_id === x.id));
        if (w) return w;
      }
      return exact[0];
    }
    // Alias match.
    const candidates = await tx.selectFrom('artists').selectAll().where('aliases', 'like', `%${ref.name.replace(/[%_]/g, '')}%`).execute();
    const viaAlias = candidates.find((c) => parseJson<string[]>(c.aliases, []).some((al) => normalize(al) === n));
    if (viaAlias) return viaAlias;
  }
  return null;
}

export async function upsertArtist(tx: Tx, a: ArtistInput, opts: { isDemo: boolean; origin: string }) {
  const existing = await findArtist(tx, { artist_id: a.id, keys: a.keys, name: a.name });
  const t = nowIso();
  const warnings: string[] = [];
  const genres = (a.genres ?? []).filter((g) => {
    if (!GENRE_BY_SLUG.has(g)) warnings.push(`Unknown genre "${g}" stored as a free tag`);
    return /^[a-z0-9-]+$/.test(g);
  });
  if (!existing) {
    const id = newId('art');
    await tx
      .insertInto('artists')
      .values({
        id,
        name: a.name,
        normalized_name: normalize(a.name),
        aliases: JSON.stringify(a.aliases ?? []),
        description: a.description ?? null,
        description_source: a.description_source ?? null,
        description_verified: b(!!a.description && opts.origin === 'research'),
        genres: JSON.stringify(genres),
        links: JSON.stringify(a.links ?? {}),
        country: a.country ?? null,
        origin: opts.isDemo ? 'demo' : opts.origin,
        is_demo: b(opts.isDemo),
        created_at: t,
        updated_at: t,
      })
      .execute();
    await addKeys(tx, 'artist_keys', 'artist_id', id, a.keys ?? [], warnings);
    return { status: 'created' as const, id, warnings: warnings.length ? warnings : undefined };
  }
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  const aliases = [...new Set([...parseJson<string[]>(existing.aliases, []), ...(a.aliases ?? [])])];
  if (JSON.stringify(aliases) !== existing.aliases) (patch.aliases = JSON.stringify(aliases)), changes.push('aliases');
  const links = { ...parseJson<Record<string, string>>(existing.links, {}), ...(a.links ?? {}) };
  if (JSON.stringify(links) !== existing.links) (patch.links = JSON.stringify(links)), changes.push('links');
  if (a.genres) {
    const g = [...new Set([...parseJson<string[]>(existing.genres, []), ...genres])];
    if (JSON.stringify(g) !== existing.genres) (patch.genres = JSON.stringify(g)), changes.push('genres');
  }
  if (a.description !== undefined && a.description !== existing.description) {
    patch.description = a.description;
    patch.description_verified = b(opts.origin === 'research' && !!a.description);
    changes.push('description');
  }
  if (a.description_source !== undefined && a.description_source !== existing.description_source) (patch.description_source = a.description_source), changes.push('description_source');
  if (a.country !== undefined && a.country !== existing.country) (patch.country = a.country), changes.push('country');
  await addKeys(tx, 'artist_keys', 'artist_id', existing.id, a.keys ?? [], warnings);
  if (changes.length) await tx.updateTable('artists').set({ ...patch, updated_at: t }).where('id', '=', existing.id).execute();
  return { status: changes.length ? ('updated' as const) : ('unchanged' as const), id: existing.id, changes, warnings: warnings.length ? warnings : undefined };
}

async function addKeys(
  tx: Tx,
  table: 'artist_keys' | 'festival_keys' | 'residency_keys' | 'event_keys',
  col: 'artist_id' | 'series_id' | 'residency_id' | 'event_id',
  id: string,
  keys: string[],
  warnings: string[],
) {
  for (const key of keys) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = (await (tx as any).selectFrom(table).selectAll().where('key', '=', key).executeTakeFirst()) as Record<string, string> | undefined;
    if (existing) {
      if (existing[col] !== id) warnings.push(`Source key "${key}" already belongs to ${existing[col]}; not reassigned`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).insertInto(table).values({ key, [col]: id }).execute();
  }
}

// ---------------------------------------------------------------- venues

export async function resolveVenue(tx: Tx, v: VenueInput, isDemo: boolean): Promise<{ id: string; row: Selectable<Database['venues']> }> {
  let row = v.key ? await tx.selectFrom('venues').selectAll().where('source_key', '=', v.key).executeTakeFirst() : undefined;
  if (!row) {
    const cands = await tx.selectFrom('venues').selectAll().where('normalized_name', '=', normalize(v.name)).execute();
    row = cands.find((c) => !v.city || !c.city || normalize(c.city) === normalize(v.city)) ?? undefined;
  }
  const t = nowIso();
  if (!row) {
    const id = newId('ven');
    const values = {
      id,
      name: v.name,
      normalized_name: normalize(v.name),
      address: v.address ?? null,
      town: v.town ?? null,
      city: v.city ?? null,
      region: v.region ?? null,
      country: v.country ?? null,
      lat: v.lat ?? null,
      lng: v.lng ?? null,
      timezone: v.timezone ?? (v.country ? COUNTRY_TIMEZONES[v.country] ?? null : null),
      website: v.website ?? null,
      source_key: v.key ?? null,
      is_demo: b(isDemo),
      created_at: t,
      updated_at: t,
    };
    await tx.insertInto('venues').values(values).execute();
    return { id, row: values };
  }
  const patch: Record<string, unknown> = {};
  for (const f of ['address', 'town', 'city', 'region', 'country', 'lat', 'lng', 'website', 'timezone'] as const) {
    const val = v[f];
    if (val !== undefined && val !== row[f]) patch[f] = val;
  }
  if (v.key && !row.source_key) patch.source_key = v.key;
  if (Object.keys(patch).length) {
    await tx.updateTable('venues').set({ ...patch, updated_at: t }).where('id', '=', row.id).execute();
    row = { ...row, ...patch } as typeof row;
  }
  return { id: row.id, row };
}

// ---------------------------------------------------------------- festivals

async function upsertFestivalSeries(tx: Tx, f: FestivalSeriesInput, isDemo: boolean) {
  const warnings: string[] = [];
  const existing = await findFestivalSeries(tx, { series_id: f.id, keys: f.keys, name: f.name });
  const t = nowIso();
  if (!existing) {
    const id = newId('fes');
    await tx
      .insertInto('festival_series')
      .values({ id, name: f.name, normalized_name: normalize(f.name), website: f.website ?? null, country: f.country ?? null, description: f.description ?? null, is_demo: b(isDemo), created_at: t, updated_at: t })
      .execute();
    await addKeys(tx, 'festival_keys', 'series_id', id, f.keys ?? [], warnings);
    return { status: 'created' as const, id, warnings: warnings.length ? warnings : undefined };
  }
  const patch: Record<string, unknown> = {};
  for (const k of ['website', 'country', 'description'] as const) if (f[k] !== undefined && f[k] !== existing[k]) patch[k] = f[k];
  await addKeys(tx, 'festival_keys', 'series_id', existing.id, f.keys ?? [], warnings);
  if (Object.keys(patch).length) await tx.updateTable('festival_series').set({ ...patch, updated_at: t }).where('id', '=', existing.id).execute();
  return { status: Object.keys(patch).length ? ('updated' as const) : ('unchanged' as const), id: existing.id, changes: Object.keys(patch), warnings: warnings.length ? warnings : undefined };
}

async function findFestivalSeries(tx: Tx, r: { series_id?: string; series_key?: string; keys?: string[]; name?: string }) {
  if (r.series_id) return tx.selectFrom('festival_series').selectAll().where('id', '=', r.series_id).executeTakeFirst();
  for (const key of [r.series_key, ...(r.keys ?? [])].filter(Boolean) as string[]) {
    const k = await tx.selectFrom('festival_keys').select('series_id').where('key', '=', key).executeTakeFirst();
    if (k) return tx.selectFrom('festival_series').selectAll().where('id', '=', k.series_id).executeTakeFirst();
  }
  if (r.name) return tx.selectFrom('festival_series').selectAll().where('normalized_name', '=', normalize(r.name)).executeTakeFirst();
  return undefined;
}

// ---------------------------------------------------------------- residencies

async function upsertResidency(tx: Tx, r: ResidencyInput, isDemo: boolean) {
  const warnings: string[] = [];
  const venue = await resolveVenue(tx, r.venue, isDemo);
  let existing = r.id ? await tx.selectFrom('residencies').selectAll().where('id', '=', r.id).executeTakeFirst() : undefined;
  if (!existing) {
    for (const key of r.keys ?? []) {
      const k = await tx.selectFrom('residency_keys').select('residency_id').where('key', '=', key).executeTakeFirst();
      if (k) {
        existing = await tx.selectFrom('residencies').selectAll().where('id', '=', k.residency_id).executeTakeFirst();
        break;
      }
    }
  }
  if (!existing) {
    const cands = await tx.selectFrom('residencies').selectAll().where('season', '=', r.season).where('venue_id', '=', venue.id).execute();
    existing = cands.find((c) => normalize(c.title) === normalize(r.title));
  }
  const t = nowIso();
  let id: string;
  const changes: string[] = [];
  if (!existing) {
    id = newId('res');
    await tx
      .insertInto('residencies')
      .values({
        id,
        season: r.season,
        title: r.title,
        brand: r.brand ?? null,
        venue_id: venue.id,
        weekday: r.weekday ?? null,
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        status: r.status ?? 'announced',
        announced_at: r.announced_at ?? null,
        announcement_url: r.announcement_url ?? null,
        description: r.description ?? null,
        ticket_url: r.ticket_url ?? null,
        sources: JSON.stringify(r.sources ?? []),
        last_verified_at: r.verified_at ?? null,
        is_demo: b(isDemo),
        created_at: t,
        updated_at: t,
      })
      .execute();
  } else {
    id = existing.id;
    const patch: Record<string, unknown> = {};
    for (const k of ['title', 'brand', 'weekday', 'start_date', 'end_date', 'status', 'announced_at', 'announcement_url', 'description', 'ticket_url'] as const) {
      if (r[k] !== undefined && r[k] !== existing[k]) patch[k] = r[k];
    }
    if (venue.id !== existing.venue_id) patch.venue_id = venue.id;
    if (r.sources) {
      const merged = mergeSourcesJson(parseJson(existing.sources, []), r.sources);
      if (JSON.stringify(merged) !== existing.sources) patch.sources = JSON.stringify(merged);
    }
    if (r.verified_at && (!existing.last_verified_at || r.verified_at > existing.last_verified_at)) patch.last_verified_at = r.verified_at;
    changes.push(...Object.keys(patch).filter((k) => k !== 'last_verified_at'));
    if (Object.keys(patch).length) await tx.updateTable('residencies').set({ ...patch, updated_at: t }).where('id', '=', id).execute();
  }
  await addKeys(tx, 'residency_keys', 'residency_id', id, r.keys ?? [], warnings);
  if (r.residents) {
    const resolved: string[] = [];
    for (const res of r.residents) {
      let artist = await findArtist(tx, res);
      if (!artist && res.name) {
        const created = await upsertArtist(tx, { name: res.name }, { isDemo, origin: 'research' });
        artist = await tx.selectFrom('artists').selectAll().where('id', '=', created.id!).executeTakeFirstOrThrow();
      }
      if (artist) resolved.push(artist.id);
    }
    const current = (await tx.selectFrom('residency_artists').select('artist_id').where('residency_id', '=', id).execute()).map((x) => x.artist_id);
    if (r.residents_mode === 'replace') {
      const remove = current.filter((x) => !resolved.includes(x));
      if (remove.length) {
        await tx.deleteFrom('residency_artists').where('residency_id', '=', id).where('artist_id', 'in', remove).execute();
        changes.push('residents_removed');
      }
    }
    const add = resolved.filter((x) => !current.includes(x));
    for (const a of [...new Set(add)]) await tx.insertInto('residency_artists').values({ residency_id: id, artist_id: a }).execute();
    if (add.length) changes.push('residents_added');
  }
  return { status: existing ? (changes.length ? ('updated' as const) : ('unchanged' as const)) : ('created' as const), id, changes, warnings: warnings.length ? warnings : undefined };
}

function mergeSourcesJson(existing: { url: string }[], incoming: { url: string }[]) {
  const map = new Map(existing.map((s) => [s.url, s]));
  for (const s of incoming) map.set(s.url, { ...map.get(s.url), ...s });
  return [...map.values()];
}

// ---------------------------------------------------------------- events

/** Title + date + city, used as a fallback duplicate check when no source key matches. */
export function dedupeKey(title: string, startLocal: string, city: string | null | undefined) {
  return `${normalize(title)}|${startLocal.slice(0, 10)}|${normalize(city ?? '')}`;
}

function similarity(a: string, b2: string) {
  const ta = new Set(normalize(a).split(' ').filter((w) => w.length > 1));
  const tb = new Set(normalize(b2).split(' ').filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

async function findExistingEvent(tx: Tx, e: EventInput, venueId: string | null, city: string | null): Promise<{ row: EventRow; matchedBy: string } | null> {
  if (e.id) {
    const row = await tx.selectFrom('events').selectAll().where('id', '=', e.id).executeTakeFirst();
    if (!row) throw new Error(`Unknown event id ${e.id}`);
    return { row, matchedBy: 'id' };
  }
  const keys = [...(e.source_keys ?? []), ...((e.sources ?? []).map((s) => s.key).filter(Boolean) as string[])];
  for (const key of keys) {
    const k = await tx.selectFrom('event_keys').select('event_id').where('key', '=', key).executeTakeFirst();
    if (k) return { row: await tx.selectFrom('events').selectAll().where('id', '=', k.event_id).executeTakeFirstOrThrow(), matchedBy: `key:${key}` };
  }
  // Same official URL.
  for (const s of e.sources ?? []) {
    if (!['official_artist', 'venue', 'promoter', 'festival', 'ticketing'].includes(s.type)) continue;
    const hit = await tx
      .selectFrom('event_sources as s')
      .innerJoin('events as ev', 'ev.id', 's.event_id')
      .select('ev.id')
      .where('s.url', '=', s.url)
      .where('ev.origin', '!=', 'manual')
      .executeTakeFirst();
    if (hit && e.start) {
      const row = await tx.selectFrom('events').selectAll().where('id', '=', hit.id).executeTakeFirstOrThrow();
      if (row.start_local.slice(0, 10) === e.start.slice(0, 10)) return { row, matchedBy: `url:${s.url}` };
    }
  }
  if (e.title && e.start) {
    const dk = dedupeKey(e.title, e.start, city);
    const exact = await tx.selectFrom('events').selectAll().where('dedupe_key', '=', dk).where('origin', '!=', 'manual').executeTakeFirst();
    if (exact) return { row: exact, matchedBy: 'title+date+city' };
    const day = e.start.slice(0, 10);
    const sameDay = await tx
      .selectFrom('events')
      .selectAll()
      .where('origin', '!=', 'manual')
      .where('start_local', '>=', day)
      .where('start_local', '<=', `${day}T99`)
      .execute();
    const fuzzy = sameDay.find(
      (r) => similarity(r.title, e.title!) >= 0.75 && ((venueId && r.venue_id === venueId) || (city && r.city && normalize(r.city) === normalize(city))),
    );
    if (fuzzy) return { row: fuzzy, matchedBy: 'similar title+date+place' };
  }
  return null;
}

const MATERIAL_FIELDS = new Set(['title', 'start_local', 'end_local', 'venue_id', 'status', 'ticket_url', 'presale_at', 'onsale_at', 'ticket_status', 'price_min', 'price_max', 'timezone', 'recurrence', 'doors_local']);

export async function upsertEvent(
  ctx: AppContext,
  tx: Tx,
  e: EventInput,
  opts: { runId: string | null; isDemo: boolean; actor: 'research' | 'user'; ownerUserId?: string },
): Promise<Omit<ItemResult, 'type' | 'index' | 'ref'> & { summary?: EventChangeSummary }> {
  const warnings: string[] = [];
  const t = nowIso();
  const manual = !!opts.ownerUserId;

  const venue = e.venue ? await resolveVenue(tx, e.venue, opts.isDemo) : null;
  const venueCity = venue?.row.city ?? null;

  let found: { row: EventRow; matchedBy: string } | null;
  if (manual) {
    // Owner-entered events are only ever matched by their own id.
    const row = e.id ? await tx.selectFrom('events').selectAll().where('id', '=', e.id).executeTakeFirst() : undefined;
    if (e.id && (!row || row.origin !== 'manual' || row.owner_user_id !== opts.ownerUserId)) throw new HttpError(404, 'Manual event not found');
    found = row ? { row, matchedBy: 'id' } : null;
  } else {
    found = await findExistingEvent(tx, e, venue?.id ?? null, venueCity);
  }
  const existing = found?.row ?? null;
  if (!manual && existing?.origin === 'manual') throw new Error('This event was entered by the owner and cannot be changed through research imports');

  // ---- Location
  const loc = {
    venue_id: e.venue === null ? null : venue ? venue.id : existing?.venue_id ?? null,
    town: venue ? venue.row.town ?? venue.row.city : existing?.town ?? null,
    city: venue ? venue.row.city : existing?.city ?? null,
    country: venue ? venue.row.country : existing?.country ?? null,
    lat: venue ? venue.row.lat : existing?.lat ?? null,
    lng: venue ? venue.row.lng : existing?.lng ?? null,
  };
  if (e.venue === null) Object.assign(loc, { town: null, city: null, country: null, lat: null, lng: null });
  const region = venue?.row.region ?? null;
  const hub = nearestHub(loc.lat, loc.lng, loc.town, loc.city, region);

  // ---- Timezone and schedule
  const timezone = e.timezone ?? existing?.timezone ?? venue?.row.timezone ?? (loc.country ? COUNTRY_TIMEZONES[loc.country] : undefined);
  if (!timezone) throw new Error('timezone is required (or give a venue with a country)');
  const scheduleTouched = e.start !== undefined || e.end !== undefined || e.timezone !== undefined || e.recurrence !== undefined || e.doors !== undefined;
  const recurrence: RecurrenceRule | null = e.recurrence !== undefined ? (e.recurrence as RecurrenceRule | null) : parseJson<RecurrenceRule | null>(existing?.recurrence, null);
  let start = e.start ?? existing?.start_local;
  let end = e.end !== undefined ? e.end : existing?.end_local ?? null;
  if (recurrence && !start) start = recurrence.start_time ? `${recurrence.from}T${recurrence.start_time}` : recurrence.from;
  if (!existing && (!e.title || !start)) throw new Error('title and start are required to create an event');
  if (!start) throw new Error('start missing');

  let occurrences: { start: string; end: string | null }[];
  if (recurrence) {
    const dates = expandRecurrence(recurrence, timezone);
    if (!dates.length) throw new Error('Recurrence produced no dates');
    occurrences = dates.map((d) => ({ start: recurrence.start_time ? `${d}T${recurrence.start_time}` : d, end: recurrence.end_time ?? null }));
    start = occurrences[0].start;
    end = occurrences.length > 1 ? null : occurrences[0].end;
  } else {
    occurrences = [{ start, end }];
  }
  const resolvedOccs = occurrences.map((o) => ({ ...resolveTimes(o.start, o.end, timezone) }));
  const first = resolvedOccs[0];
  const last = resolvedOccs[resolvedOccs.length - 1];
  let doors: string | null = e.doors !== undefined ? e.doors : existing?.doors_local ?? null;
  if (doors && /^\d{2}:\d{2}$/.test(doors)) doors = `${first.startLocal.slice(0, 10)}T${doors}`;

  // ---- Event-level columns
  const tk = e.tickets ?? {};
  const cols: Partial<EventsTable> = {
    title: e.title ?? existing?.title,
    timezone,
    start_local: first.startLocal,
    end_local: recurrence ? (last.endLocal ?? last.startLocal.slice(0, 10)) : first.endLocal,
    doors_local: doors,
    start_utc: first.startUtc,
    end_utc: last.endUtc,
    span_end_utc: last.spanEndUtc,
    start_time_known: b(first.startTimeKnown),
    end_time_known: b(first.endTimeKnown),
    recurrence: recurrence ? JSON.stringify(recurrence) : null,
    ...loc,
    hub: hub.hub,
    hub_distance_km: hub.km,
  };
  if (recurrence && resolvedOccs.length === 1) cols.end_local = first.endLocal;
  const set = <K extends keyof EventsTable>(k: K, v: EventsTable[K] | undefined) => {
    if (v !== undefined) cols[k] = v;
  };
  set('kind', e.kind ?? (existing ? undefined : recurrence ? 'recurring' : e.festival ? 'festival' : 'event'));
  set('description', e.description);
  set('expectation', e.expectation);
  if (e.why_suits_me !== undefined) {
    cols.why_suits_me = e.why_suits_me;
    if (e.why_suits_me !== existing?.why_suits_me) cols.why_suits_me_updated_at = t;
  }
  set('status', e.status);
  set('status_note', e.status_note);
  set('location_text', e.location_text);
  set('occasion', e.occasion);
  set('age_restriction', e.age_restriction);
  if (e.languages !== undefined) cols.languages = toJson(e.languages);
  set('language_importance', e.language_importance);
  set('participation', e.participation);
  set('performance_format', e.performance_format);
  set('ticket_url', tk.url);
  set('price_min', tk.price_min);
  set('price_max', tk.price_max);
  set('currency', tk.currency);
  set('price_note', tk.price_note);
  set('booking_fee_note', tk.booking_fee_note);
  if (tk.status !== undefined) {
    cols.ticket_status = tk.status;
    if (!tk.status_checked_at && tk.status !== existing?.ticket_status) cols.ticket_status_checked_at = e.verified_at ?? t;
  }
  set('ticket_status_checked_at', tk.status_checked_at);
  set('presale_at', tk.presale_at);
  set('onsale_at', tk.onsale_at);
  set('sale_timezone', tk.sale_timezone);
  set('sale_note', tk.sale_note);
  if (tk.tiers !== undefined) cols.ticket_tiers = toJson(tk.tiers);
  if (e.camping !== undefined) cols.camping = toJson(e.camping);
  if (e.accommodation !== undefined) cols.accommodation = toJson(e.accommodation);
  if (e.highlight !== undefined) cols.highlight = b(e.highlight);
  set('prominence', e.prominence);
  set('announced_at', e.announced_at);
  if (e.unverified_fields !== undefined) cols.unverified_fields = toJson(e.unverified_fields);
  if (e.tba_fields !== undefined) cols.tba_fields = toJson(e.tba_fields);
  if (e.conflicts !== undefined) cols.conflicts = toJson(e.conflicts);
  if (e.travel !== undefined) cols.travel = toJson(e.travel);
  if (e.needs_review !== undefined) cols.needs_review = b(e.needs_review);
  set('review_reason', e.review_reason);
  if (e.residency_id !== undefined) cols.residency_id = e.residency_id;
  if (e.residency_key) {
    const rk = await tx.selectFrom('residency_keys').select('residency_id').where('key', '=', e.residency_key).executeTakeFirst();
    if (rk) cols.residency_id = rk.residency_id;
    else warnings.push(`Unknown residency_key "${e.residency_key}"`);
  }
  if (e.festival !== undefined) {
    if (e.festival === null) {
      cols.festival_series_id = null;
      cols.edition = null;
    } else {
      let series = await findFestivalSeries(tx, { series_id: e.festival.series_id, series_key: e.festival.series_key, name: e.festival.name });
      if (!series) {
        const created = await upsertFestivalSeries(tx, { name: e.festival.name, website: e.festival.website, keys: e.festival.series_key ? [e.festival.series_key] : undefined }, opts.isDemo);
        series = await tx.selectFrom('festival_series').selectAll().where('id', '=', created.id!).executeTakeFirstOrThrow();
      }
      cols.festival_series_id = series.id;
      if (e.festival.edition !== undefined) cols.edition = e.festival.edition;
    }
  }
  if (e.verified_at && (!existing?.last_verified_at || e.verified_at > existing.last_verified_at)) {
    cols.last_verified_at = e.verified_at;
    cols.verification_state = 'verified';
  }
  cols.dedupe_key = (manual ? 'manual:' : '') + dedupeKey(cols.title!, cols.start_local!, cols.city);
  cols.normalized_title = normalize(cols.title!);

  // ---- Diff against the stored row
  const changes: { field: string; old: unknown; new: unknown }[] = [];
  let id: string;
  let created = false;
  if (existing) {
    id = existing.id;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cols)) {
      const old = (existing as unknown as Record<string, unknown>)[k];
      if (v !== old && !(v == null && old == null)) {
        if (!scheduleTouched && ['start_local', 'end_local', 'start_utc', 'end_utc', 'span_end_utc', 'start_time_known', 'end_time_known', 'doors_local', 'recurrence'].includes(k)) continue;
        patch[k] = v;
        if (!['start_utc', 'end_utc', 'span_end_utc', 'dedupe_key', 'normalized_title', 'hub_distance_km', 'last_verified_at', 'verification_state', 'ticket_status_checked_at', 'why_suits_me_updated_at'].includes(k)) {
          changes.push({ field: k, old, new: v });
        }
      }
    }
    const material = changes.some((c) => MATERIAL_FIELDS.has(c.field));
    const scheduleChanged = changes.some((c) => ['start_local', 'end_local', 'timezone', 'recurrence'].includes(c.field));
    if (scheduleChanged) {
      const prev = parseJson<unknown[]>(existing.previous_schedule, []);
      prev.push({ start_local: existing.start_local, end_local: existing.end_local, timezone: existing.timezone, venue_id: existing.venue_id, replaced_at: t, run_id: opts.runId });
      patch.previous_schedule = JSON.stringify(prev);
    }
    if (Object.keys(patch).length) {
      patch.version = existing.version + 1;
      patch.updated_at = t;
      patch.updated_by_run_id = opts.runId;
      if (material) patch.last_changed_at = t;
      if (existing.archived_at && (patch.span_end_utc as string | undefined ?? existing.span_end_utc) > ctx.now().toISOString()) patch.archived_at = null;
      await tx.updateTable('events').set(patch).where('id', '=', id).execute();
    }
  } else {
    id = newId('evt');
    created = true;
    await tx
      .insertInto('events')
      .values({
        id,
        kind: cols.kind ?? 'event',
        title: cols.title!,
        normalized_title: cols.normalized_title!,
        description: cols.description ?? null,
        expectation: cols.expectation ?? null,
        why_suits_me: cols.why_suits_me ?? null,
        why_suits_me_updated_at: cols.why_suits_me ? t : null,
        status: cols.status ?? 'scheduled',
        status_note: cols.status_note ?? null,
        origin: manual ? 'manual' : opts.isDemo ? 'demo' : 'research',
        owner_user_id: opts.ownerUserId ?? null,
        is_demo: b(opts.isDemo),
        venue_id: cols.venue_id ?? null,
        location_text: cols.location_text ?? null,
        town: cols.town ?? null,
        city: cols.city ?? null,
        country: cols.country ?? null,
        lat: cols.lat ?? null,
        lng: cols.lng ?? null,
        hub: cols.hub ?? null,
        hub_distance_km: cols.hub_distance_km ?? null,
        timezone,
        start_local: cols.start_local!,
        end_local: cols.end_local ?? null,
        doors_local: cols.doors_local ?? null,
        start_utc: cols.start_utc!,
        end_utc: cols.end_utc!,
        span_end_utc: cols.span_end_utc!,
        start_time_known: cols.start_time_known!,
        end_time_known: cols.end_time_known!,
        recurrence: cols.recurrence ?? null,
        festival_series_id: cols.festival_series_id ?? null,
        edition: cols.edition ?? null,
        residency_id: cols.residency_id ?? null,
        occasion: cols.occasion ?? null,
        age_restriction: cols.age_restriction ?? null,
        languages: cols.languages ?? null,
        language_importance: cols.language_importance ?? null,
        participation: cols.participation ?? null,
        performance_format: cols.performance_format ?? null,
        ticket_url: cols.ticket_url ?? null,
        price_min: cols.price_min ?? null,
        price_max: cols.price_max ?? null,
        currency: cols.currency ?? null,
        price_note: cols.price_note ?? null,
        booking_fee_note: cols.booking_fee_note ?? null,
        ticket_status: cols.ticket_status ?? 'unknown',
        ticket_status_checked_at: cols.ticket_status_checked_at ?? null,
        presale_at: cols.presale_at ?? null,
        onsale_at: cols.onsale_at ?? null,
        sale_timezone: cols.sale_timezone ?? (cols.presale_at || cols.onsale_at ? timezone : null),
        sale_note: cols.sale_note ?? null,
        ticket_tiers: cols.ticket_tiers ?? null,
        camping: cols.camping ?? null,
        accommodation: cols.accommodation ?? null,
        highlight: cols.highlight ?? 0,
        prominence: cols.prominence ?? 30,
        announced_at: cols.announced_at ?? null,
        first_seen_at: t,
        last_verified_at: cols.last_verified_at ?? null,
        verification_state: manual ? 'owner_entered' : cols.last_verified_at ? 'verified' : 'unverified',
        last_changed_at: t,
        needs_review: cols.needs_review ?? 0,
        review_reason: cols.review_reason ?? null,
        unverified_fields: cols.unverified_fields ?? null,
        tba_fields: cols.tba_fields ?? null,
        conflicts: cols.conflicts ?? null,
        previous_schedule: null,
        travel: cols.travel ?? null,
        dedupe_key: cols.dedupe_key!,
        archived_at: null,
        version: 1,
        created_at: t,
        updated_at: t,
        created_by_run_id: opts.runId,
        updated_by_run_id: opts.runId,
      })
      .execute();
  }

  // ---- Occurrences (stable ids per local date, so a chosen date survives updates)
  if (created || scheduleTouched) {
    const fresh = resolvedOccs.map((o) => ({
      id: `${id}_${o.startLocal.slice(0, 10)}`,
      event_id: id,
      start_local: o.startLocal,
      end_local: o.endLocal,
      start_utc: o.startUtc,
      end_utc: o.endUtc,
      span_end_utc: o.spanEndUtc,
      start_time_known: b(o.startTimeKnown),
      end_time_known: b(o.endTimeKnown),
    }));
    const current = await tx.selectFrom('event_occurrences').selectAll().where('event_id', '=', id).orderBy('start_utc').execute();
    const same = current.length === fresh.length && current.every((c, i) => c.id === fresh[i].id && c.start_utc === fresh[i].start_utc && c.end_utc === fresh[i].end_utc);
    if (!same) {
      await tx.deleteFrom('event_occurrences').where('event_id', '=', id).execute();
      for (const part of chunkArr(fresh, 100)) await tx.insertInto('event_occurrences').values(part).execute();
      if (!created && !changes.some((c) => ['start_local', 'end_local'].includes(c.field))) changes.push({ field: 'occurrences', old: current.length, new: fresh.length });
    }
  }

  // ---- Keys
  const keys = [...new Set([...(e.source_keys ?? []), ...((e.sources ?? []).map((s) => s.key).filter(Boolean) as string[])])];
  await addKeys(tx, 'event_keys', 'event_id', id, keys, warnings);

  // ---- Categories and genres
  if (e.categories) {
    const valid = e.categories.filter((c) => {
      if (!CATEGORY_BY_SLUG.has(c)) warnings.push(`Unknown category "${c}" ignored`);
      return CATEGORY_BY_SLUG.has(c);
    });
    const ch = await syncSet(tx, 'event_categories', 'category', id, valid, e.categories_mode ?? 'merge');
    if (ch && !created) changes.push({ field: 'categories', old: null, new: valid });
  }
  if (e.genres) {
    const valid = e.genres.filter((g) => {
      if (!GENRE_BY_SLUG.has(g)) warnings.push(`Unknown genre "${g}" stored as a free tag`);
      return /^[a-z0-9-]+$/.test(g);
    });
    const ch = await syncSet(tx, 'event_genres', 'genre', id, valid, e.genres_mode ?? 'merge');
    if (ch && !created) changes.push({ field: 'genres', old: null, new: valid });
  }

  // ---- Lineup
  const lineupAdded: { artist_id: string; name: string; billing: string; format: string; date: string | null }[] = [];
  if (e.lineup) {
    const r = await syncLineup(tx, id, e.lineup, e.lineup_mode ?? 'merge', opts.isDemo, first.startLocal.slice(0, 10), warnings);
    lineupAdded.push(...r.added);
    if (!created && (r.added.length || r.removed || r.updated)) {
      if (r.added.length) changes.push({ field: 'lineup_added', old: null, new: r.added.map((a) => a.name) });
      if (r.removed) changes.push({ field: 'lineup_removed', old: r.removed, new: null });
      if (r.updated) changes.push({ field: 'lineup_details', old: null, new: r.updated });
    }
  }

  // ---- Sources
  if (e.sources) {
    const ch = await syncSources(tx, id, e.sources, e.sources_mode ?? 'merge');
    if (ch && !created) changes.push({ field: 'sources', old: null, new: e.sources.length });
  }

  // ---- Change log
  const changeType = (f: string) =>
    ({ start_local: 'date_changed', end_local: 'date_changed', venue_id: 'venue_changed', status: 'status_changed', presale_at: 'ticket_sale', onsale_at: 'ticket_sale', ticket_status: 'ticket_status', lineup_added: 'lineup_added', lineup_removed: 'lineup_removed' } as Record<string, string>)[f] ?? 'details';
  if (created) {
    await tx.insertInto('event_changes').values({ id: newId('chg'), event_id: id, run_id: opts.runId, change_type: 'created', field: null, old_value: null, new_value: null, created_at: t }).execute();
  }
  for (const c of changes) {
    await tx
      .insertInto('event_changes')
      .values({ id: newId('chg'), event_id: id, run_id: opts.runId, change_type: changeType(c.field), field: c.field, old_value: toJson(c.old), new_value: toJson(c.new), created_at: t })
      .execute();
  }
  if (!created && (changes.length || lineupAdded.length)) {
    await tx.updateTable('events').set({ last_changed_at: t, updated_at: t }).where('id', '=', id).execute();
  }

  const status = created ? 'created' : changes.length ? 'updated' : 'unchanged';
  return {
    status,
    id,
    changes: changes.map((c) => c.field),
    warnings: warnings.length ? warnings : undefined,
    ...(found && !created ? { matched_by: found.matchedBy } : {}),
    summary: {
      eventId: id,
      created,
      lineupAdded,
      fieldChanges: changes.filter((c) => MATERIAL_FIELDS.has(c.field)).map((c) => ({ field: c.field, old: c.old, new: c.new })),
    },
  };
}

function chunkArr<T>(a: T[], n: number) {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

async function syncSet(tx: Tx, table: 'event_categories' | 'event_genres', col: 'category' | 'genre', eventId: string, values: string[], mode: 'merge' | 'replace') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = tx as any;
  const current: string[] = (await t.selectFrom(table).select(col).where('event_id', '=', eventId).execute()).map((r: Record<string, string>) => r[col]);
  let changed = false;
  if (mode === 'replace') {
    const remove = current.filter((c) => !values.includes(c));
    if (remove.length) {
      await t.deleteFrom(table).where('event_id', '=', eventId).where(col, 'in', remove).execute();
      changed = true;
    }
  }
  for (const v of [...new Set(values)]) {
    if (!current.includes(v)) {
      await t.insertInto(table).values({ event_id: eventId, [col]: v }).execute();
      changed = true;
    }
  }
  return changed;
}

async function syncLineup(tx: Tx, eventId: string, lineup: LineupInput[], mode: 'merge' | 'replace', isDemo: boolean, startDate: string, warnings: string[]) {
  const current = await tx.selectFrom('event_artists').selectAll().where('event_id', '=', eventId).execute();
  const t = nowIso();
  const seen = new Set<string>();
  const added: { artist_id: string; name: string; billing: string; format: string; date: string | null }[] = [];
  let removed = 0;
  let updated = 0;
  for (const [i, l] of lineup.entries()) {
    let artist = await findArtist(tx, l);
    if (!artist) {
      if (!l.name) {
        warnings.push(`Lineup entry ${i} could not be matched to an artist`);
        continue;
      }
      if (l.remove) continue;
      const res = await upsertArtist(tx, { name: l.name, keys: l.artist_key ? [l.artist_key] : undefined }, { isDemo, origin: 'research' });
      artist = await tx.selectFrom('artists').selectAll().where('id', '=', res.id!).executeTakeFirstOrThrow();
    }
    const appearanceKey = l.date ?? '';
    const row = current.find((c) => c.artist_id === artist!.id && c.appearance_key === appearanceKey);
    seen.add(`${artist.id}|${appearanceKey}`);
    if (l.remove) {
      if (row) {
        await tx.deleteFrom('event_artists').where('id', '=', row.id).execute();
        removed++;
      }
      continue;
    }
    const day = l.date ?? startDate;
    const normTime = (v: string | null | undefined) => (v && /^\d{2}:\d{2}$/.test(v) ? `${day}T${v}` : v);
    const vals = {
      billing: l.billing,
      performance_format: l.format,
      appearance_date: l.date,
      set_start_local: normTime(l.set_start),
      set_end_local: normTime(l.set_end),
      stage: l.stage,
      confirmed: l.confirmed === undefined ? undefined : b(l.confirmed),
      announced_at: l.announced_at,
      source_url: l.source_url,
      sort_order: i,
    };
    if (!row) {
      await tx
        .insertInto('event_artists')
        .values({
          id: newId('ea'),
          event_id: eventId,
          artist_id: artist.id,
          appearance_key: appearanceKey,
          billing: vals.billing ?? 'unknown',
          performance_format: vals.performance_format ?? 'unknown',
          appearance_date: vals.appearance_date ?? null,
          set_start_local: vals.set_start_local ?? null,
          set_end_local: vals.set_end_local ?? null,
          stage: vals.stage ?? null,
          confirmed: vals.confirmed ?? 1,
          announced_at: vals.announced_at ?? null,
          source_url: vals.source_url ?? null,
          sort_order: i,
          created_at: t,
        })
        .execute();
      added.push({ artist_id: artist.id, name: artist.name, billing: vals.billing ?? 'unknown', format: vals.performance_format ?? 'unknown', date: l.date ?? null });
    } else {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vals)) {
        if (k === 'sort_order') continue;
        if (v !== undefined && v !== (row as Record<string, unknown>)[k]) patch[k] = v;
      }
      if (Object.keys(patch).length) {
        await tx.updateTable('event_artists').set(patch).where('id', '=', row.id).execute();
        updated++;
      }
    }
  }
  if (mode === 'replace') {
    for (const c of current) {
      if (!seen.has(`${c.artist_id}|${c.appearance_key}`)) {
        await tx.deleteFrom('event_artists').where('id', '=', c.id).execute();
        removed++;
      }
    }
  }
  return { added, removed, updated };
}

async function syncSources(tx: Tx, eventId: string, sources: NonNullable<EventInput['sources']>, mode: 'merge' | 'replace') {
  const current = await tx.selectFrom('event_sources').selectAll().where('event_id', '=', eventId).execute();
  const t = nowIso();
  let changed = false;
  for (const s of sources) {
    const row = current.find((c) => c.url === s.url);
    const claims = s.claims ? JSON.stringify(s.claims) : null;
    if (!row) {
      await tx
        .insertInto('event_sources')
        .values({ id: newId('src'), event_id: eventId, url: s.url, source_type: s.type, name: s.name ?? null, source_key: s.key ?? null, claims, retrieved_at: s.retrieved_at ?? t, status: 'ok', created_at: t })
        .execute();
      changed = true;
    } else {
      const patch: Record<string, unknown> = {};
      if (s.type !== row.source_type) patch.source_type = s.type;
      if (s.name !== undefined && s.name !== row.name) patch.name = s.name;
      if (s.key !== undefined && s.key !== row.source_key) patch.source_key = s.key;
      if (claims && claims !== row.claims) patch.claims = claims;
      if (row.status !== 'ok') patch.status = 'ok';
      if (Object.keys(patch).length) changed = true;
      if (s.retrieved_at && s.retrieved_at !== row.retrieved_at) patch.retrieved_at = s.retrieved_at;
      if (Object.keys(patch).length) await tx.updateTable('event_sources').set(patch).where('id', '=', row.id).execute();
    }
  }
  if (mode === 'replace') {
    const urls = new Set(sources.map((s) => s.url));
    const remove = current.filter((c) => !urls.has(c.url)).map((c) => c.id);
    if (remove.length) {
      await tx.deleteFrom('event_sources').where('id', 'in', remove).execute();
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- verification

async function applyVerification(ctx: AppContext, tx: Tx, v: VerificationInput, runId: string | null) {
  let eventId = v.event_id;
  if (!eventId && v.source_key) eventId = (await tx.selectFrom('event_keys').select('event_id').where('key', '=', v.source_key).executeTakeFirst())?.event_id;
  if (!eventId) throw new Error('Event not found for verification');
  const row = await tx.selectFrom('events').selectAll().where('id', '=', eventId).executeTakeFirst();
  if (!row) throw new Error(`Unknown event id ${eventId}`);
  if (row.origin === 'manual') throw new Error('Owner-entered events are not verified through research');
  const checkedAt = v.checked_at ?? nowIso();
  const patch: Partial<EventsTable> = { updated_at: nowIso() };
  switch (v.outcome) {
    case 'confirmed':
    case 'changed':
      patch.last_verified_at = checkedAt;
      patch.verification_state = 'verified';
      if (row.verification_state === 'source_missing' || row.verification_state === 'check_failed') {
        patch.needs_review = 0;
        patch.review_reason = null;
      }
      if (v.source_url) await tx.updateTable('event_sources').set({ status: 'ok', retrieved_at: checkedAt }).where('event_id', '=', eventId).where('url', '=', v.source_url).execute();
      break;
    case 'source_missing':
      // Keep the listing; flag it for review.
      patch.verification_state = 'source_missing';
      patch.needs_review = 1;
      patch.review_reason = v.note ?? 'The source page could no longer be found during verification';
      if (v.source_url) await tx.updateTable('event_sources').set({ status: 'missing' }).where('event_id', '=', eventId).where('url', '=', v.source_url).execute();
      break;
    case 'check_failed':
      patch.verification_state = 'check_failed';
      patch.needs_review = 1;
      patch.review_reason = v.note ?? 'The last verification check failed';
      break;
  }
  await tx.updateTable('events').set(patch).where('id', '=', eventId).execute();
  await tx
    .insertInto('event_changes')
    .values({ id: newId('chg'), event_id: eventId, run_id: runId, change_type: 'verification', field: v.outcome, old_value: null, new_value: toJson(v.note ?? null), created_at: nowIso() })
    .execute();
  void ctx;
  return { status: 'updated' as const, id: eventId, changes: [v.outcome] };
}

export type { ImportPayload };
