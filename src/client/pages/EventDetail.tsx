import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import {
  CalendarCheck,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Heart,
  Info,
  MapPin,
  Pencil,
  Star,
  ThumbsDown,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  LANGUAGE_IMPORTANCE_LABELS,
  PARTICIPATION_LABELS,
  PLAN_STATUS_HELP,
  PLAN_STATUS_LABELS,
  SOURCE_TYPE_LABELS,
  type LanguageImportance,
} from '../../shared/taxonomy';
import { StatusBadges } from '../components/EventCard';
import { Badge, Dialog, ErrorNote, Field, Spinner } from '../components/ui';
import { buildIcs } from '../../shared/calendar';
import type { LocalBooking } from '../../shared/local-data';
import { api, get } from '../lib/api';
import { addFeedback, deleteBooking, saveBooking, snapshotOf, type Snapshot } from '../lib/local';
import { downloadText } from '../lib/plans';
import {
  catLabel,
  countryName,
  dayLabel,
  dt,
  formatLabel,
  genreLabel,
  languageName,
  money,
  priceText,
  stamp,
  ticketLabel,
  whenText,
  whenWithZone,
  zoneAbbr,
} from '../lib/format';
import { useEditor, useEventState, useToast } from '../lib/hooks';
import type { EventDetail } from '../lib/types';

const TBA = () => <span className="tba">To be announced</span>;
const Unverified = ({ title }: { title?: string }) => (
  <Badge tone="warn" title={title ?? 'Not yet confirmed by an official source'}>
    Unverified
  </Badge>
);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function BookingForm({ target, initial, onDone, snapshot }: { target: string; initial?: LocalBooking; onDone: () => void; snapshot?: Snapshot }) {
  const toast = useToast();
  const [v, setV] = useState({
    provider: initial?.provider ?? '',
    amount: initial?.amount?.toString() ?? '',
    currency: initial?.currency ?? 'EUR',
    reference: initial?.reference ?? '',
    quantity: initial?.quantity?.toString() ?? '',
    ticket_type: initial?.ticket_type ?? '',
    link: initial?.links?.[0] ?? '',
    notes: initial?.notes ?? '',
  });
  const upd = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        saveBooking(
          {
            id: initial?.id,
            target,
            provider: v.provider || null,
            amount: v.amount ? Number(v.amount) : null,
            currency: v.currency || null,
            reference: v.reference || null,
            quantity: v.quantity ? Number(v.quantity) : null,
            ticket_type: v.ticket_type || null,
            links: v.link ? [v.link] : [],
            notes: v.notes || null,
          },
          !initial,
          snapshot,
        );
        toast('Booking saved on this device');
        onDone();
      }}
    >
      <div className="form-row">
        <Field label="Ticket provider">
          <input value={v.provider} onChange={upd('provider')} placeholder="e.g. Ticketportal, Ticketmaster" />
        </Field>
        <Field label="Booking reference">
          <input value={v.reference} onChange={upd('reference')} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Amount paid">
          <input inputMode="decimal" value={v.amount} onChange={upd('amount')} pattern="[0-9]+([.][0-9]{1,2})?" />
        </Field>
        <Field label="Currency">
          <select value={v.currency} onChange={upd('currency')}>
            {['EUR', 'CZK', 'HUF', 'GBP', 'CHF', 'PLN', 'USD'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Tickets">
          <input inputMode="numeric" value={v.quantity} onChange={upd('quantity')} />
        </Field>
      </div>
      <Field label="Ticket type">
        <input value={v.ticket_type} onChange={upd('ticket_type')} placeholder="e.g. Weekend pass, Early bird" />
      </Field>
      <Field label="Link (order or e-ticket)">
        <input type="url" value={v.link} onChange={upd('link')} />
      </Field>
      <Field label="Notes">
        <input value={v.notes} onChange={upd('notes')} />
      </Field>
      <p className="muted small">Stored only on this device. Use Settings → This device to back it up.</p>
      <div className="dialog-actions">
        <button className="btn btn-primary">Save booking</button>
      </div>
    </form>
  );
}

