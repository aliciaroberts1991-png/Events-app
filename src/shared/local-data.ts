// Device-local personal data: favourites, hidden events, planning status, notes,
// bookings, your own entries, personal plans, clash reviews, "fewer like this" and
// Ibiza stays. Stored in the browser; exported/imported as a JSON file for backup or
// to copy to another device. Event ids refer to the central collection, which is the
// same on every device.
import { z } from 'zod';

const iso = z.string().max(40);
const localDT = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);

export const snapshotSchema = z.object({
  title: z.string().max(300),
  start_local: z.string().max(20),
  end_local: z.string().max(20).nullable().optional(),
  timezone: z.string().max(60),
  city: z.string().max(200).nullable().optional(),
  venue: z.string().max(200).nullable().optional(),
});

export const eventStateSchema = z.object({
  favourite: z.boolean().default(false),
  hidden: z.boolean().default(false),
  plan_status: z.enum(['none', 'interested', 'going', 'booked']).default('none'),
  occurrence_id: z.string().max(120).nullable().default(null),
  notes: z.string().max(10000).nullable().default(null),
  updated_at: iso,
  /** Last known title/date, so saved items stay readable even if a listing disappears. */
  snapshot: snapshotSchema.optional(),
});

export const entrySchema = z.object({
  id: z.string().regex(/^loc_[A-Za-z0-9_-]+$/),
  title: z.string().min(1).max(300),
  start: localDT,
  end: z.string().max(20).nullable().default(null),
  timezone: z.string().max(60),
  venue: z.string().max(200).nullable().default(null),
  city: z.string().max(200).nullable().default(null),
  country: z.string().max(2).nullable().default(null),
  artist: z.string().max(200).nullable().default(null),
  format: z.string().max(20).nullable().default(null),
  source_url: z.string().max(2000).nullable().default(null),
  /** When linked, the entry is shown as this central listing instead. */
  linked_event_id: z.string().max(60).nullable().default(null),
  created_at: iso,
  updated_at: iso,
});

export const bookingSchema = z.object({
  id: z.string().max(60),
  target: z.string().max(60),
  provider: z.string().max(200).nullable().default(null),
  amount: z.number().min(0).nullable().default(null),
  currency: z.string().max(3).nullable().default(null),
  reference: z.string().max(200).nullable().default(null),
  quantity: z.number().int().min(1).nullable().default(null),
  ticket_type: z.string().max(200).nullable().default(null),
  links: z.array(z.string().max(2000)).max(10).default([]),
  notes: z.string().max(5000).nullable().default(null),
  created_at: iso,
  updated_at: iso,
});

export const planSchema = z.object({
  id: z.string().max(60),
  title: z.string().min(1).max(300),
  start: localDT,
  end: z.string().max(20).nullable().default(null),
  timezone: z.string().max(60),
  location: z.string().max(300).nullable().default(null),
  notes: z.string().max(5000).nullable().default(null),
  created_at: iso,
  updated_at: iso,
});

export const localDataSchema = z.object({
  version: z.literal(1),
  device_id: z.string().max(64),
  states: z.record(z.string().max(60), eventStateSchema).default({}),
  entries: z.array(entrySchema).default([]),
  bookings: z.array(bookingSchema).default([]),
  plans: z.array(planSchema).default([]),
  clash_reviews: z.array(z.string().max(400)).default([]),
  feedback: z.array(z.object({ event_id: z.string().max(60), categories: z.array(z.string()), genres: z.array(z.string()), at: iso })).default([]),
  stays: z.array(z.object({ id: z.string().max(60), label: z.string().max(100).nullable().default(null), start_date: z.string().max(10), end_date: z.string().max(10) })).default([]),
  feed_seen_at: iso.nullable().default(null),
  changes_seen_at: iso.nullable().default(null),
  last_backup_at: iso.nullable().default(null),
  /** Share the ids of Going/Booked listings (no notes or booking details) so research verifies them first. */
  share_priority: z.boolean().default(true),
});

export type LocalData = z.infer<typeof localDataSchema>;
export type LocalEventState = z.infer<typeof eventStateSchema>;
export type LocalEntry = z.infer<typeof entrySchema>;
export type LocalBooking = z.infer<typeof bookingSchema>;
export type LocalPlan = z.infer<typeof planSchema>;

export const exportFileSchema = z.object({
  format: z.literal('quartet-device-data'),
  version: z.literal(1),
  exported_at: iso,
  data: localDataSchema,
});
export type ExportFile = z.infer<typeof exportFileSchema>;

export function emptyLocalData(deviceId: string): LocalData {
  return localDataSchema.parse({ version: 1, device_id: deviceId });
}

export function makeExport(data: LocalData, now = new Date()): ExportFile {
  return { format: 'quartet-device-data', version: 1, exported_at: now.toISOString(), data };
}

export interface MergeReport {
  states: { added: number; updated: number; unchanged: number };
  entries: { added: number; duplicates: number };
  bookings: { added: number; duplicates: number };
  plans: { added: number; duplicates: number };
  clash_reviews: number;
  feedback: number;
  stays: { added: number; duplicates: number };
}

