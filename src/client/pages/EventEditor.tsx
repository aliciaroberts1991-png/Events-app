import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CATEGORY_GROUPS, COUNTRY_NAMES, GENRES } from '../../shared/taxonomy';
import { ErrorNote, Field, PageHeader, Segmented, Spinner } from '../components/ui';
import { api, errorMessage, get } from '../lib/api';
import { useToast } from '../lib/hooks';
import { PlanForm } from './Calendar';

const COUNTRY_TZ: Record<string, string> = { SK: 'Europe/Bratislava', AT: 'Europe/Vienna', HU: 'Europe/Budapest', CZ: 'Europe/Prague', ES: 'Europe/Madrid', GB: 'Europe/London', DE: 'Europe/Berlin', PT: 'Europe/Lisbon', HR: 'Europe/Zagreb', PL: 'Europe/Warsaw', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', FR: 'Europe/Paris', IT: 'Europe/Rome', IE: 'Europe/Dublin', CH: 'Europe/Zurich', SI: 'Europe/Ljubljana' };
const TIMEZONES = [...new Set(Object.values(COUNTRY_TZ))].sort();
const countries = Object.entries(COUNTRY_NAMES).sort((a, b) => a[1].localeCompare(b[1]));

interface Form {
  title: string;
  kind: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  doors: string;
  timezone: string;
  venueName: string;
  address: string;
  city: string;
  country: string;
  categories: string[];
  genres: string[];
  lineup: { name: string; format: string }[];
  ticketUrl: string;
  priceMin: string;
  priceMax: string;
  currency: string;
  description: string;
  sourceUrl: string;
  languages: string;
}

const EMPTY: Form = {
  title: '',
  kind: 'event',
  startDate: '',
  startTime: '',
  endDate: '',
  endTime: '',
  doors: '',
  timezone: 'Europe/Bratislava',
  venueName: '',
  address: '',
  city: 'Bratislava',
  country: 'SK',
  categories: [],
  genres: [],
  lineup: [],
  ticketUrl: '',
  priceMin: '',
  priceMax: '',
  currency: 'EUR',
  description: '',
  sourceUrl: '',
  languages: '',
};

function toPayload(f: Form) {
  const start = f.startTime ? `${f.startDate}T${f.startTime}` : f.startDate;
  const end = f.endDate || f.endTime ? (f.endTime ? `${f.endDate || f.startDate}T${f.endTime}` : f.endDate) : null;
  return {
    title: f.title,
    kind: f.kind,
    start,
    end,
    doors: f.doors || null,
    timezone: f.timezone,
    venue: f.venueName || f.city ? { name: f.venueName || f.city, address: f.address || null, city: f.city || null, country: f.country || null } : null,
    categories: f.categories,
    genres: f.genres,
    categories_mode: 'replace',
    genres_mode: 'replace',
    lineup: f.lineup.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), format: l.format, billing: 'headliner' })),
    lineup_mode: 'replace',
    tickets: { url: f.ticketUrl || null, price_min: f.priceMin ? Number(f.priceMin) : null, price_max: f.priceMax ? Number(f.priceMax) : null, currency: f.currency || null },
    description: f.description || null,
    languages: f.languages ? f.languages.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null,
    sources: f.sourceUrl ? [{ url: f.sourceUrl, type: 'user' }] : undefined,
  };
}

