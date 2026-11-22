import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { CATEGORY_GROUPS } from '../../shared/taxonomy';
import { EventCard } from '../components/EventCard';
import { DEFAULT_FILTERS, FilterBar, ModeToggle, type FilterState } from '../components/Filters';
import { Empty, ErrorNote, PageHeader, Segmented, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { dayLabel, groupOf, relative } from '../lib/format';
import { useMeta, useUrlState } from '../lib/hooks';
import { Coverage, useEventQuery } from './Discover';

export function CitiesPage() {
  const q = useQuery({ queryKey: ['cities'], queryFn: () => get('/api/cities') });
  return (
    <div className="page">
      <PageHeader title="Cities" sub="Browse city by city, or all four together." />
      <ErrorNote error={q.error} />
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="city-grid">
          <Link to="/cities/all" className="card city-card city-all">
            <h2>All four cities</h2>
            <p className="city-stat">
              <strong>{q.data?.cities.reduce((a: number, c: any) => a + c.upcoming, 0)}</strong> upcoming
            </p>
            <span className="city-go">
              Browse together <ArrowRight size={16} aria-hidden />
            </span>
          </Link>
          {q.data?.cities.map((c: any) => (
            <Link key={c.slug} to={`/cities/${c.slug}`} className={`card city-card city-${c.slug}`}>
              <h2>{c.name}</h2>
              <p className="city-stat">
                <strong>{c.upcoming}</strong> upcoming · <strong>{c.highlights}</strong> highlights · <strong>{c.this_week}</strong> in the next 7 days
              </p>
              {c.top.length > 0 && (
                <ul className="city-top">
                  {c.top.map((t: any) => (
                    <li key={t.id}>
                      <span className="muted">{dayLabel(t.start_local)}</span> {t.title}
                    </li>
                  ))}
                </ul>
              )}
              <p className="city-fresh muted">{c.last_discovery_at ? `Researched ${relative(c.last_discovery_at)}` : 'Not yet researched'}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function CityPage() {
  const { slug = 'all' } = useParams();
  const meta = useMeta();
  const hubs = meta.data?.hubs ?? [];
  const hub = hubs.find((h) => h.slug === slug);
  const [f, set] = useUrlState<FilterState & { view: string }>({ ...DEFAULT_FILTERS, view: 'category' });
  const loc = slug === 'all' ? 'all4' : slug;
  const q = useEventQuery({ ...f, loc });
  const items = q.data?.items ?? [];
  const byGroup = CATEGORY_GROUPS.map((g) => ({ ...g, items: items.filter((e) => groupOf(e) === g.slug) })).filter((g) => g.items.length);
  return (
    <div className="page">
      <p className="crumbs">
        <Link to="/cities">Cities</Link>
      </p>
      <PageHeader title={hub?.name ?? 'All four cities'} actions={<ModeToggle value={f.mode} onChange={(v) => set({ mode: v })} counts={q.data?.counts} />} />
      <FilterBar
        f={{ ...f, loc }}
        set={(p) => set(p as never)}
        hubs={hubs}
        rangeLabel={q.data?.range.label}
        hideLocation={false}
        extra={
          <Segmented
            label="Group by"
            value={f.view}
            onChange={(v) => set({ view: v } as never)}
            options={[
              { value: 'category', label: 'By category' },
              { value: 'date', label: 'By date' },
            ]}
          />
        }
      />
      <Coverage areas={slug === 'all' ? ['bratislava', 'vienna', 'budapest', 'prague'] : [slug]} />
      <ErrorNote error={q.error} />
      {q.isLoading ? (
        <Spinner />
      ) : !items.length ? (
        <Empty title="Nothing matches yet">Try All events or a wider date range.</Empty>
      ) : f.view === 'date' ? (
        <div className="card-grid">
          {items.map((e) => (
            <EventCard key={e.id} e={e} />
          ))}
        </div>
      ) : (
        byGroup.map((g) => (
          <section key={g.slug} className="cat-section">
            <h2 className={`cat-head tone-${g.slug}`}>
              {g.label} <span className="muted">{g.items.length}</span>
            </h2>
            <div className="card-grid">
              {g.items.map((e) => (
                <EventCard key={e.id} e={e} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
