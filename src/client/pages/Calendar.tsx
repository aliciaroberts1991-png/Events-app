// "My plans": favourites, calendar, history, personal plans and hidden events.
// Everything here is stored on this device (see lib/local.ts).
import { DateTime } from 'luxon';
import { AlertTriangle, CalendarPlus, ChevronLeft, ChevronRight, Download, Heart, Plus, Ticket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEntry } from '../../shared/calendar';
import type { LocalPlan } from '../../shared/local-data';
import { EventCard, HideButton, PlanChip } from '../components/EventCard';
import { Badge, Dialog, Empty, ErrorNote, Field, PageHeader, Segmented, Spinner, Toggle } from '../components/ui';
import { dayLabel, money, PLANNING_TZ, whenText, zoneAbbr } from '../lib/format';
import { useToast, useUrlState } from '../lib/hooks';
import { deletePlan, savePlan, toggleClashReview, useLocal } from '../lib/local';
import { downloadText, entriesToIcs, useCalendar, useSavedEvents } from '../lib/plans';

function localDays(e: CalendarEntry) {
  const s = DateTime.fromISO(e.start_utc).setZone(PLANNING_TZ).startOf('day');
  const end = DateTime.fromISO(e.end_utc).setZone(PLANNING_TZ);
  const out: string[] = [];
  const lastDay = e.multi_day ? end : s;
  for (let d = s; d <= lastDay && out.length < 40; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

function EntryRow({ e, clashing }: { e: CalendarEntry; clashing: boolean }) {
  const inner = (
    <>
      <span className="agenda-time">{e.start_time_known ? `${e.start_local.slice(11, 16)}${e.timezone !== PLANNING_TZ ? ` ${zoneAbbr(e.start_local, e.timezone)}` : ''}` : e.multi_day ? 'All days' : 'Time TBA'}</span>
      <span className="agenda-body">
        <span className="agenda-title">
          {e.title}
          {e.event_status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
          {e.is_demo && <Badge tone="demo">Demo</Badge>}
          {e.kind === 'entry' && <Badge tone="neutral">Your entry</Badge>}
          {clashing && (
            <span className="clash-flag">
              <AlertTriangle size={13} aria-hidden /> Clash
            </span>
          )}
        </span>
        <span className="muted small">
          {whenText(e, e.timezone)}
          {e.location ? ` · ${e.location}` : ''}
          {e.needs_date ? ' · choose a date on the event page' : ''}
        </span>
      </span>
      {e.kind === 'plan' ? <span className="plan-chip plan-plan">Personal plan</span> : <PlanChip status={e.status} />}
    </>
  );
  const to = e.event_id ? `/events/${e.event_id}` : e.kind === 'entry' ? `/entries/${e.key.slice(6)}` : null;
  return to ? (
    <Link to={to} className="agenda-row">
      {inner}
    </Link>
  ) : (
    <div className="agenda-row">{inner}</div>
  );
}

export function PlanForm({ onDone, initial }: { onDone: () => void; initial?: LocalPlan }) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.start?.slice(0, 10) ?? DateTime.now().toISODate()!);
  const [time, setTime] = useState(initial?.start?.slice(11, 16) ?? '');
  const [endDate, setEndDate] = useState(initial?.end && initial.end.length >= 10 ? initial.end.slice(0, 10) : '');
  const [endTime, setEndTime] = useState(initial?.end ? (initial.end.length === 5 ? initial.end : initial.end.slice(11, 16)) : '');
  const [tz, setTz] = useState(initial?.timezone ?? PLANNING_TZ);
  const [location, setLocation] = useState(initial?.location ?? '');
  return (
    <form
      className="form"
      onSubmit={(ev) => {
        ev.preventDefault();
        const start = time ? `${date}T${time}` : date;
        const end = endTime ? `${endDate || date}T${endTime}` : endDate || null;
        savePlan({ id: initial?.id, title, start, end, timezone: tz, location: location || null, notes: initial?.notes ?? null });
        toast('Plan saved on this device');
        onDone();
      }}
    >
      <Field label="What">
        <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Dinner with Jana, flight to London" />
      </Field>
      <div className="form-row">
        <Field label="Date">
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Start time" hint="Leave empty if not fixed">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="End date" hint="For multi-day plans">
          <input type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <Field label="End time" hint="Earlier than the start means the next day">
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Time zone">
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {['Europe/Bratislava', 'Europe/Vienna', 'Europe/Budapest', 'Europe/Prague', 'Europe/London', 'Europe/Madrid', 'Europe/Lisbon', 'Europe/Berlin', 'Europe/Athens'].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
        <Field label="Where (optional)">
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-primary">Save plan</button>
      </div>
    </form>
  );
}

function SavedList() {
  const s = useSavedEvents();
  const favs = s.ids.filter((id) => s.d.states[id]?.favourite && !s.d.states[id]?.hidden);
  const planned = s.ids.filter((id) => s.d.states[id]?.plan_status !== 'none' && !s.d.states[id]?.favourite && !s.d.states[id]?.hidden);
  if (s.isLoading) return <Spinner />;
  const nowIso = new Date().toISOString();
  const cards = (ids: string[]) =>
    ids
      .map((id) => s.byId.get(id))
      .filter((e) => e && e.end_utc >= nowIso)
      .map((e) => <EventCard key={e!.id} e={e!} />);
  const fav = cards(favs);
  const plan = cards(planned);
  return (
    <>
      <ErrorNote error={s.error} />
      <h2 className="section-title">
        <Heart size={18} aria-hidden /> Favourites
      </h2>
      {fav.length ? <div className="card-grid">{fav}</div> : <Empty title="No upcoming favourites yet">Tap the heart on any event.</Empty>}
      {plan.length > 0 && (
        <>
          <h2 className="section-title">Interested, going or booked</h2>
          <div className="card-grid">{plan}</div>
        </>
      )}
      {s.d.entries.length > 0 && (
        <>
          <h2 className="section-title">Your own entries</h2>
          <div className="agenda">
            {s.d.entries.map((en) => (
              <Link key={en.id} to={`/entries/${en.id}`} className="agenda-row">
                <span className="agenda-time">{dayLabel(en.start)}</span>
                <span className="agenda-body">
                  <span className="agenda-title">{en.title}</span>
                  <span className="muted small">{[en.venue, en.city].filter(Boolean).join(', ')}</span>
                </span>
                <PlanChip status={s.d.states[en.id]?.plan_status ?? 'none'} />
              </Link>
            ))}
          </div>
        </>
      )}
      {s.missing.length > 0 && (
        <p className="muted small">
          {s.missing.length} saved listing{s.missing.length === 1 ? ' is' : 's are'} no longer available: {s.missing.map((id) => s.d.states[id]?.snapshot?.title ?? id).join(', ')}.
        </p>
      )}
    </>
  );
}

export function CalendarPage() {
  const [s, set] = useUrlState({ view: 'agenda', interested: '', month: DateTime.now().setZone(PLANNING_TZ).toFormat('yyyy-MM'), tab: 'saved' });
  const d = useLocal();
  const [planOpen, setPlanOpen] = useState(false);
  const [editPlan, setEditPlan] = useState<LocalPlan | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const cal = useCalendar(s.interested === '1');
  const month = DateTime.fromISO(`${s.month}-01`, { zone: PLANNING_TZ });
  const today = DateTime.now().setZone(PLANNING_TZ).toISODate()!;
  const entries = cal.entries;
  const open = cal.clashes.filter((c) => !c.reviewed);
  const clashKeys = new Set(open.flatMap((c) => [c.a, c.b]));
  const byKey = new Map(entries.map((e) => [e.key, e]));

  const days = new Map<string, CalendarEntry[]>();
  for (const e of entries) for (const dd of localDays(e)) days.set(dd, [...(days.get(dd) ?? []), e]);
  const agendaDays = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const all = localDays(e);
    const first = all.find((x) => x >= today) ?? all[0];
    agendaDays.set(first, [...(agendaDays.get(first) ?? []), e]);
  }
  const selectedList = selectedDay ? days.get(selectedDay) ?? [] : [];
  const hiddenIds = cal.ids.filter((id) => d.states[id]?.hidden);

  return (
    <div className="page">
      <PageHeader
        title="My plans"
        sub="Favourites, plans and bookings kept on this device. Back them up or copy them to another device in Settings → This device."
        actions={
          <div className="btn-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPlanOpen(true)}>
              <CalendarPlus size={16} aria-hidden /> Add plan
            </button>
            <Link to="/add/booking" className="btn btn-ghost btn-sm">
              <Ticket size={16} aria-hidden /> Add booking
            </Link>
          </div>
        }
      >
        <Segmented
          label="Section"
          value={s.tab}
          onChange={(v) => set({ tab: v })}
          options={[
            { value: 'saved', label: 'Saved' },
            { value: 'calendar', label: 'Calendar' },
            { value: 'history', label: 'History' },
            { value: 'plans', label: 'Personal plans', count: d.plans.length },
            { value: 'hidden', label: 'Hidden', count: hiddenIds.length },
          ]}
        />
      </PageHeader>

      {s.tab === 'saved' && <SavedList />}

      {s.tab === 'calendar' && (
        <>
          <div className="filter-row">
            <Segmented
              label="Layout"
              value={s.view}
              onChange={(v) => set({ view: v })}
              options={[
                { value: 'agenda', label: 'Agenda' },
                { value: 'month', label: 'Month' },
              ]}
            />
            <Toggle checked={s.interested === '1'} onChange={(v) => set({ interested: v ? '1' : '' })} label="Include Interested" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadText(entriesToIcs('Quartet', entries), 'my-calendar.ics')}>
              <Download size={16} aria-hidden /> Download .ics
            </button>
          </div>

          {open.length > 0 && (
            <section className="card clash-panel" aria-labelledby="clash-h">
              <h2 id="clash-h">
                <AlertTriangle size={18} aria-hidden /> {open.length} clash{open.length === 1 ? '' : 'es'} to review
              </h2>
              <ul>
                {open.map((c) => {
                  const a = byKey.get(c.a);
                  const b = byKey.get(c.b);
                  if (!a || !b) return null;
                  return (
                    <li key={`${c.a}|${c.b}`}>
                      <p>
                        <Badge tone={c.type === 'overlap' ? 'danger' : 'warn'}>{c.type === 'overlap' ? 'Times overlap' : 'Possible clash'}</Badge> <strong>{a.title}</strong> and <strong>{b.title}</strong> on {c.dates.map(dayLabel).join(', ')}
                      </p>
                      {c.type === 'possible' && <p className="muted small">{c.reason}</p>}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleClashReview(`${c.a}|${c.b}`, true)}>
                        Keep both
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {cal.isLoading && <Spinner />}

          {s.view === 'agenda' &&
            (entries.length ? (
              <div className="agenda">
                {[...agendaDays.entries()]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([dd, list]) => (
                    <section key={dd} className="agenda-day">
                      <h2 className="day-head">{dayLabel(dd)}</h2>
                      {list.map((e) => (
                        <EntryRow key={e.key + dd} e={e} clashing={clashKeys.has(e.key)} />
                      ))}
                    </section>
                  ))}
              </div>
            ) : (
              <Empty title="Nothing planned yet">
                Mark events as <strong>Going</strong> or <strong>Tickets booked</strong>, or add a personal plan.
              </Empty>
            ))}

          {s.view === 'month' && (
            <section className="month" aria-label={month.setLocale('en-GB').toFormat('LLLL yyyy')}>
              <div className="month-nav">
                <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => set({ month: month.minus({ months: 1 }).toFormat('yyyy-MM') })}>
                  <ChevronLeft size={20} aria-hidden />
                </button>
                <h2>{month.setLocale('en-GB').toFormat('LLLL yyyy')}</h2>
                <button type="button" className="icon-btn" aria-label="Next month" onClick={() => set({ month: month.plus({ months: 1 }).toFormat('yyyy-MM') })}>
                  <ChevronRight size={20} aria-hidden />
                </button>
              </div>
              <div className="month-grid" role="grid">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => (
                  <div key={w} className="month-dow" role="columnheader">
                    {w}
                  </div>
                ))}
                {Array.from({ length: 42 }).map((_, i) => {
                  const dt = month.startOf('month').startOf('week').plus({ days: i });
                  if (i >= 35 && dt.month !== month.month) return null;
                  const iso = dt.toISODate()!;
                  const list = days.get(iso) ?? [];
                  return (
                    <div key={iso} role="gridcell" className={`month-cell ${dt.month !== month.month ? 'other' : ''} ${iso === today ? 'today' : ''} ${selectedDay === iso ? 'selected' : ''}`}>
                      <button type="button" className="month-day" aria-label={`${dayLabel(iso)}: ${list.length} item${list.length === 1 ? '' : 's'}`} aria-pressed={selectedDay === iso} onClick={() => setSelectedDay(selectedDay === iso ? null : iso)}>
                        {dt.day}
                      </button>
                      {list.slice(0, 3).map((e) =>
                        e.event_id ? (
                          <Link key={e.key} to={`/events/${e.event_id}`} className={`month-item st-${e.status} ${clashKeys.has(e.key) ? 'clash' : ''}`}>
                            {e.title}
                          </Link>
                        ) : (
                          <span key={e.key} className={`month-item st-${e.kind === 'plan' ? 'plan' : e.status} ${clashKeys.has(e.key) ? 'clash' : ''}`}>
                            {e.title}
                          </span>
                        ),
                      )}
                      {list.length > 3 && <span className="month-more">+{list.length - 3}</span>}
                    </div>
                  );
                })}
              </div>
              {selectedDay && (
                <div className="agenda month-selected" aria-live="polite">
                  <h3 className="day-head">{dayLabel(selectedDay)}</h3>
                  {selectedList.length ? selectedList.map((e) => <EntryRow key={e.key} e={e} clashing={clashKeys.has(e.key)} />) : <p className="muted">Nothing planned.</p>}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {s.tab === 'history' &&
        (cal.past.length ? (
          <div className="agenda">
            {cal.past.map((e) => {
              const target = e.event_id ?? e.key.slice(6);
              const bookings = d.bookings.filter((b) => b.target === target);
              return (
                <div key={e.key} className="agenda-row">
                  <span className="agenda-time">{dayLabel(e.start_local)}</span>
                  <span className="agenda-body">
                    <span className="agenda-title">
                      {e.event_id ? <Link to={`/events/${e.event_id}`}>{e.title}</Link> : e.title} {e.start_local.slice(0, 4)}
                    </span>
                    <span className="muted small">
                      {e.location}
                      {bookings.length > 0 && ` · ${bookings.map((b) => [b.provider, money(b.amount, b.currency), b.reference].filter(Boolean).join(' ')).join('; ')}`}
                    </span>
                  </span>
                  <PlanChip status={e.status} />
                </div>
              );
            })}
          </div>
        ) : (
          <Empty title="No past bookings yet">Events you went to or booked stay here after they finish.</Empty>
        ))}

      {s.tab === 'plans' && (
        <div className="agenda">
          {d.plans
            .slice()
            .sort((a, b) => a.start.localeCompare(b.start))
            .map((p) => (
              <div key={p.id} className="agenda-row">
                <span className="agenda-time">{dayLabel(p.start)}</span>
                <span className="agenda-body">
                  <span className="agenda-title">{p.title}</span>
                  <span className="muted small">
                    {p.start.length > 10 ? p.start.slice(11, 16) : 'All day'}
                    {p.end ? ` – ${p.end.length === 5 ? p.end : p.end.slice(11, 16) || p.end}` : ''} · {p.timezone}
                    {p.location ? ` · ${p.location}` : ''}
                  </span>
                </span>
                <span className="btn-row">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditPlan(p)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Delete ${p.title}`}
                    onClick={() => {
                      if (confirm(`Delete “${p.title}”?`)) deletePlan(p.id);
                    }}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </span>
              </div>
            ))}
          {!d.plans.length && (
            <Empty title="No personal plans">
              <button type="button" className="btn btn-primary" onClick={() => setPlanOpen(true)}>
                <Plus size={16} aria-hidden /> Add a plan
              </button>
            </Empty>
          )}
        </div>
      )}

      {s.tab === 'hidden' &&
        (hiddenIds.length ? (
          <div className="card-grid">
            {hiddenIds
              .map((id) => cal.byId.get(id))
              .filter(Boolean)
              .map((e) => (
                <div key={e!.id} className="hidden-wrap">
                  <EventCard e={e!} />
                  <HideButton e={e!} />
                </div>
              ))}
          </div>
        ) : (
          <Empty title="No hidden events" />
        ))}

      <Dialog open={planOpen} onClose={() => setPlanOpen(false)} title="Add a personal plan">
        <PlanForm onDone={() => setPlanOpen(false)} />
      </Dialog>
      <Dialog open={!!editPlan} onClose={() => setEditPlan(null)} title="Edit plan">
        {editPlan && <PlanForm initial={editPlan} onDone={() => setEditPlan(null)} />}
      </Dialog>
    </div>
  );
}
