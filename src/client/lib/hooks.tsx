import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { demotedScore } from '../../shared/local-data';
import { get } from './api';
import { setEditorUnlocked, setEventState, snapshotOf, stateOf, useLocal } from './local';
import type { EventSummary, Meta } from './types';

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => get<Meta>('/api/meta'), staleTime: 5 * 60_000 });
}

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => get('/api/status'), refetchInterval: 30_000 });
}

export function useHubNames() {
  const meta = useMeta();
  const names: Record<string, string> = { ibiza: 'Ibiza' };
  for (const h of meta.data?.hubs ?? []) names[h.slug] = h.name;
  return names;
}

/** Editing (central data) is unlocked on this device. */
export function useEditor() {
  const q = useQuery({ queryKey: ['auth'], queryFn: () => get('/api/auth/state'), staleTime: 60_000 });
  const unlocked = !!q.data?.editor;
  useEffect(() => setEditorUnlocked(unlocked), [unlocked]);
  return { unlocked, configured: !!q.data?.editing_configured, loading: q.isLoading };
}

export function usePublicPrefs() {
  return useQuery({ queryKey: ['preferences'], queryFn: () => get('/api/preferences'), staleTime: 60_000 });
}

/** This device's state for an event, and a setter that also stores a readable snapshot. */
export function useEventState(e: { id: string } & Partial<Pick<EventSummary, 'title' | 'start_local' | 'end_local' | 'timezone' | 'city' | 'venue'>>) {
  const d = useLocal();
  const state = stateOf(d, e.id);
  const set = (patch: Parameters<typeof setEventState>[1]) =>
    setEventState(e.id, patch, e.title && e.start_local && e.timezone ? snapshotOf({ title: e.title, start_local: e.start_local, end_local: e.end_local ?? null, timezone: e.timezone, city: e.city ?? null, venue: e.venue ?? null }) : undefined);
  return { state, set, bookings: d.bookings.filter((b) => b.target === e.id) };
}

/**
 * Applies this device's choices to a central list: hidden events are removed and
 * "fewer like this" feedback can drop an item out of Highlights.
 */
export function useDeviceView(items: EventSummary[] | undefined, mode: string, counts?: { highlights: number; all: number }) {
  const d = useLocal();
  const prefs = usePublicPrefs();
  const threshold = prefs.data?.data.highlightThreshold ?? 55;
  const list = items ?? [];
  const hidden = list.filter((e) => stateOf(d, e.id).hidden);
  const demoted = list.filter((e) => e.highlight && !e.artists.some((a) => a.followed) && d.feedback.length && demotedScore(e, d.feedback) < threshold);
  const visible = list.filter((e) => !hidden.includes(e) && !(mode === 'highlights' && demoted.includes(e)));
  const adjusted = counts && {
    highlights: Math.max(0, counts.highlights - (mode === 'highlights' ? hidden.length + demoted.filter((e) => !hidden.includes(e)).length : 0)),
    all: Math.max(0, counts.all - (mode === 'all' ? hidden.length : 0)),
  };
  return { visible, hiddenCount: hidden.length, counts: adjusted };
}

/** Read and write a set of filters in the URL so views are shareable and Back works. */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const state = { ...defaults } as T;
  for (const k of Object.keys(defaults)) {
    const v = params.get(k);
    if (v !== null) (state as Record<string, string>)[k] = v;
  }
  const set = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === '' || v === (defaults as Record<string, string>)[k]) next.delete(k);
            else next.set(k, v as string);
          }
          return next;
        },
        { replace: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams],
  );
  return [state, set] as const;
}

type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