export function EventForm({ eventId }: { eventId?: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Form>(EMPTY);
  const [link, setLink] = useState('');
  const [extractMsg, setExtractMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const existing = useQuery({ queryKey: ['event', eventId], queryFn: () => get(`/api/events/${eventId}`), enabled: !!eventId });

  useEffect(() => {
    const e = existing.data;
    if (!e) return;
    setF({
      title: e.title,
      kind: e.kind,
      startDate: e.start_local.slice(0, 10),
      startTime: e.start_local.slice(11, 16),
      endDate: e.end_local ? e.end_local.slice(0, 10) : '',
      endTime: e.end_local ? e.end_local.slice(11, 16) : '',
      doors: e.doors_local ? e.doors_local.slice(11, 16) : '',
      timezone: e.timezone,
      venueName: e.venue_detail?.name ?? '',
      address: e.venue_detail?.address ?? '',
      city: e.city ?? '',
      country: e.country ?? '',
      categories: e.categories,
      genres: e.genres,
      lineup: e.artists.map((a: any) => ({ name: a.name, format: a.format })),
      ticketUrl: e.ticket_url ?? '',
      priceMin: e.price_min?.toString() ?? '',
      priceMax: e.price_max?.toString() ?? '',
      currency: e.currency ?? 'EUR',
      description: e.description ?? '',
      sourceUrl: e.sources?.[0]?.url ?? '',
      languages: (e.languages ?? []).join(', '),
    });
  }, [existing.data]);

  const upd = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const toggleIn = (k: 'categories' | 'genres', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });

  const extract = async () => {
    setBusy(true);
    setExtractMsg(null);
    try {
      const r = await api('POST', '/api/events/extract', { url: link });
      setExtractMsg(r.message);
      const d = r.draft ?? {};
      setF((cur) => ({
        ...cur,
        title: d.title ?? cur.title,
        description: d.description ?? cur.description,
        startDate: d.start ? d.start.slice(0, 10) : cur.startDate,
        startTime: d.start && d.start.length > 10 ? d.start.slice(11, 16) : cur.startTime,
        endDate: d.end ? d.end.slice(0, 10) : cur.endDate,
        endTime: d.end && d.end.length > 10 ? d.end.slice(11, 16) : cur.endTime,
        timezone: d.timezone ?? cur.timezone,
        venueName: d.venue?.name ?? cur.venueName,
        address: d.venue?.address ?? cur.address,
        city: d.venue?.city ?? cur.city,
        country: d.venue?.country ?? cur.country,
        lineup: d.lineup?.length ? d.lineup.map((l: any) => ({ name: l.name, format: 'unknown' })) : cur.lineup,
        ticketUrl: d.tickets?.url ?? cur.ticketUrl,
        priceMin: d.tickets?.price_min?.toString() ?? cur.priceMin,
        priceMax: d.tickets?.price_max?.toString() ?? cur.priceMax,
        currency: d.tickets?.currency ?? cur.currency,
        sourceUrl: link,
      }));
    } catch (e) {
      setExtractMsg(errorMessage(e));
      setF((cur) => ({ ...cur, sourceUrl: link }));
    } finally {
      setBusy(false);
    }
  };

  if (eventId && existing.isLoading) return <Spinner />;

  return (
    <form
      className="form editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          const r = eventId ? await api('PUT', `/api/events/${eventId}`, toPayload(f)) : await api('POST', '/api/events', toPayload(f));
          toast(eventId ? 'Event updated' : 'Event added');
          qc.invalidateQueries();
          nav(`/events/${r.id}`);
        } catch (x) {
          setErr(errorMessage(x));
        }
      }}
    >
      {!eventId && (
        <fieldset className="card">
          <legend>Start from a link (optional)</legend>
          <div className="inline-form">
            <label className="grow">
              <span className="sr-only">Event page link</span>
              <input type="url" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
            </label>
            <button type="button" className="btn btn-ghost" disabled={!link || busy} onClick={extract}>
              <Link2 size={16} aria-hidden /> Read details
            </button>
          </div>
          {extractMsg && (
            <p className="small" role="status">
              {extractMsg}
            </p>
          )}
        </fieldset>
      )}

      <fieldset className="card">
        <legend>Event</legend>
        <Field label="Title">
          <input required value={f.title} onChange={upd('title')} />
        </Field>
        <Field label="Type">
          <select value={f.kind} onChange={upd('kind')}>
            <option value="event">Single event</option>
            <option value="festival">Festival</option>
          </select>
        </Field>
        <div className="form-row">
          <Field label="Date">
            <input type="date" required value={f.startDate} onChange={upd('startDate')} />
          </Field>
          <Field label="Start time" hint="Leave empty if not announced">
            <input type="time" value={f.startTime} onChange={upd('startTime')} />
          </Field>
          <Field label="Doors">
            <input type="time" value={f.doors} onChange={upd('doors')} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="End date" hint="For multi-day events">
            <input type="date" value={f.endDate} min={f.startDate} onChange={upd('endDate')} />
          </Field>
          <Field label="Finish time" hint="Earlier than the start means it ends the next morning">
            <input type="time" value={f.endTime} onChange={upd('endTime')} />
          </Field>
          <Field label="Time zone">
            <select value={f.timezone} onChange={upd('timezone')}>
              {TIMEZONES.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="card">
        <legend>Place</legend>
        <div className="form-row">
          <Field label="Venue">
            <input value={f.venueName} onChange={upd('venueName')} />
          </Field>
          <Field label="Address">
            <input value={f.address} onChange={upd('address')} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Town or city">
            <input required value={f.city} onChange={upd('city')} />
          </Field>
          <Field label="Country">
            <select
              value={f.country}
              onChange={(e) => setF({ ...f, country: e.target.value, timezone: COUNTRY_TZ[e.target.value] ?? f.timezone })}
            >
              {countries.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="card">
        <legend>Categories and genres</legend>
        <div className="picker compact">
          {CATEGORY_GROUPS.map((g) => (
            <div key={g.slug} className="picker-group">
              <p className="strong small">{g.label}</p>
              <div className="picker-children">
                {g.children.map(([s, l]) => (
                  <label key={s} className="inline-check">
                    <input type="checkbox" checked={f.categories.includes(s)} onChange={() => toggleIn('categories', s)} />
                    {l}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <details>
          <summary>Genres</summary>
          <div className="picker-children">
            {GENRES.map((g) => (
              <label key={g.slug} className="inline-check">
                <input type="checkbox" checked={f.genres.includes(g.slug)} onChange={() => toggleIn('genres', g.slug)} />
                {g.label}
              </label>
            ))}
          </div>
        </details>
      </fieldset>

      <fieldset className="card">
        <legend>Lineup</legend>
        {f.lineup.map((l, i) => (
          <div key={i} className="inline-form">
            <label className="grow">
              <span className="sr-only">Artist {i + 1}</span>
              <input value={l.name} placeholder="Artist" onChange={(e) => setF({ ...f, lineup: f.lineup.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            </label>
            <label>
              <span className="sr-only">Format</span>
              <select value={l.format} onChange={(e) => setF({ ...f, lineup: f.lineup.map((x, j) => (j === i ? { ...x, format: e.target.value } : x)) })}>
                <option value="unknown">Format unknown</option>
                <option value="live">Live show</option>
                <option value="dj_set">DJ set</option>
                <option value="hybrid">Hybrid</option>
                <option value="av_show">Audio-visual show</option>
              </select>
            </label>
            <button type="button" className="icon-btn" aria-label={`Remove artist ${i + 1}`} onClick={() => setF({ ...f, lineup: f.lineup.filter((_, j) => j !== i) })}>
              <Trash2 size={16} aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, lineup: [...f.lineup, { name: '', format: 'unknown' }] })}>
          <Plus size={15} aria-hidden /> Add artist
        </button>
      </fieldset>

      <fieldset className="card">
        <legend>Tickets and details</legend>
        <Field label="Official ticket link">
          <input type="url" value={f.ticketUrl} onChange={upd('ticketUrl')} />
        </Field>
        <div className="form-row">
          <Field label="Price from">
            <input inputMode="decimal" value={f.priceMin} onChange={upd('priceMin')} />
          </Field>
          <Field label="Price to">
            <input inputMode="decimal" value={f.priceMax} onChange={upd('priceMax')} />
          </Field>
          <Field label="Currency">
            <select value={f.currency} onChange={upd('currency')}>
              {['EUR', 'CZK', 'HUF', 'GBP', 'CHF', 'PLN'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Languages" hint="Codes such as en, sk, de — leave empty if not relevant">
          <input value={f.languages} onChange={upd('languages')} />
        </Field>
        <Field label="Description">
          <textarea rows={3} value={f.description} onChange={upd('description')} />
        </Field>
        <Field label="Source link">
          <input type="url" value={f.sourceUrl} onChange={upd('sourceUrl')} />
        </Field>
      </fieldset>
      {err && <p className="error-note" role="alert">{err}</p>}
      <div className="form-actions">
        <button className="btn btn-primary">{eventId ? 'Save changes' : 'Add event'}</button>
      </div>
    </form>
  );
}

export function QuickBookingForm() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const watch = useQuery({ queryKey: ['watchlist'], queryFn: () => get('/api/watchlist') });
  const [v, setV] = useState({
    artist_id: params.get('artist') ?? '',
    artist_name: '',
    title: '',
    format: 'unknown',
    date: '',
    time: '',
    venue_name: '',
    city: '',
    country: 'SK',
    provider: '',
    amount: '',
    currency: 'EUR',
    reference: '',
    link: '',
    source_url: '',
    notes: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const upd = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      className="form editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          const r = await api('POST', '/api/bookings/quick', {
            artist_id: v.artist_id || undefined,
            artist_name: !v.artist_id && v.artist_name ? v.artist_name : undefined,
            title: v.title || undefined,
            format: v.format,
            date: v.date,
            time: v.time || null,
            venue_name: v.venue_name || null,
            city: v.city,
            country: v.country,
            timezone: COUNTRY_TZ[v.country],
            categories: ['concert'],
            source_url: v.source_url || null,
            notes: v.notes || undefined,
            booking: {
              provider: v.provider || null,
              amount: v.amount ? Number(v.amount) : null,
              currency: v.currency,
              reference: v.reference || null,
              links: v.link ? [v.link] : [],
            },
          });
          toast('Booking added to your calendar');
          qc.invalidateQueries();
          nav(`/events/${r.id}`);
        } catch (x) {
          setErr(errorMessage(x));
        }
      }}
    >
      <fieldset className="card">
        <legend>What you booked</legend>
        <div className="form-row">
          <Field label="Artist">
            <select value={v.artist_id} onChange={upd('artist_id')}>
              <option value="">Someone else / not an artist</option>
              {(watch.data?.artists ?? []).map((a: any) => (
                <option key={a.artist_id} value={a.artist_id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          {!v.artist_id && (
            <Field label="Artist name (optional)">
              <input value={v.artist_name} onChange={upd('artist_name')} />
            </Field>
          )}
          <Field label="Format">
            <select value={v.format} onChange={upd('format')}>
              <option value="unknown">Not sure</option>
              <option value="live">Live show</option>
              <option value="dj_set">DJ set</option>
            </select>
          </Field>
        </div>
        <Field label="Event title" hint="Leave empty to use the artist’s name">
          <input value={v.title} onChange={upd('title')} required={!v.artist_id && !v.artist_name} />
        </Field>
        <div className="form-row">
          <Field label="Date">
            <input type="date" required value={v.date} onChange={upd('date')} min={DateTime.now().minus({ years: 2 }).toISODate()!} />
          </Field>
          <Field label="Start time (if known)">
            <input type="time" value={v.time} onChange={upd('time')} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Venue">
            <input value={v.venue_name} onChange={upd('venue_name')} />
          </Field>
          <Field label="Town or city">
            <input required value={v.city} onChange={upd('city')} />
          </Field>
          <Field label="Country">
            <select value={v.country} onChange={upd('country')}>
              {countries.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>
      <fieldset className="card">
        <legend>Booking details (optional)</legend>
        <div className="form-row">
          <Field label="Ticket provider">
            <input value={v.provider} onChange={upd('provider')} />
          </Field>
          <Field label="Booking reference">
            <input value={v.reference} onChange={upd('reference')} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Amount paid">
            <input inputMode="decimal" value={v.amount} onChange={upd('amount')} />
          </Field>
          <Field label="Currency">
            <select value={v.currency} onChange={upd('currency')}>
              {['EUR', 'CZK', 'HUF', 'GBP', 'CHF', 'PLN'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Booking or e-ticket link">
          <input type="url" value={v.link} onChange={upd('link')} />
        </Field>
        <Field label="Event page link">
          <input type="url" value={v.source_url} onChange={upd('source_url')} />
        </Field>
        <Field label="Notes">
          <textarea rows={2} value={v.notes} onChange={upd('notes')} />
        </Field>
      </fieldset>
      {err && <p className="error-note" role="alert">{err}</p>}
      <div className="form-actions">
        <button className="btn btn-primary">Save booking</button>
      </div>
    </form>
  );
}

export function AddPage() {
  const { mode = 'event' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="page narrow">
      <PageHeader title="Add" sub="Your own entries stay private and are never changed by research updates.">
        <Segmented
          label="What to add"
          value={mode}
          onChange={(v) => nav(`/add/${v}`, { replace: true })}
          options={[
            { value: 'event', label: 'An event' },
            { value: 'booking', label: 'A booking I already have' },
            { value: 'plan', label: 'A personal plan' },
          ]}
        />
      </PageHeader>
      {mode === 'event' && <EventForm />}
      {mode === 'booking' && <QuickBookingForm />}
      {mode === 'plan' && (
        <div className="card">
          <PlanForm
            onDone={() => {
              qc.invalidateQueries();
              nav('/calendar?tab=plans');
            }}
          />
        </div>
      )}
    </div>
  );
}

export function EditEventPage() {
  const { id } = useParams();
  return (
    <div className="page narrow">
      <p className="crumbs">
        <Link to={`/events/${id}`}>Back to event</Link>
      </p>
      <PageHeader title="Edit your event" />
      <ErrorNote error={null} />
      <EventForm eventId={id} />
    </div>
  );
}
