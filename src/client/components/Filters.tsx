import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { CATEGORY_GROUPS, GENRES } from '../../shared/taxonomy';
import { get } from '../lib/api';
import { catLabel, genreLabel, PLANNING_TZ } from '../lib/format';
import { Dialog, Segmented } from './ui';

export interface FilterState extends Record<string, string> {
  mode: string;
  loc: string;
  nearby: string;
  radius: string;
  range: string;
  from: string;
  to: string;
  cats: string;
  genres: string;
  english: string;
  sort: string;
  followed: string;
}

export const DEFAULT_FILTERS: FilterState = {
  mode: 'highlights',
  loc: 'all4',
  nearby: '',
  radius: '',
  range: 'upcoming',
  from: '',
  to: '',
  cats: '',
  genres: '',
  english: '',
  sort: 'date',
  followed: '',
};

export function filtersToQuery(f: FilterState, fixed: Record<string, string | undefined> = {}) {
  const locScope = f.loc === 'europe' ? 'europe' : f.loc === 'ibiza' ? 'ibiza' : 'local';
  return {
    mode: f.mode,
    scope: locScope,
    hubs: ['all4', 'europe', 'ibiza'].includes(f.loc) ? undefined : f.loc,
    nearby: f.nearby || undefined,
    radius: f.radius || undefined,
    range: f.range,
    from: f.range === 'custom' ? f.from : undefined,
    to: f.range === 'custom' ? f.to : undefined,
    categories: f.cats || undefined,
    genres: f.genres || undefined,
    english: f.english || undefined,
    followed: f.followed || undefined,
    sort: f.sort,
    ...fixed,
  };
}

export function ModeToggle({ value, onChange, counts }: { value: string; onChange: (v: string) => void; counts?: { highlights: number; all: number } }) {
  return (
    <Segmented
      size="lg"
      label="Show"
      value={value}
      onChange={onChange}
      options={[
        { value: 'highlights', label: 'Highlights', count: counts?.highlights },
        { value: 'all', label: 'All events', count: counts?.all },
      ]}
    />
  );
}

const DATE_CHIPS: [string, string][] = [
  ['upcoming', 'Any time'],
  ['today', 'Today'],
  ['this-weekend', 'This weekend'],
  ['next-weekend', 'Next weekend'],
  ['this-month', 'This month'],
  ['custom', 'Choose dates'],
];

export function DateFilter({ f, set, label }: { f: FilterState; set: (p: Partial<FilterState>) => void; label?: string }) {
  return (
    <div className="date-filter">
      <div className="chip-row" role="radiogroup" aria-label="Dates">
        {DATE_CHIPS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={f.range === v}
            className={`chip ${f.range === v ? 'on' : ''}`}
            onClick={() => {
              if (v === 'custom' && !f.from) {
                const today = DateTime.now().setZone(PLANNING_TZ);
                set({ range: v, from: today.toISODate()!, to: today.plus({ days: 14 }).toISODate()! });
              } else set({ range: v });
            }}
          >
            {l}
          </button>
        ))}
      </div>
      {f.range === 'custom' && (
        <div className="date-inputs">
          <label>
            <span>From</span>
            <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={f.to} min={f.from} onChange={(e) => set({ to: e.target.value })} />
          </label>
        </div>
      )}
      {label && f.range !== 'upcoming' && (
        <p className="range-label" aria-live="polite">
          <span className="muted">Showing</span> {label}
        </p>
      )}
    </div>
  );
}

