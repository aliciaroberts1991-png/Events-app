// Device-local personal data (favourites, hidden events, plans, notes, bookings, your
// own entries, personal plans, clash reviews, "fewer like this", Ibiza stays).
//
// Stored in this browser's localStorage under one key. Changes in another tab of the
// same browser are picked up through the "storage" event. Nothing here is sent to the
// server, except — when enabled and editing is unlocked — the ids of Going/Booked
// listings (see syncPriority).
import { useSyncExternalStore } from 'react';
import { emptyLocalData, localDataSchema, type LocalBooking, type LocalData, type LocalEntry, type LocalEventState, type LocalPlan } from '../../shared/local-data';

const KEY = 'quartet:device:v1';

function randomId(prefix: string) {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return `${prefix}_${Date.now().toString(36)}${Array.from(a, (b) => (b % 36).toString(36)).join('')}`;
}

export const storageStatus = { available: true, persisted: null as boolean | null, recoveredFromCorruption: false };

function read(): LocalData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = localDataSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      // Never silently discard: keep the unreadable copy for recovery.
      localStorage.setItem(`${KEY}:unreadable:${Date.now()}`, raw);
      storageStatus.recoveredFromCorruption = true;
    }
  } catch {
    storageStatus.available = false;
  }
  return emptyLocalData(randomId('dev'));
}

let data: LocalData = read();
const listeners = new Set<() => void>();

function write(next: LocalData) {
  data = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    storageStatus.available = true;
  } catch {
    storageStatus.available = false;
  }
  for (const l of listeners) l();
  schedulePrioritySync();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      data = read();
      for (const l of listeners) l();
    }
  });
  // Ask the browser not to evict this data under storage pressure.
  navigator.storage?.persist?.().then((p) => (storageStatus.persisted = p)).catch(() => undefined);
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLocal() {
  return data;
}

export function useLocal(): LocalData {
  return useSyncExternalStore(subscribe, getLocal, getLocal);
}

/** Apply a change to a copy and save it. */
export function updateLocal(fn: (d: LocalData) => void) {
  const next = structuredClone(data);
  fn(next);
  write(next);
}

export function replaceLocal(next: LocalData) {
  write({ ...next, device_id: data.device_id });
}

const now = () => new Date().toISOString();

export const DEFAULT_STATE: LocalEventState = { favourite: false, hidden: false, plan_status: 'none', occurrence_id: null, notes: null, updated_at: '' };

export function stateOf(d: LocalData, id: string): LocalEventState {
  return d.states[id] ?? DEFAULT_STATE;
}

export interface Snapshot {
  title: string;
  start_local: string;
  end_local?: string | null;
  timezone: string;
  city?: string | null;
  venue?: string | null;
}

export function setEventState(id: string, patch: Partial<Omit<LocalEventState, 'updated_at' | 'snapshot'>>, snapshot?: Snapshot) {
  updateLocal((d) => {
    const cur = d.states[id] ?? DEFAULT_STATE;
    const next: LocalEventState = { ...cur, ...patch, updated_at: now(), snapshot: snapshot ?? cur.snapshot };
    if (next.notes !== null && !next.notes.trim()) next.notes = null;
    const empty = !next.favourite && !next.hidden && next.plan_status === 'none' && !next.notes && !d.bookings.some((b) => b.target === id) && !id.startsWith('loc_');
    if (empty) delete d.states[id];
    else d.states[id] = next;
  });
}

export function snapshotOf(e: { title: string; start_local: string; end_local: string | null; timezone: string; city: string | null; venue: { name: string } | null }): Snapshot {
  return { title: e.title, start_local: e.start_local, end_local: e.end_local, timezone: e.timezone, city: e.city, venue: e.venue?.name ?? null };
}

// ---- bookings
export function saveBooking(b: Omit<LocalBooking, 'id' | 'created_at' | 'updated_at'> & { id?: string }, alsoMarkBooked = true, snapshot?: Snapshot) {
  updateLocal((d) => {
    const t = now();
    if (b.id) {
      const i = d.bookings.findIndex((x) => x.id === b.id);
      if (i >= 0) d.bookings[i] = { ...d.bookings[i], ...b, id: b.id, updated_at: t };
    } else d.bookings.push({ ...b, id: randomId('bkg'), created_at: t, updated_at: t } as LocalBooking);
    if (alsoMarkBooked) {
      const cur = d.states[b.target] ?? DEFAULT_STATE;
      d.states[b.target] = { ...cur, plan_status: 'booked', updated_at: t, snapshot: snapshot ?? cur.snapshot };
    }
  });
}
export function deleteBooking(id: string) {
  updateLocal((d) => {
    d.bookings = d.bookings.filter((b) => b.id !== id);
  });
}