const RANK = { none: 0, interested: 1, going: 2, booked: 3 } as const;
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Merge an imported file into this device's data. Nothing is deleted. For each event the
 * more recently changed state wins, the stronger plan status is kept, favourites and
 * hidden flags are combined and differing notes are kept side by side. Records already
 * present (same id, or same identifying details) are skipped as duplicates.
 */
export function mergeLocalData(current: LocalData, incoming: LocalData): { data: LocalData; report: MergeReport } {
  const out: LocalData = structuredClone(current);
  const r: MergeReport = {
    states: { added: 0, updated: 0, unchanged: 0 },
    entries: { added: 0, duplicates: 0 },
    bookings: { added: 0, duplicates: 0 },
    plans: { added: 0, duplicates: 0 },
    clash_reviews: 0,
    feedback: 0,
    stays: { added: 0, duplicates: 0 },
  };

  for (const [id, inc] of Object.entries(incoming.states)) {
    const cur = out.states[id];
    if (!cur) {
      out.states[id] = inc;
      r.states.added++;
      continue;
    }
    const newer = inc.updated_at > cur.updated_at ? inc : cur;
    let notes = newer.notes;
    if (cur.notes && inc.notes && norm(cur.notes) !== norm(inc.notes)) {
      if (cur.notes.includes(inc.notes)) notes = cur.notes;
      else if (inc.notes.includes(cur.notes)) notes = inc.notes;
      else notes = `${cur.notes}\n\n${inc.notes}`;
    } else notes = cur.notes ?? inc.notes;
    const merged: LocalEventState = {
      favourite: cur.favourite || inc.favourite,
      hidden: newer.hidden,
      plan_status: RANK[inc.plan_status] > RANK[cur.plan_status] ? inc.plan_status : cur.plan_status,
      occurrence_id: newer.occurrence_id ?? cur.occurrence_id ?? inc.occurrence_id,
      notes,
      updated_at: newer.updated_at,
      snapshot: newer.snapshot ?? cur.snapshot ?? inc.snapshot,
    };
    if (JSON.stringify(merged) === JSON.stringify(cur)) r.states.unchanged++;
    else {
      out.states[id] = merged;
      r.states.updated++;
    }
  }

  for (const e of incoming.entries) {
    const dup = out.entries.some((x) => x.id === e.id || (norm(x.title) === norm(e.title) && x.start === e.start && norm(x.city) === norm(e.city)));
    if (dup) r.entries.duplicates++;
    else {
      out.entries.push(e);
      r.entries.added++;
    }
  }

  // Bookings for an entry that was a duplicate point at the existing entry instead.
  const entryAlias = new Map<string, string>();
  for (const e of incoming.entries) {
    const match = out.entries.find((x) => x.id !== e.id && norm(x.title) === norm(e.title) && x.start === e.start && norm(x.city) === norm(e.city));
    if (match && !out.entries.some((x) => x.id === e.id)) entryAlias.set(e.id, match.id);
  }
  for (const b of incoming.bookings) {
    const target = entryAlias.get(b.target) ?? b.target;
    const dup = out.bookings.some(
      (x) => x.id === b.id || (x.target === target && norm(x.reference) === norm(b.reference) && norm(x.provider) === norm(b.provider) && (x.amount ?? null) === (b.amount ?? null)),
    );
    if (dup) r.bookings.duplicates++;
    else {
      out.bookings.push({ ...b, target });
      r.bookings.added++;
    }
  }

  for (const p of incoming.plans) {
    const dup = out.plans.some((x) => x.id === p.id || (norm(x.title) === norm(p.title) && x.start === p.start));
    if (dup) r.plans.duplicates++;
    else {
      out.plans.push(p);
      r.plans.added++;
    }
  }

  for (const c of incoming.clash_reviews) {
    if (!out.clash_reviews.includes(c)) {
      out.clash_reviews.push(c);
      r.clash_reviews++;
    }
  }
  for (const f of incoming.feedback) {
    if (!out.feedback.some((x) => x.event_id === f.event_id && x.at === f.at)) {
      out.feedback.push(f);
      r.feedback++;
    }
  }
  for (const s of incoming.stays) {
    if (out.stays.some((x) => x.id === s.id || (x.start_date === s.start_date && x.end_date === s.end_date))) r.stays.duplicates++;
    else {
      out.stays.push(s);
      r.stays.added++;
    }
  }
  return { data: out, report: r };
}

/** Parse an export file (or throw a readable error). */
export function parseExport(raw: unknown): ExportFile {
  const p = exportFileSchema.safeParse(raw);
  if (!p.success) {
    const first = p.error.issues[0];
    throw new Error(`This is not a valid ${'Quartet'} backup file${first ? ` (${first.path.join('.')}: ${first.message})` : ''}`);
  }
  return p.data;
}

/**
 * Local "fewer like this" feedback applied to a central highlight score, mirroring the
 * server's weighting (−8 per matching category or genre, at most −30).
 */
export function demotedScore(e: { score: number; categories: string[]; genres: string[] }, feedback: LocalData['feedback']) {
  let n = 0;
  for (const f of feedback) {
    for (const c of e.categories) if (f.categories.includes(c)) n++;
    for (const g of e.genres) if (f.genres.includes(g)) n++;
  }
  return e.score + Math.max(-30, -8 * n);
}
