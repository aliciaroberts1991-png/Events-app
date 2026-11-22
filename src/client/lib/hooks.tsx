import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage, get } from './api';
import type { EventState, Meta } from './types';

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

/** Saving any personal change refreshes every view that shows it. */
export function useEventState(eventId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: Partial<Pick<EventState, 'favourite' | 'hidden' | 'plan_status' | 'occurrence_id' | 'notes'>> & { version?: number }) =>
      api('PUT', `/api/events/${eventId}/state`, patch),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'meta' }),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
}

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'meta' || true });
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
