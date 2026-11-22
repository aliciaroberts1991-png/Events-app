import { Star, Tent } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PlanChip, StatusBadges } from '../components/EventCard';
import { DateFilter, DEFAULT_FILTERS, MultiPicker, SortSelect, type FilterState } from '../components/Filters';
import { Empty, ErrorNote, PageHeader, Segmented, Spinner } from '../components/ui';
import { countryName, dayLabel, formatLabel, genreLabel, placeText, priceText, saleText, whenText } from '../lib/format';
import { useDeviceView, useEventState, useUrlState } from '../lib/hooks';
import type { EventSummary } from '../lib/types';
import { useEventQuery } from './Discover';

function FestivalCard({ e }: { e: EventSummary }) {
  const { state } = useEventState(e);
  const followed = e.artists.filter((a) => a.followed);
  const headliners = e.artists.filter((a) => a.billing === 'headliner' && !a.followed).slice(0, 4);
  const price = priceText(e);
  const sale = saleText(e);
  return (
    <article className="card festival-card">
      <div className="card-top">
        <p className="card-when">{whenText(e, e.timezone, { year: true })}</p>
        <div className="card-flags">
          <PlanChip status={state.plan_status} />
        </div>
      </div>
      <h3 className="card-title">
        <Link to={`/events/${e.id}`} className="stretched">
          {e.festival?.name ?? e.title}
          {e.festival?.edition && <span className="edition"> {e.festival.edition}</span>}
        </Link>
      </h3>
      <p className="card-place">
        {placeText(e)}
        {e.country && <span className="muted"> · {countryName(e.country)}</span>}
      </p>
      {followed.length > 0 && (
        <ul className="followed-list" aria-label="Artists you follow">
          {followed.map((a) => (
            <li key={a.id}>
              <Star size={13} aria-hidden className="star" /> <strong>{a.name}</strong>
              <span className="muted">
                {a.date ? ` · ${dayLabel(a.date)}` : ''} · {formatLabel(a.format)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {headliners.length > 0 && <p className="card-artists">{headliners.map((a) => a.name).join(', ')}{e.artists.length > followed.length + headliners.length ? ` +${e.artists.length - followed.length - headliners.length} more` : ''}</p>}
      <div className="card-foot">
        <div className="tags">
          {e.genres.slice(0, 3).map((g) => (
            <span className="tag" key={g}>
              {genreLabel(g)}
            </span>
          ))}
          {e.camping?.available && (
            <span className="tag">
              <Tent size={12} aria-hidden /> Camping
            </span>
          )}
          <StatusBadges e={e} />
        </div>
        {(sale || price) && <p className="card-price">{sale ?? price}</p>}
      </div>
    </article>
  );
}

export function FestivalsPage() {
  const [f, set] = useUrlState<FilterState & { scope: string; country: string }>({ ...DEFAULT_FILTERS, mode: 'all', scope: 'nearby', country: '' });
  const q = useEventQuery({ ...f, loc: 'europe' }, { festival_scope: f.scope, countries: f.country || undefined, kind: 'festival', scope: 'europe' }, '/api/festivals');
  const view = useDeviceView(q.data?.items, f.mode);
  const all = view.visible;
  const items = f.mode === 'highlights' ? all.filter((e) => e.highlight) : all;
  const countries = [...new Set(all.map((e) => e.country).filter(Boolean))] as string[];
  return (
    <div className="page">
      <PageHeader
        title="Festivals"
        sub="One card per festival edition, with your artists’ days and formats."
        actions={
          <Segmented
            size="lg"
            label="Area"
            value={f.scope}
            onChange={(v) => set({ scope: v, country: '' } as never)}
            options={[
              { value: 'nearby', label: 'Nearby' },
              { value: 'europe', label: 'Across Europe' },
            ]}
          />
        }
      />
      <div className="filters">
        <div className="filter-row">
          <Segmented
            label="Show"
            value={f.mode}
            onChange={(v) => set({ mode: v } as never)}
            options={[
              { value: 'highlights', label: 'Highlights' },
              { value: 'all', label: 'All festivals' },
            ]}
          />
          <MultiPicker kind="genres" value={f.genres ? f.genres.split(',') : []} onChange={(v) => set({ genres: v.join(',') } as never)} />
          <label className="inline-check chip-check">
            <input type="checkbox" checked={f.followed === '1'} onChange={(e) => set({ followed: e.target.checked ? '1' : '' } as never)} />
            Featuring artists I follow
          </label>
          {f.scope === 'europe' && countries.length > 0 && (
            <label className="select-label">
              <span className="sr-only">Country</span>
              <select value={f.country} onChange={(e) => set({ country: e.target.value } as never)}>
                <option value="">All countries</option>
                {countries.sort().map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <SortSelect value={f.sort} onChange={(v) => set({ sort: v } as never)} />
        </div>
        <DateFilter f={f} set={(p) => set(p as never)} label={q.data?.range.label} />
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? (
        <Spinner />
      ) : items.length ? (
        <div className="card-grid">
          {items.map((e) => (
            <FestivalCard key={e.id} e={e} />
          ))}
        </div>
      ) : (
        <Empty title={f.scope === 'nearby' ? 'No nearby festivals match yet' : 'No festivals match yet'} icon={<Tent size={28} />}>
          {f.scope === 'nearby' ? (
            <button type="button" className="btn btn-ghost" onClick={() => set({ scope: 'europe' } as never)}>
              Look across Europe
            </button>
          ) : (
            'Festival listings arrive with research runs.'
          )}
        </Empty>
      )}
    </div>
  );
}
