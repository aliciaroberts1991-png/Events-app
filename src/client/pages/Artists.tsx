import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Mic2, Pause, Pencil, Play, Plus, Ticket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EventCard } from '../components/EventCard';
import { Badge, Dialog, Empty, ErrorNote, Field, PageHeader, Segmented, Spinner } from '../components/ui';
import { api, errorMessage, get } from '../lib/api';
import { countryName, dayLabel, formatLabel, genreLabel, placeText } from '../lib/format';
import { useToast } from '../lib/hooks';
import { WEEKDAYS } from '../../shared/taxonomy';

interface WatchArtist {
  id: string;
  artist_id: string;
  name: string;
  status: 'active' | 'paused';
  note: string | null;
  aliases: string[];
  links: Record<string, string>;
  genres: string[];
  description: string | null;
  description_verified: boolean;
  appearances: any[];
  residencies: any[];
}

function linksToText(l: Record<string, string>) {
  return Object.entries(l)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
function textToLinks(t: string) {
  const out: Record<string, string> = {};
  for (const line of t.split('\n').map((x) => x.trim()).filter(Boolean)) {
    const m = line.match(/^([a-z_ ]+):\s*(https?:\/\/\S+)$/i);
    if (m) out[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = m[2];
    else if (/^https?:\/\//.test(line)) out[Object.keys(out).length ? `link_${Object.keys(out).length + 1}` : 'official'] = line;
  }
  return out;
}

function ArtistForm({ initial, onSubmit, submitLabel }: { initial?: Partial<WatchArtist>; onSubmit: (v: { name: string; aliases: string[]; links: Record<string, string>; note: string | null }) => Promise<void>; submitLabel: string }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(', '));
  const [links, setLinks] = useState(linksToText(initial?.links ?? {}));
  const [note, setNote] = useState(initial?.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await onSubmit({ name: name.trim(), aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean), links: textToLinks(links), note: note.trim() || null });
        } catch (x) {
          setErr(errorMessage(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Artist name">
        <input required value={name} onChange={(e) => setName(e.target.value)} disabled={!!initial?.id} />
      </Field>
      <Field label="Aliases" hint="Comma-separated, e.g. alternative spellings or side projects">
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </Field>
      <Field label="Identifying links" hint="One per line, e.g. “official: https://…” or “resident_advisor: https://…”. These keep similarly named acts apart.">
        <textarea rows={3} value={links} onChange={(e) => setLinks(e.target.value)} />
      </Field>
      <Field label="Note (private)">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {err && <p className="error-note" role="alert">{err}</p>}
      <div className="dialog-actions">
        <button className="btn btn-primary" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function ArtistsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['artists'], queryFn: () => get<{ artists: WatchArtist[] }>('/api/artists') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WatchArtist | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const refresh = () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'meta' });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api('PUT', `/api/watchlist/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const list = (q.data?.artists ?? []).filter((a) => filter === 'all' || a.status === filter);

  return (
    <div className="page">
      <PageHeader
        title="Artists"
        sub="Your watchlist. Active artists are tracked across Europe, including festivals and Ibiza."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden /> Add artist
          </button>
        }
      >
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: q.data?.artists.length },
            { value: 'active', label: 'Active', count: q.data?.artists.filter((a) => a.status === 'active').length },
            { value: 'paused', label: 'Paused', count: q.data?.artists.filter((a) => a.status === 'paused').length },
          ]}
        />
      </PageHeader>
      <ErrorNote error={q.error} />
      {q.isLoading && <Spinner />}
      {!q.isLoading && !list.length && <Empty title="No artists here yet" icon={<Mic2 size={28} />} />}
      <div className="artist-list">
        {list.map((a) => (
          <article key={a.id} className={`card artist-card ${a.status === 'paused' ? 'is-paused' : ''}`}>
            <header className="artist-head">
              <div>
                <h2>
                  <Link to={`/artists/${a.artist_id}`}>{a.name}</Link>
                </h2>
                <p className="muted small">
                  {a.status === 'paused' ? 'Paused — not being tracked' : `${a.appearances.length} upcoming appearance${a.appearances.length === 1 ? '' : 's'}`}
                  {a.aliases.length > 0 && ` · also ${a.aliases.join(', ')}`}
                </p>
              </div>
              <div className="artist-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => update.mutate({ id: a.id, body: { status: a.status === 'active' ? 'paused' : 'active' } })} aria-label={`${a.status === 'active' ? 'Pause' : 'Resume'} tracking ${a.name}`}>
                  {a.status === 'active' ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
                  {a.status === 'active' ? 'Pause' : 'Resume'}
                </button>
                <button type="button" className="icon-btn" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
                  <Pencil size={17} aria-hidden />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${a.name} from watchlist`}
                  onClick={async () => {
                    if (!confirm(`Remove ${a.name} from your watchlist? Saved events and bookings stay as they are.`)) return;
                    try {
                      await api('DELETE', `/api/watchlist/${a.id}`);
                      toast(`${a.name} removed`);
                      refresh();
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  }}
                >
                  <Trash2 size={17} aria-hidden />
                </button>
              </div>
            </header>
            {a.description ? (
              <p className="artist-desc">
                {a.description} {!a.description_verified && <Badge tone="warn" title="Not yet confirmed by research">Unverified</Badge>}
              </p>
            ) : (
              <p className="artist-desc muted">Introduction pending research.</p>
            )}
            {a.genres.length > 0 && (
              <div className="tags">
                {a.genres.map((g) => (
                  <span key={g} className="tag">
                    {genreLabel(g)}
                  </span>
                ))}
              </div>
            )}
            {a.appearances.length > 0 && (
              <ul className="appearance-list">
                {a.appearances.slice(0, 4).map((e: any) => {
                  const line = e.artists.find((x: any) => x.artist_id === a.artist_id);
                  return (
                    <li key={e.id}>
                      <Link to={`/events/${e.id}`}>
                        <span className="ap-date">{dayLabel(line?.date ?? e.next_occurrence?.start_local ?? e.start_local)}</span>
                        <span className="ap-title">{e.festival ? `${e.festival.name}${e.festival.edition ? ` ${e.festival.edition}` : ''}` : e.title}</span>
                        <span className="ap-meta muted">
                          {placeText(e)}
                          {e.country ? `, ${countryName(e.country)}` : ''} · {formatLabel(line?.format ?? 'unknown')}
                        </span>
                        {e.is_demo && <Badge tone="demo">Demo</Badge>}
                      </Link>
                    </li>
                  );
                })}
                {a.appearances.length > 4 && (
                  <li>
                    <Link to={`/artists/${a.artist_id}`} className="muted">
                      {a.appearances.length - 4} more…
                    </Link>
                  </li>
                )}
              </ul>
            )}
            {a.residencies.length > 0 && (
              <p className="small">
                Ibiza:{' '}
                {a.residencies.map((r: any) => `${r.title} at ${r.venue_name}${r.weekday ? ` (${WEEKDAYS[r.weekday - 1]}s)` : ''} — residency ${r.status}`).join('; ')}
              </p>
            )}
            <p className="small">
              <Link to={`/add/booking?artist=${a.artist_id}`}>
                <Ticket size={14} aria-hidden /> Add a show you’ve already booked
              </Link>
            </p>
          </article>
        ))}
      </div>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add an artist">
        <ArtistForm
          submitLabel="Add to watchlist"
          onSubmit={async (v) => {
            await api('POST', '/api/watchlist', v);
            toast(`${v.name} added — research will pick this up on its next run`);
            setAdding(false);
            refresh();
          }}
        />
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ''}`}>
        {editing && (
          <ArtistForm
            initial={editing}
            submitLabel="Save"
            onSubmit={async (v) => {
              await api('PUT', `/api/watchlist/${editing.id}`, { aliases: v.aliases, links: v.links, note: v.note });
              setEditing(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

export function ArtistDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['artist', id], queryFn: () => get(`/api/artists/${id}`) });
  const a = q.data;
  if (q.isLoading) return <Spinner />;
  if (!a) return <ErrorNote error={q.error} />;
  const links = Object.entries(a.links as Record<string, string>);
  return (
    <div className="page">
      <p className="crumbs">
        <Link to="/artists">Artists</Link>
      </p>
      <PageHeader
        title={a.name}
        sub={a.aliases.length ? `Also known as ${a.aliases.join(', ')}` : undefined}
        actions={
          a.watch ? (
            <Badge tone={a.watch.status === 'active' ? 'ok' : 'neutral'}>{a.watch.status === 'active' ? 'On your watchlist' : 'Paused'}</Badge>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                try {
                  await api('POST', '/api/watchlist', { artist_id: a.id });
                  toast(`${a.name} added to your watchlist`);
                  qc.invalidateQueries();
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              <Plus size={16} aria-hidden /> Follow
            </button>
          )
        }
      />
      <section className="prose">
        {a.description ? (
          <p>
            {a.description} {!a.description_verified && <Badge tone="warn">Unverified</Badge>}
          </p>
        ) : (
          <p className="muted">Introduction pending research.</p>
        )}
        {links.length > 0 && (
          <p className="link-row">
            {links.map(([k, v]) => (
              <a key={k} href={v} target="_blank" rel="noreferrer">
                {k.replace(/_/g, ' ')} <ExternalLink size={13} aria-hidden />
              </a>
            ))}
          </p>
        )}
      </section>
      <h2 className="section-title">Upcoming appearances</h2>
      {a.appearances.length ? (
        <div className="card-grid">
          {a.appearances.map((e: any) => (
            <EventCard key={e.id} e={e} />
          ))}
        </div>
      ) : (
        <Empty title="No confirmed appearances yet" />
      )}
      {a.residencies.length > 0 && (
        <>
          <h2 className="section-title">Ibiza residencies</h2>
          <ul className="plain-list">
            {a.residencies.map((r: any) => (
              <li key={r.id}>
                <strong>{r.title}</strong> at {r.venue_name}, {r.season}
                {r.weekday ? ` · ${WEEKDAYS[r.weekday - 1]}s` : ''} · <Badge tone={r.status === 'confirmed' ? 'ok' : 'info'}>Residency {r.status}</Badge>
              </li>
            ))}
          </ul>
        </>
      )}
      <p>
        <Link className="btn btn-ghost" to={`/add/booking?artist=${a.id}`}>
          <Ticket size={16} aria-hidden /> Add a show you’ve already booked
        </Link>
      </p>
    </div>
  );
}
