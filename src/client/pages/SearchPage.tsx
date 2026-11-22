import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { EventCard } from '../components/EventCard';
import { Empty, PageHeader, Spinner } from '../components/ui';
import { get } from '../lib/api';

export function SearchPage() {
  const [p] = useSearchParams();
  const q = p.get('q') ?? '';
  const r = useQuery({ queryKey: ['search-page', q], queryFn: () => get(`/api/search?q=${encodeURIComponent(q)}`), enabled: q.length >= 2 });
  const d = r.data;
  return (
    <div className="page">
      <PageHeader title={`Results for “${q}”`} />
      {r.isLoading && <Spinner />}
      {d && (
        <>
          {d.cities.length > 0 && (
            <section>
              <h2 className="section-title">Cities</h2>
              <p className="link-row">
                {d.cities.map((c: any) => (
                  <Link key={c.slug} to={c.slug === 'ibiza' ? '/ibiza' : `/cities/${c.slug}`} className="chip">
                    {c.name}
                  </Link>
                ))}
              </p>
            </section>
          )}
          {d.artists.length > 0 && (
            <section>
              <h2 className="section-title">Artists</h2>
              <p className="link-row">
                {d.artists.map((a: any) => (
                  <Link key={a.id} to={`/artists/${a.id}`} className="chip">
                    {a.name}
                  </Link>
                ))}
              </p>
            </section>
          )}
          {d.venues.length > 0 && (
            <section>
              <h2 className="section-title">Venues</h2>
              <ul className="plain-list">
                {d.venues.map((v: any) => (
                  <li key={v.id}>
                    {v.name} <span className="muted">· {[v.town ?? v.city, v.country].filter(Boolean).join(', ')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2 className="section-title">Events</h2>
            {d.events.length ? (
              <div className="card-grid">
                {d.events.map((e: any) => (
                  <EventCard key={e.id} e={e} />
                ))}
              </div>
            ) : (
              <Empty title="No upcoming events match" />
            )}
          </section>
        </>
      )}
    </div>
  );
}
