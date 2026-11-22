import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { Palmtree, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { WEEKDAYS } from '../../shared/taxonomy';
import { EventCard } from '../components/EventCard';
import { Badge, Empty, ErrorNote, PageHeader, Segmented, Spinner } from '../components/ui';
import { api, errorMessage, get, qs } from '../lib/api';
import { fullDay } from '../lib/format';
import { useToast, useUrlState } from '../lib/hooks';

function dateRange(a: string | null, b: string | null) {
  if (!a && !b) return 'Dates to be announced';
  const f = (x: string) => DateTime.fromISO(x).setLocale('en-GB').toFormat('d LLL');
  return `${a ? f(a) : '?'} – ${b ? f(b) : '?'}`;
}

export function IbizaPage() {
  const now = DateTime.now();
  const defaultSeason = String(now.month >= 10 ? now.year + 1 : now.year);
  const [s, set] = useUrlState({ season: defaultSeason, tab: 'parties', from: '', to: '' });
  const qc = useQueryClient();
  const toast = useToast();
  const stays = useQuery({ queryKey: ['stays'], queryFn: () => get('/api/ibiza/stays') });
  const q = useQuery({
    queryKey: ['ibiza', s.season, s.from, s.to],
    queryFn: () => get(`/api/ibiza${qs({ season: s.season, stay_from: s.from && s.to ? s.from : undefined, stay_to: s.from && s.to ? s.to : undefined })}`),
    placeholderData: (p) => p,
  });
  const d = q.data;
  const seasons = [now.year - 1, now.year, now.year + 1, now.year + 2].map(String);
  const parties = d?.stay_parties ?? d?.parties ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Ibiza"
        sub="Residencies, parties and your artists on the island."
        actions={
          <label className="select-label">
            <span className="sr-only">Season</span>
            <select value={s.season} onChange={(e) => set({ season: e.target.value })}>
              {seasons.map((y) => (
                <option key={y} value={y}>
                  Season {y}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <section className="card stay-card" aria-labelledby="stay-h">
        <h2 id="stay-h">My stay</h2>
        <div className="date-inputs">
          <label>
            <span>Arrive</span>
            <input type="date" value={s.from} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label>
            <span>Leave</span>
            <input type="date" value={s.to} min={s.from} onChange={(e) => set({ to: e.target.value })} />
          </label>
          {s.from && s.to && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    await api('POST', '/api/ibiza/stays', { start_date: s.from, end_date: s.to });
                    toast('Stay saved');
                    qc.invalidateQueries({ queryKey: ['stays'] });
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                Save these dates
              </button>
              <button type="button" className="btn btn-link" onClick={() => set({ from: '', to: '' })}>
                Clear
              </button>
            </>
          )}
        </div>
        {(stays.data?.stays ?? []).length > 0 && (
          <ul className="stay-list">
            {stays.data.stays.map((st: any) => (
              <li key={st.id}>
                <button type="button" className="chip" onClick={() => set({ from: st.start_date, to: st.end_date, season: st.start_date.slice(0, 4) })}>
                  {st.label ? `${st.label}: ` : ''}
                  {dateRange(st.start_date, st.end_date)} {st.start_date.slice(0, 4)}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Delete saved stay"
                  onClick={async () => {
                    await api('DELETE', `/api/ibiza/stays/${st.id}`);
                    qc.invalidateQueries({ queryKey: ['stays'] });
                  }}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {d?.stay && (
          <p className="range-label">
            <strong>{parties.length}</strong> part{parties.length === 1 ? 'y' : 'ies'} with confirmed dates during your stay ({fullDay(d.stay.from)} – {fullDay(d.stay.to)}), and{' '}
            {d.residencies.filter((r: any) => r.overlaps_stay).length} residencies running.
          </p>
        )}
      </section>

      <Segmented
        label="View"
        value={s.tab}
        onChange={(v) => set({ tab: v })}
        options={[
          { value: 'parties', label: d?.stay ? 'Parties during my stay' : 'Parties', count: parties.length },
          { value: 'residencies', label: 'Residencies', count: d?.residencies.length },
          { value: 'week', label: 'Week overview' },
          { value: 'openings', label: 'Openings and closings', count: d?.openings.length },
        ]}
      />
      <ErrorNote error={q.error} />
      {q.isLoading && <Spinner />}

      {d && s.tab === 'parties' && (
        parties.length ? (
          <div className="card-grid">
            {parties.map((e: any) => (
              <EventCard key={e.id} e={e} />
            ))}
          </div>
        ) : (
          <Empty title="No dated parties yet" icon={<Palmtree size={28} />}>
            Residency announcements are listed under Residencies until confirmed dates and lineups appear.
          </Empty>
        )
      )}

      {d && s.tab === 'residencies' && (
        d.residencies.length ? (
          <div className="card-grid">
            {d.residencies.map((r: any) => (
              <article key={r.id} className={`card residency-card ${r.overlaps_stay === false ? 'dim' : ''}`}>
                <p className="card-when">
                  {r.weekday ? `${WEEKDAYS[r.weekday - 1]}s` : 'Day to be announced'} · {dateRange(r.start_date, r.end_date)}
                </p>
                <h3 className="card-title">{r.title}</h3>
                <p className="card-place">
                  {r.venue_name}
                  {r.venue_town ? ` · ${r.venue_town}` : ''}
                </p>
                {r.residents.length > 0 && (
                  <p className="card-artists">
                    Residents:{' '}
                    {r.residents.map((x: any, i: number) => (
                      <span key={x.id} className={x.followed ? 'followed' : ''}>
                        {i > 0 && ', '}
                        <Link to={`/artists/${x.id}`}>{x.name}</Link>
                      </span>
                    ))}
                  </p>
                )}
                <div className="tags">
                  <Badge tone={r.status === 'confirmed' ? 'ok' : r.status === 'cancelled' ? 'danger' : 'info'} title="A residency announcement is not a confirmed appearance on a particular date">
                    Residency {r.status}
                  </Badge>
                  <span className="tag">{r.party_count} dated parties listed</span>
                  {r.is_demo && <Badge tone="demo">Demo</Badge>}
                  {r.overlaps_stay && <Badge tone="ok">During your stay</Badge>}
                </div>
                {r.description && <p className="small">{r.description}</p>}
                {(r.ticket_url || r.announcement_url) && (
                  <p className="small link-row">
                    {r.announcement_url && <a href={r.announcement_url} target="_blank" rel="noreferrer">Announcement</a>}
                    {r.ticket_url && <a href={r.ticket_url} target="_blank" rel="noreferrer">Tickets</a>}
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty title={`No residencies recorded for ${s.season} yet`} />
        )
      )}

      {d && s.tab === 'week' && (
        <div className="table-wrap">
          <table className="week-table">
            <caption className="sr-only">Residencies by venue and day of the week</caption>
            <thead>
              <tr>
                <th scope="col">Venue</th>
                {WEEKDAYS.map((w) => (
                  <th key={w} scope="col">
                    <abbr title={w}>{w.slice(0, 3)}</abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.venues.map((v: any) => (
                <tr key={v.id}>
                  <th scope="row">{v.name}</th>
                  {WEEKDAYS.map((_, i) => {
                    const here = d.residencies.filter((r: any) => r.venue_id === v.id && r.weekday === i + 1);
                    return (
                      <td key={i}>
                        {here.map((r: any) => (
                          <div key={r.id} className={`wk-cell wk-${r.status}`}>
                            <strong>{r.brand ?? r.title}</strong>
                            <span>{r.residents.map((x: any) => x.name).join(', ')}</span>
                          </div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!d.venues.length && <Empty title="No residencies to show" />}
        </div>
      )}

      {d && s.tab === 'openings' && (
        d.openings.length ? (
          <div className="card-grid">
            {d.openings.map((e: any) => (
              <EventCard key={e.id} e={e} />
            ))}
          </div>
        ) : (
          <Empty title="No opening or closing parties announced yet" />
        )
      )}
    </div>
  );
}
