import { useQuery } from '@tanstack/react-query';
import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EventList } from '../components/EventCard';
import { DEFAULT_FILTERS, FilterBar, filtersToQuery, ModeToggle, type FilterState } from '../components/Filters';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { get, qs } from '../lib/api';
import { relative } from '../lib/format';
import { useMeta, useStatus, useUrlState } from '../lib/hooks';
import type { ListResult } from '../lib/types';

export function Coverage({ areas }: { areas: string[] }) {
  const status = useStatus();
  const meta = useMeta();
  const names: Record<string, string> = { ibiza: 'Ibiza', 'europe-artists': 'Followed artists (Europe)', 'festivals-nearby': 'Nearby festivals', 'festivals-europe': 'European festivals' };
  for (const h of meta.data?.hubs ?? []) names[h.slug] = h.name;
  const cov = (status.data?.coverage ?? []).filter((c: any) => areas.includes(c.area));
  if (!cov.length) return null;
  return (
    <p className="coverage-line">
      <span className="muted">Coverage: </span>
      {cov.map((c: any, i: number) => (
        <span key={c.area}>
          {i > 0 && ' · '}
          {names[c.area] ?? c.area}{' '}
          <span className={c.last_discovery_at ? '' : 'muted'}>{c.last_discovery_at ? `checked ${relative(c.last_discovery_at)}` : 'not yet researched'}</span>
        </span>
      ))}{' '}
      <Link to="/settings/research">Details</Link>
    </p>
  );
}

export function useEventQuery(f: FilterState, fixed: Record<string, string | undefined> = {}, endpoint = '/api/events') {
  return useQuery({ queryKey: ['events', endpoint, f, fixed], queryFn: () => get<ListResult>(`${endpoint}${qs({ ...filtersToQuery(f, fixed), limit: 200 })}`), placeholderData: (p) => p });
}

export function DiscoverPage() {
  const [f, set] = useUrlState<FilterState>(DEFAULT_FILTERS);
  const meta = useMeta();
  const q = useEventQuery(f);
  const hubs = meta.data?.hubs ?? [];
  return (
    <div className="page">
      <PageHeader title="Discover" sub="Events across Bratislava, Vienna, Budapest and Prague — and wherever you choose." actions={<ModeToggle value={f.mode} onChange={(v) => set({ mode: v })} counts={q.data?.counts} />} />
      <FilterBar f={f} set={set} hubs={hubs} rangeLabel={q.data?.range.label} />
      <Coverage areas={f.loc === 'all4' ? ['bratislava', 'vienna', 'budapest', 'prague'] : [f.loc === 'europe' ? 'europe-artists' : f.loc]} />
      <ErrorNote error={q.error} />
      {q.isLoading ? (
        <Spinner />
      ) : (
        <EventList
          items={q.data?.items ?? []}
          rangeStart={q.data?.range.fromDate}
          empty={
            <Empty title={f.mode === 'highlights' && (q.data?.counts.all ?? 0) > 0 ? 'No highlights match these filters' : 'Nothing matches these filters yet'} icon={<Compass size={28} />}>
              {f.mode === 'highlights' && (q.data?.counts.all ?? 0) > 0 ? (
                <button type="button" className="btn btn-primary" onClick={() => set({ mode: 'all' })}>
                  Show all {q.data?.counts.all} events
                </button>
              ) : (
                <p>
                  Try a wider date range or location. New listings arrive when research runs — see <Link to="/settings/research">update status</Link>.
                </p>
              )}
            </Empty>
          }
        />
      )}
      {q.data && q.data.total > q.data.items.length && <p className="muted center">Showing the first {q.data.items.length} of {q.data.total}. Narrow the filters to see more.</p>}
    </div>
  );
}