export function LocationSelect({ f, set, hubs, allowIbiza = true }: { f: FilterState; set: (p: Partial<FilterState>) => void; hubs: { slug: string; name: string }[]; allowIbiza?: boolean }) {
  const prefs = useQuery({ queryKey: ['preferences'], queryFn: () => get('/api/preferences') });
  const p = prefs.data?.data;
  const nearbyOn = f.nearby ? f.nearby === '1' : p?.includeNearby ?? true;
  const radius = f.radius || String(p?.nearbyRadiusKm ?? 40);
  const local = !['europe', 'ibiza'].includes(f.loc);
  return (
    <div className="loc-filter">
      <label className="select-label">
        <span className="sr-only">Location</span>
        <select value={f.loc} onChange={(e) => set({ loc: e.target.value })}>
          <option value="all4">All four cities</option>
          {hubs.map((h) => (
            <option key={h.slug} value={h.slug}>
              {h.name}
            </option>
          ))}
          {allowIbiza && <option value="ibiza">Ibiza</option>}
          <option value="europe">Anywhere in Europe</option>
        </select>
      </label>
      {local && (
        <>
          <label className="inline-check">
            <input type="checkbox" checked={nearbyOn} onChange={(e) => set({ nearby: e.target.checked ? '1' : '0' })} />
            Include nearby
          </label>
          {nearbyOn && (
            <label className="select-label">
              <span className="sr-only">Nearby distance</span>
              <select value={radius} onChange={(e) => set({ radius: e.target.value })}>
                {[10, 20, 30, 40, 60, 80, 120].map((km) => (
                  <option key={km} value={km}>
                    within {km} km
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </div>
  );
}

export function MultiPicker({ kind, value, onChange }: { kind: 'categories' | 'genres'; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(value);
  const groups =
    kind === 'categories'
      ? CATEGORY_GROUPS.map((g) => ({ slug: g.slug, label: g.label, children: g.children.map(([s, l]) => ({ slug: s, label: l })) }))
      : GENRES.filter((g) => !g.parent).map((g) => ({ slug: g.slug, label: g.label, children: GENRES.filter((c) => c.parent === g.slug).map((c) => ({ slug: c.slug, label: c.label })) }));
  const toggle = (s: string) => setDraft((d) => (d.includes(s) ? d.filter((x) => x !== s) : [...d, s]));
  const label = kind === 'categories' ? 'Categories' : 'Genres';
  const summary = value.length ? value.slice(0, 2).map((v) => (kind === 'genres' ? genreLabel(v) : catLabel(v))).join(', ') + (value.length > 2 ? ` +${value.length - 2}` : '') : `All ${label.toLowerCase()}`;
  return (
    <>
      <button
        type="button"
        className={`chip chip-select ${value.length ? 'on' : ''}`}
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
        aria-haspopup="dialog"
      >
        <SlidersHorizontal size={14} aria-hidden />
        <span className="sr-only">{label}: </span>
        {summary}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label} wide>
        <div className="picker">
          {groups.map((g) => (
            <fieldset key={g.slug} className="picker-group">
              <legend>
                <label className="inline-check strong">
                  <input type="checkbox" checked={draft.includes(g.slug)} onChange={() => toggle(g.slug)} />
                  {g.label}
                  {g.children.length > 0 && <span className="muted"> (all)</span>}
                </label>
              </legend>
              <div className="picker-children">
                {g.children.map((c) => (
                  <label key={c.slug} className="inline-check">
                    <input type="checkbox" checked={draft.includes(c.slug) || draft.includes(g.slug)} disabled={draft.includes(g.slug)} onChange={() => toggle(c.slug)} />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setDraft([])}>
            Clear
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
          >
            Apply
          </button>
        </div>
      </Dialog>
    </>
  );
}

export function SortSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="select-label">
      <span className="sr-only">Sort by</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="date">Sort: date</option>
        <option value="relevance">Sort: relevance</option>
        <option value="recent">Sort: recently added</option>
      </select>
    </label>
  );
}

export function FilterBar({
  f,
  set,
  hubs,
  rangeLabel,
  hideLocation,
  extra,
}: {
  f: FilterState;
  set: (p: Partial<FilterState>) => void;
  hubs: { slug: string; name: string }[];
  rangeLabel?: string;
  hideLocation?: boolean;
  extra?: React.ReactNode;
}) {
  const active = [f.cats, f.genres, f.english, f.followed].filter(Boolean).length + (f.range !== 'upcoming' ? 1 : 0) + (f.loc !== 'all4' ? 1 : 0);
  const secondary = [f.cats, f.genres, f.english, f.followed].filter(Boolean).length + (f.sort !== 'date' ? 1 : 0);
  const [more, setMore] = useState(false);
  return (
    <div className="filters" role="group" aria-label="Filters">
      <div className="filter-row">
        {!hideLocation && <LocationSelect f={f} set={set} hubs={hubs} />}
        <button type="button" className={`chip filter-toggle ${secondary ? 'on-soft' : ''}`} aria-expanded={more} aria-controls="more-filters" onClick={() => setMore(!more)}>
          <SlidersHorizontal size={14} aria-hidden /> Filters{secondary ? ` (${secondary})` : ''}
        </button>
        <div id="more-filters" className={`filter-more ${more ? 'open' : ''}`}>
          <MultiPicker kind="categories" value={f.cats ? f.cats.split(',') : []} onChange={(v) => set({ cats: v.join(',') })} />
          <MultiPicker kind="genres" value={f.genres ? f.genres.split(',') : []} onChange={(v) => set({ genres: v.join(',') })} />
          <label className="inline-check chip-check">
            <input type="checkbox" checked={f.english === '1'} onChange={(e) => set({ english: e.target.checked ? '1' : '' })} />
            English-friendly
          </label>
          {extra}
          <SortSelect value={f.sort} onChange={(v) => set({ sort: v })} />
          {active > 0 && (
            <button type="button" className="btn btn-link" onClick={() => set({ ...DEFAULT_FILTERS, mode: f.mode })}>
              Reset filters
            </button>
          )}
        </div>
      </div>
      <DateFilter f={f} set={set} label={rangeLabel} />
    </div>
  );
}