// ---- own entries (events you add for yourself, e.g. a show you have already booked)
export function saveEntry(e: Omit<LocalEntry, 'id' | 'created_at' | 'updated_at' | 'linked_event_id'> & { id?: string; linked_event_id?: string | null }, status: LocalEventState['plan_status'] = 'going') {
  let id = e.id;
  updateLocal((d) => {
    const t = now();
    if (id) {
      const i = d.entries.findIndex((x) => x.id === id);
      if (i >= 0) d.entries[i] = { ...d.entries[i], ...e, id: id!, updated_at: t };
    } else {
      id = randomId('loc');
      d.entries.push({ linked_event_id: null, ...e, id, created_at: t, updated_at: t } as LocalEntry);
      d.states[id] = { ...DEFAULT_STATE, plan_status: status, updated_at: t };
    }
  });
  return id!;
}
export function deleteEntry(id: string) {
  updateLocal((d) => {
    d.entries = d.entries.filter((x) => x.id !== id);
    d.bookings = d.bookings.filter((b) => b.target !== id);
    delete d.states[id];
  });
}
/** Move notes, status and bookings from your own entry onto a shared listing. */
export function linkEntry(entryId: string, eventId: string, snapshot: Snapshot) {
  updateLocal((d) => {
    const st = d.states[entryId];
    const cur = d.states[eventId] ?? DEFAULT_STATE;
    const rank = { none: 0, interested: 1, going: 2, booked: 3 };
    d.states[eventId] = {
      ...cur,
      plan_status: st && rank[st.plan_status] > rank[cur.plan_status] ? st.plan_status : cur.plan_status,
      notes: [cur.notes, st?.notes].filter(Boolean).join('\n\n') || null,
      favourite: cur.favourite || !!st?.favourite,
      updated_at: now(),
      snapshot,
    };
    for (const b of d.bookings) if (b.target === entryId) b.target = eventId;
    d.entries = d.entries.filter((x) => x.id !== entryId);
    delete d.states[entryId];
  });
}

// ---- personal plans
export function savePlan(p: Omit<LocalPlan, 'id' | 'created_at' | 'updated_at'> & { id?: string }) {
  updateLocal((d) => {
    const t = now();
    if (p.id) {
      const i = d.plans.findIndex((x) => x.id === p.id);
      if (i >= 0) d.plans[i] = { ...d.plans[i], ...p, id: p.id, updated_at: t };
    } else d.plans.push({ ...p, id: randomId('pln'), created_at: t, updated_at: t } as LocalPlan);
  });
}
export function deletePlan(id: string) {
  updateLocal((d) => {
    d.plans = d.plans.filter((x) => x.id !== id);
  });
}

// ---- misc
export function addFeedback(eventId: string, categories: string[], genres: string[]) {
  updateLocal((d) => {
    d.feedback.push({ event_id: eventId, categories, genres, at: now() });
  });
}
export function toggleClashReview(pair: string, reviewed: boolean) {
  updateLocal((d) => {
    d.clash_reviews = d.clash_reviews.filter((x) => x !== pair);
    if (reviewed) d.clash_reviews.push(pair);
  });
}
export function saveStay(s: { label: string | null; start_date: string; end_date: string }) {
  updateLocal((d) => {
    if (!d.stays.some((x) => x.start_date === s.start_date && x.end_date === s.end_date)) d.stays.push({ ...s, id: randomId('stay') });
  });
}
export function deleteStay(id: string) {
  updateLocal((d) => {
    d.stays = d.stays.filter((x) => x.id !== id);
  });
}

// ---- optional sharing of Going/Booked ids for verification priority
let syncTimer: ReturnType<typeof setTimeout> | null = null;
export const priorityStatus = { last: null as null | { at: string; ok: boolean; message: string } };
let editorUnlocked = false;
export function setEditorUnlocked(v: boolean) {
  const changed = v && !editorUnlocked;
  editorUnlocked = v;
  if (changed) schedulePrioritySync();
}
function schedulePrioritySync() {
  if (typeof window === 'undefined') return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPriority, 1500);
}
let lastSent = '';
export async function syncPriority(force = false) {
  if (!editorUnlocked || (!data.share_priority && !force)) return;
  const events: Record<string, 'going' | 'booked'> = {};
  if (data.share_priority) {
    for (const [id, s] of Object.entries(data.states)) if (!id.startsWith('loc_') && (s.plan_status === 'going' || s.plan_status === 'booked')) events[id] = s.plan_status;
  }
  const body = JSON.stringify({ device_id: data.device_id, events });
  if (body === lastSent && !force) return;
  try {
    const res = await fetch('/api/priority-events', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-quartet-csrf': '1' }, credentials: 'same-origin', body });
    lastSent = body;
    priorityStatus.last = { at: now(), ok: res.ok, message: res.ok ? `${Object.keys(events).length} shared` : `HTTP ${res.status}` };
  } catch (e) {
    priorityStatus.last = { at: now(), ok: false, message: e instanceof Error ? e.message : 'network error' };
  }
}

export { randomId };