export function NotesBox({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [text, setText] = useState(value ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <div className="notes">
      <label htmlFor="notes" className="field-label">
        Private notes
      </label>
      <textarea
        id="notes"
        rows={3}
        value={text}
        onChange={(x) => {
          setText(x.target.value);
          setSaved(false);
        }}
        onBlur={() => {
          if ((value ?? '') !== text) {
            onSave(text);
            setSaved(true);
          }
        }}
        placeholder="Who’s coming, meeting point, what to bring…"
      />
      <p className="muted small" aria-live="polite">
        {saved ? 'Saved on this device' : 'Saved on this device when you leave the box'}
      </p>
    </div>
  );
}

export function EventDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['event', id], queryFn: () => get<EventDetail>(`/api/events/${id}`) });
  const editor = useEditor();
  const local = useEventState(q.data ?? { id });
  const st = local.state;
  const [bookingOpen, setBookingOpen] = useState(false);
  const [editBooking, setEditBooking] = useState<LocalBooking | null>(null);
  if (q.isLoading) return <Spinner />;
  const e = q.data;
  if (!e) return <ErrorNote error={q.error} />;
  const refresh = () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'meta' });
  const snap = snapshotOf(e);
  const when = whenWithZone(e, e.timezone);
  const unverified = new Set(e.unverified_fields);
  const tba = new Set(e.tba_fields);
  const selectedOcc = e.occurrences.find((o) => o.id === st.occurrence_id);
  const upcomingOccs = e.occurrences.filter((o) => !o.past);
  const saleTz = e.sale_timezone ?? e.timezone;
  const days = [...new Set(e.artists.map((a) => a.date).filter(Boolean))] as string[];
  const followed = e.artists.filter((a) => a.followed);

  return (
    <article className="page detail">
      <p className="crumbs">
        <button type="button" className="btn btn-link" onClick={() => nav(-1)}>
          ← Back
        </button>
      </p>
      <header className="detail-head">
        <div className="tags">
          {[...e.categories, ...e.genres.filter((g) => !e.categories.includes(g))].map((c) => (
            <span key={c} className="tag">
              {e.genres.includes(c) && !e.categories.includes(c) ? genreLabel(c) : catLabel(c)}
            </span>
          ))}
          <StatusBadges e={e} />
        </div>
        <h1>
          {e.title}
          {e.festival?.edition && !e.title.includes(e.festival.edition) && <span className="edition"> {e.festival.edition}</span>}
        </h1>
        {e.status !== 'scheduled' && (
          <p className={`status-line status-${e.status}`} role="status">
            <strong>{e.status === 'cancelled' ? 'Cancelled' : e.status === 'postponed' ? 'Postponed' : 'Rescheduled'}</strong>
            {e.status_note ? ` — ${e.status_note}` : ''}
            {e.previous_schedule.length > 0 && ` (previously ${whenText({ ...e.previous_schedule.at(-1)!, start_time_known: e.previous_schedule.at(-1)!.start_local.length > 10, end_time_known: false }, e.timezone)})`}
          </p>
        )}
        <p className="detail-when">
          <CalendarCheck size={18} aria-hidden />
          <span>
            {e.recurring && e.occurrences.length > 1 ? `${upcomingOccs.length} upcoming dates · next ${whenText(upcomingOccs[0] ?? e, e.timezone)}` : when.text}
            {when.zone && <span className="muted"> ({when.zone})</span>}
            {when.home && <span className="muted"> · {when.home} in Bratislava</span>}
          </span>
        </p>
        <p className="detail-place">
          <MapPin size={18} aria-hidden />
          <span>
            {e.venue_detail?.name ?? e.location_text ?? <TBA />}
            {e.venue_detail?.address && <span className="muted">, {e.venue_detail.address}</span>}
            <span className="muted">
              {' '}
              · {[e.town, e.city && e.city !== e.town ? e.city : null, countryName(e.country)].filter(Boolean).join(', ')}
            </span>
            {e.map_url && (
              <>
                {' '}
                <a href={e.map_url} target="_blank" rel="noreferrer">
                  Map <ExternalLink size={13} aria-hidden />
                </a>
              </>
            )}
          </span>
        </p>
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          {(e.why_suits_me || e.reasons.length > 0) && (
            <section className="card suits" aria-labelledby="suits-h">
              <h2 id="suits-h">Why this might suit you</h2>
              {e.why_suits_me && <p>{e.why_suits_me}</p>}
              {e.reasons.length > 0 && (
                <ul className="reason-list">
                  {e.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {(e.expectation || e.description) && (
            <section className="prose">
              {e.expectation && (
                <>
                  <h2>What to expect</h2>
                  <p>{e.expectation}</p>
                </>
              )}
              {e.description && (
                <>
                  <h2>About</h2>
                  <p className="pre">{e.description}</p>
                </>
              )}
            </section>
          )}

          <section aria-labelledby="info-h">
            <h2 id="info-h" className="section-title">
              Event information
            </h2>
            <dl className="kv">
              <Row label="Date">
                {whenText(e, e.timezone, { year: true })}
                {(tba.has('start_time') || !e.start_time_known) && !e.recurring && (
                  <>
                    {' '}
                    · start time <TBA />
                  </>
                )}
              </Row>
              <Row label="Time zone">
                {e.timezone} ({zoneAbbr(e.start_local, e.timezone)})
              </Row>
              <Row label="Doors">{e.doors_local ? `${dt(e.doors_local, e.timezone).toFormat('HH:mm')}` : tba.has('doors') ? <TBA /> : <span className="muted">Not listed</span>}</Row>
              <Row label="Start – finish">
                {e.start_time_known ? dt(e.start_local, e.timezone).toFormat('HH:mm') : <TBA />} –{' '}
                {e.end_time_known && e.end_local ? `${dt(e.end_local, e.timezone).toFormat('HH:mm')}${e.end_local.slice(0, 10) !== e.start_local.slice(0, 10) && !(e.end_local.length === 10) ? ` (${dayLabel(e.end_local)})` : ''}` : unverified.has('end') ? <Unverified /> : <TBA />}
              </Row>
              {e.performance_format && <Row label="Format">{formatLabel(e.performance_format)}</Row>}
              <Row label="Age">{e.age_restriction ?? <span className="muted">Not listed</span>}</Row>
              {e.languages && e.languages.length > 0 && (
                <Row label="Language">
                  {e.languages.map(languageName).join(', ')}
                  {e.language_importance && <span className="muted"> · {LANGUAGE_IMPORTANCE_LABELS[e.language_importance as LanguageImportance]}</span>}
                </Row>
              )}
              {e.participation && <Row label="Taking part">{PARTICIPATION_LABELS[e.participation as keyof typeof PARTICIPATION_LABELS]}</Row>}
              {e.residency && (
                <Row label="Residency">
                  {e.residency.title} ({e.residency.season}) · <Badge tone={e.residency.status === 'confirmed' ? 'ok' : 'info'}>Residency {e.residency.status}</Badge>
                </Row>
              )}
              {e.camping && <Row label="Camping">{e.camping.available === null ? <TBA /> : e.camping.available ? `Yes${e.camping.note ? ` — ${e.camping.note}` : ''}` : 'No camping'}</Row>}
              {e.accommodation && (
                <Row label="Accommodation">
                  {e.accommodation.note}
                  {e.accommodation.url && (
                    <>
                      {' '}
                      <a href={e.accommodation.url} target="_blank" rel="noreferrer">
                        Official information
                      </a>
                    </>
                  )}
                </Row>
              )}
              {e.travel && (
                <Row label="Travel">
                  About {Math.round(e.travel.duration_minutes / 6) / 10} h by {e.travel.mode} from {e.travel.from} <span className="muted">({e.travel.label ?? 'estimate'}; source: {e.travel.source})</span>
                </Row>
              )}
            </dl>
          </section>

          {e.recurring && e.occurrences.length > 1 && (
            <section aria-labelledby="dates-h">
              <h2 id="dates-h" className="section-title">
                Dates
              </h2>
              <p className="muted small">Choose the date you plan to go — only that date goes in your calendar.</p>
              <div className="chip-row wrap">
                {upcomingOccs.slice(0, 40).map((o) => (
                  <button key={o.id} type="button" className={`chip ${st.occurrence_id === o.id ? 'on' : ''}`} aria-pressed={st.occurrence_id === o.id} onClick={() => local.set({ occurrence_id: st.occurrence_id === o.id ? null : o.id })}>
                    {dayLabel(o.start_local)}
                  </button>
                ))}
              </div>
            </section>
          )}

          {e.artists.length > 0 && (
            <section aria-labelledby="lineup-h">
              <h2 id="lineup-h" className="section-title">
                Lineup {unverified.has('lineup') && <Unverified />}
                {unverified.has('set_times') && <Badge tone="warn">Set times unverified</Badge>}
              </h2>
              {followed.length > 0 && <p className="small">Followed: {followed.map((a) => `${a.name}${a.date ? ` (${dayLabel(a.date)})` : ''}`).join(', ')}</p>}
              {(days.length ? days.sort() : [null]).map((day) => (
                <div key={day ?? 'all'} className="lineup-day">
                  {day && <h3 className="day-head">{dayLabel(day)}</h3>}
                  <ul className="lineup">
                    {e.artists
                      .filter((a) => (day ? a.date === day : true))
                      .map((a) => (
                        <li key={a.id} className={a.followed ? 'followed' : ''}>
                          <div className="lineup-main">
                            <Link to={`/artists/${a.artist_id}`} className="lineup-name">
                              {a.followed && <Star size={14} aria-label="Followed" className="star" />} {a.name}
                            </Link>
                            <span className="muted small">
                              {formatLabel(a.format)}
                              {a.billing !== 'unknown' ? ` · ${a.billing.replace('_', ' ')}` : ''}
                              {a.stage ? ` · ${a.stage}` : ''}
                              {a.set_start ? ` · ${dt(a.set_start, e.timezone).toFormat('HH:mm')}${a.set_end ? `–${dt(a.set_end, e.timezone).toFormat('HH:mm')}` : ''}` : ''}
                            </span>
                            {!a.confirmed && <Unverified />}
                          </div>
                          {a.description && (
                            <p className="lineup-desc small">
                              {a.description} {!a.description_verified && <span className="muted">(unverified)</span>}
                            </p>
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <section aria-labelledby="sources-h">
            <h2 id="sources-h" className="section-title">
              Sources and checks
            </h2>
            <dl className="kv">
              <Row label="Last verified">{e.last_verified_at ? stamp(e.last_verified_at) : <span className="muted">Not yet verified</span>}</Row>
              {e.announced_at && <Row label="Announced">{stamp(e.announced_at)}</Row>}
              <Row label="First listed here">{stamp(e.first_seen_at)}</Row>
              {e.needs_review && <Row label="Needs review">{e.review_reason}</Row>}
            </dl>
            {e.conflicts.length > 0 && (
              <div className="conflicts" role="note">
                <h3>
                  <Info size={16} aria-hidden /> Conflicting information
                </h3>
                <ul>
                  {e.conflicts.map((c, i) => (
                    <li key={i}>
                      <strong>{c.field}</strong>: {c.values.map((v) => `${v.value}${v.source_url ? ` (${new URL(v.source_url).hostname})` : ''}`).join(' vs ')}
                      {c.note && <span className="muted"> — {c.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {e.sources.length > 0 ? (
              <ul className="source-list">
                {e.sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.name ?? new URL(s.url).hostname} <ExternalLink size={13} aria-hidden />
                    </a>
                    <span className="muted small">
                      {' '}
                      · {SOURCE_TYPE_LABELS[s.source_type as keyof typeof SOURCE_TYPE_LABELS] ?? s.source_type}
                      {s.claims.length ? ` · supports ${s.claims.join(', ')}` : ''}
                      {s.status === 'missing' ? ' · no longer found' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No sources recorded.</p>
            )}
            {e.changes.filter((c) => c.change_type !== 'created').length > 0 && (
              <details className="history">
                <summary>Change history</summary>
                <ul>
                  {e.changes
                    .filter((c) => c.change_type !== 'created')
                    .map((c) => (
                      <li key={c.id}>
                        <span className="muted">{stamp(c.created_at)}</span> {c.change_type.replace(/_/g, ' ')}
                        {c.field && c.change_type !== 'verification' ? `: ${c.field.replace(/_/g, ' ')}` : c.change_type === 'verification' ? ` (${c.field?.replace(/_/g, ' ')})` : ''}
                        {c.old_value != null && typeof c.old_value !== 'object' && ` — was ${String(c.old_value)}`}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </section>
        </div>

        <aside className="detail-side" aria-label="Tickets and your plans">
          <section className="card">
            <h2 className="side-title">Tickets</h2>
            <dl className="kv compact">
              <Row label="Availability">
                {ticketLabel(e.ticket_status)}
                {e.ticket_status_checked_at && ['available', 'sold_out', 'limited'].includes(e.ticket_status) && <span className="muted small"> · checked {stamp(e.ticket_status_checked_at)}</span>}
              </Row>
              <Row label="Price">
                {priceText(e) ?? (tba.has('price') ? <TBA /> : <span className="muted">Not listed</span>)}
                {e.currency && e.currency !== 'EUR' && <span className="muted small"> (original currency {e.currency})</span>}
                {unverified.has('price') && <Unverified />}
              </Row>
              {e.booking_fee_note && <Row label="Fees">{e.booking_fee_note}</Row>}
              {e.price_note && <Row label="Note">{e.price_note}</Row>}
              {e.presale_at && (
                <Row label="Presale">
                  {dt(e.presale_at, saleTz).toFormat('ccc d LLL yyyy, HH:mm')} <span className="muted">({saleTz})</span>
                </Row>
              )}
              {e.onsale_at && (
                <Row label="General sale">
                  {dt(e.onsale_at, saleTz).toFormat('ccc d LLL yyyy, HH:mm')} <span className="muted">({saleTz})</span>
                </Row>
              )}
              {e.sale_note && <Row label="Sale info">{e.sale_note}</Row>}
            </dl>
            {e.ticket_tiers.length > 0 && (
              <ul className="tiers">
                {e.ticket_tiers.map((t, i) => (
                  <li key={i}>
                    <span>
                      {t.name}
                      {t.day ? ` (${dayLabel(t.day)})` : ''}
                    </span>
                    <span>{t.price != null ? money(t.price, t.currency ?? e.currency) : '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            {e.ticket_url ? (
              <a className="btn btn-primary block" href={e.ticket_url} target="_blank" rel="noreferrer">
                <Ticket size={16} aria-hidden /> Official tickets
              </a>
            ) : (
              <p className="muted small">No official booking link yet.</p>
            )}
            <p className="muted small">A listing page alone does not confirm live ticket availability.</p>
          </section>

          <section className="card plan-card">
            <h2 className="side-title">Save and plan <span className="muted small">· this device</span></h2>
            <div className="btn-row">
              <button type="button" className={`btn btn-ghost ${st.favourite ? 'on' : ''}`} aria-pressed={st.favourite} onClick={() => local.set({ favourite: !st.favourite })}>
                <Heart size={16} aria-hidden fill={st.favourite ? 'currentColor' : 'none'} /> {st.favourite ? 'Favourite' : 'Add to favourites'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  const occ = e.occurrences.filter((o) => (st.occurrence_id ? o.id === st.occurrence_id : !o.past)).slice(0, st.occurrence_id ? 1 : 1);
                  const ics = buildIcs(
                    'Quartet',
                    occ.map((o) => ({ uid: `${o.id}@quartet`, title: e.title, start_local: o.start_local, start_utc: o.start_utc, end_utc: o.end_utc, start_time_known: o.start_time_known, end_time_known: o.end_time_known, timezone: e.timezone, location: [e.venue?.name, e.town ?? e.city, e.country].filter(Boolean).join(', '), description: e.description, url: e.ticket_url ?? window.location.href, cancelled: e.status === 'cancelled' })),
                  );
                  downloadText(ics, `${e.title.replace(/[^\w]+/g, '-')}.ics`);
                }}
              >
                <Download size={16} aria-hidden /> Add to calendar (.ics)
              </button>
            </div>
            <details className="plan-more" open={st.plan_status !== 'none' || local.bookings.length > 0 || !!st.notes}>
              <summary>Plans, notes and bookings</summary>
              <div className="plan-buttons" role="radiogroup" aria-label="Planning status">
                {(['interested', 'going', 'booked'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={st.plan_status === s}
                    className={`plan-btn plan-${s} ${st.plan_status === s ? 'on' : ''}`}
                    title={PLAN_STATUS_HELP[s]}
                    onClick={() => local.set({ plan_status: st.plan_status === s ? 'none' : s })}
                  >
                    {PLAN_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              <p className="muted small">{PLAN_STATUS_HELP[st.plan_status]}</p>
              {e.recurring && e.occurrences.length > 1 && st.plan_status !== 'none' && !selectedOcc && <p className="small warn-text">Choose a date under “Dates” so this appears in your calendar.</p>}
              <NotesBox value={st.notes} onSave={(v) => local.set({ notes: v })} />
              <h3 className="small strong">Your bookings</h3>
              {local.bookings.length ? (
                <ul className="booking-list">
                  {local.bookings.map((b) => (
                    <li key={b.id}>
                      <div>
                        <strong>{b.provider ?? 'Booking'}</strong> {money(b.amount, b.currency)}
                        {b.quantity ? ` · ${b.quantity} ticket${b.quantity > 1 ? 's' : ''}` : ''}
                        {b.ticket_type ? ` · ${b.ticket_type}` : ''}
                        {b.reference && <div className="small">Ref: {b.reference}</div>}
                        {b.links.map((l) => (
                          <div key={l} className="small">
                            <a href={l} target="_blank" rel="noreferrer">
                              Booking link
                            </a>
                          </div>
                        ))}
                      </div>
                      <div className="btn-row">
                        <button type="button" className="icon-btn" aria-label="Edit booking" onClick={() => setEditBooking(b)}>
                          <Pencil size={15} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Delete booking"
                          onClick={() => {
                            if (confirm('Delete this booking record from this device?')) deleteBooking(b.id);
                          }}
                        >
                          <Trash2 size={15} aria-hidden />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBookingOpen(true)}>
                <Ticket size={15} aria-hidden /> {local.bookings.length ? 'Add another booking' : 'I’ve booked tickets'}
              </button>
            </details>
          </section>

          <section className="card quiet">
            <div className="btn-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => local.set({ hidden: !st.hidden })}>
                {st.hidden ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />} {st.hidden ? 'Show this event again' : 'Hide this event'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  addFeedback(e.id, e.categories, e.genres);
                  toast('Got it — fewer events like this in Highlights on this device');
                }}
              >
                <ThumbsDown size={16} aria-hidden /> Fewer like this
              </button>
              {e.origin === 'manual' && editor.unlocked && (
                <>
                  <Link to={`/events/${e.id}/edit`} className="btn btn-ghost btn-sm">
                    <Pencil size={16} aria-hidden /> Edit listing
                  </Link>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    onClick={async () => {
                      if (!confirm('Delete this shared listing for every device?')) return;
                      await api('DELETE', `/api/events/${e.id}`);
                      refresh();
                      nav('/');
                    }}
                  >
                    <Trash2 size={16} aria-hidden /> Delete listing
                  </button>
                </>
              )}
            </div>
            <p className="muted small">Listing updated {DateTime.fromISO(e.updated_at).setLocale('en-GB').toRelative()}</p>
          </section>
        </aside>
      </div>

      <Dialog open={bookingOpen} onClose={() => setBookingOpen(false)} title="Record a booking">
        <BookingForm
          target={e.id}
          snapshot={snap}
          onDone={() => setBookingOpen(false)}
        />
      </Dialog>
      <Dialog open={!!editBooking} onClose={() => setEditBooking(null)} title="Edit booking">
        {editBooking && (
          <BookingForm target={e.id} initial={editBooking} onDone={() => setEditBooking(null)} />
        )}
      </Dialog>
    </article>
  );
}
