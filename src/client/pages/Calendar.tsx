import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { AlertTriangle, CalendarPlus, ChevronLeft, ChevronRight, Download, Plus, Ticket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlanChip } from '../components/EventCard';
import { Badge, Dialog, Empty, ErrorNote, Field, PageHeader, Segmented, Spinner, Toggle } from '../components/ui';
import { api, download, errorMessage, get, qs } from '../lib/api';
import { dayLabel, money, PLANNING_TZ, whenText, zoneAbbr } from '../lib/format';
import { useToast, useUrlState } from '../lib/hooks';

interface Entry {
  key: string;
  kind: 'event' | 'plan';
  event_id: string | null;
  plan_id: string | null;
  title: string;
  status: string;
  event_status: string | null;
  start_local: string;
  end_local: string | null;
  timezone: string;
  start_utc: string;
  end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
  multi_day: boolean;
  location: string | null;
  needs_date: boolean;
  is_demo: boolean;
  booking_count: number;
}

function localDays(e: Entry) {
  const s = DateTime.fromISO(e.start_utc).setZone(PLANNING_TZ).startOf('day');
  const end = DateTime.fromISO(e.end_utc).setZone(PLANNING_TZ);
  const out: string[] = [];
  // Overnight entries only belong to their start day.
  const lastDay = e.multi_day ? end : s;
  for (let d = s; d <= lastDay && out.length < 40; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

function EntryRow({ e, clashing }: { e: Entry; clashing: boolean }) {
  const inner = (
    <>
      <span className="agenda-time">{e.start_time_known ? `${e.start_local.slice(11, 16)}${e.timezone !== PLANNING_TZ ? ` ${zoneAbbr(e.start_local, e.timezone)}` : ''}` : e.multi_day ? 'All days' : 'Time TBA'}</span>
      <span className="agenda-body">
        <span className="agenda-title">
          {e.title}
          {e.event_status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
          {e.is_demo && <Badge tone="demo">Demo</Badge>}
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
      {e.kind === 'event' ? <PlanChip status={e.status} /> : <span className="plan-chip plan-plan">Personal plan</span>}
    </>
  );
  return e.event_id ? (
    <Link to={`/events/${e.event_id}`} className="agenda-row">
      {inner}
    </Link>
  ) : (
    <div className="agenda-row">{inner}</div>
  );
}

export function PlanForm({ onDone, initial }: { onDone: () => void; initial?: any }) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.start_local?.slice(0, 10) ?? DateTime.now().toISODate()!);
  const [time, setTime] = useState(initial?.start_local?.slice(11, 16) ?? '');
  const [endDate, setEndDate] = useState(initial?.end_local?.slice(0, 10) ?? '');
  const [endTime, setEndTime] = useState(initial?.end_local?.slice(11, 16) ?? '');
  const [tz, setTz] = useState(initial?.timezone ?? PLANNING_TZ);
  const [location, setLocation] = useState(initial?.location ?? '');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="form"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const start = time ? `${date}T${time}` : date;
        const end = endTime ? `${endDate || date}T${endTime}` : endDate || null;
        try {
          if (initial) await api('PUT', `/api/plans/${initial.id}`, { title, start, end, timezone: tz, location: location || null });
          else await api('POST', '/api/plans', { title, start, end, timezone: tz, location: location || null });
          toast('Plan saved');
          onDone();
        } catch (e) {
          setErr(errorMessage(e));
        }
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
      {err && <p className="error-note" role="alert">{err}</p>}
      <div className="dialog-actions">
        <button className="btn btn-primary">Save plan</button>
      </div>
    </form>
  );
}

export function CalendarPage() {
  const [s, set] = useUrlState({ view: 'agenda', interested: '', month: DateTime.now().setZone(PLANNING_TZ).toFormat('yyyy-MM'), tab: 'upcoming' });
  const qc = useQueryClient();
  const toast = useToast();
  const [planOpen, setPlanOpen] = useState(false);
  const [editPlan, setEditPlan] = useState<any>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const month = DateTime.fromISO(`${s.month}-01`, { zone: PLANNING_TZ });
  const range =
    s.view === 'month'
      ? { from: month.startOf('month').startOf('week').toISODate()!, to: month.endOf('month').endOf('week').toISODate()! }
      : { from: DateTime.now().setZone(PLANNING_TZ).toISODate()!, to: DateTime.now().setZone(PLANNING_TZ).plus({ months: 18 }).toISODate()! };
  const q = useQuery({
    queryKey: ['calendar', s.view, s.month, s.interested],
    queryFn: () => get(`/api/calendar${qs({ ...range, include_interested: s.interested === '1' ? '1' : undefined })}`),
    enabled: s.tab === 'upcoming',
  });
  const hist = useQuery({ queryKey: ['history'], queryFn: () => get('/api/calendar/history'), enabled: s.tab === 'history' });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get('/api/plans') });
  const entries: Entry[] = q.data?.entries ?? [];
  const clashes = q.data?.clashes ?? [];
  const open = clashes.filter((c: any) => !c.reviewed);
  const clashKeys = new Set(open.flatMap((c: any) => [c.a, c.b]));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const refresh = () => qc.invalidateQueries();

  const days = new Map<string, Entry[]>();
  for (const e of entries) for (const d of localDays(e)) days.set(d, [...(days.get(d) ?? []), e]);
  // The agenda lists a multi-day entry once, on its first day in view.
  const agendaDays = new Map<string, Entry[]>();
  for (const e of entries) {
    const first = localDays(e).find((d) => d >= range.from);
    if (first) agendaDays.set(first, [...(agendaDays.get(first) ?? []), e]);
  }
  const selectedList = selectedDay ? days.get(selectedDay) ?? [] : [];

  return (
    <div className="page">
      <PageHeader
        title="My calendar"
        sub="Going and booked events with your personal plans. Times are shown in each event’s own time zone."
        actions={
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => setPlanOpen(true)}>
              <CalendarPlus size={16} aria-hidden /> Add plan
            </button>
            <Link to="/add/booking" className="btn btn-ghost">
              <Ticket size={16} aria-hidden /> Add booking
            </Link>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => download(`/api/calendar.ics${qs({ include_interested: s.interested === '1' ? '1' : undefined })}`, 'my-calendar.ics').catch((e) => toast(errorMessage(e), 'error'))}
            >
              <Download size={16} aria-hidden /> Download .ics
            </button>
          </div>
        }
      >
        <div className="filter-row">
          <Segmented
            label="Section"
            value={s.tab}
            onChange={(v) => set({ tab: v })}
            options={[
              { value: 'upcoming', label: 'Upcoming' },
              { value: 'history', label: 'History' },
              { value: 'plans', label: 'Personal plans', count: plans.data?.plans.length },
            ]}
          />
          {s.tab === 'upcoming' && (
            <>
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
            </>
          )}
        </div>
      </PageHeader>

      {s.tab === 'upcoming' && open.length > 0 && (
        <section className="card clash-panel" aria-labelledby="clash-h">
          <h2 id="clash-h">
            <AlertTriangle size={18} aria-hidden /> {open.length} clash{open.length === 1 ? '' : 'es'} to review
          </h2>
          <ul>
            {open.map((c: any) => {
              const a = byKey.get(c.a);
              const b = byKey.get(c.b);
              if (!a || !b) return null;
              return (
                <li key={`${c.a}|${c.b}`}>
                  <p>
                    <Badge tone={c.type === 'overlap' ? 'danger' : 'warn'}>{c.type === 'overlap' ? 'Times overlap' : 'Possible clash'}</Badge> <strong>{a.title}</strong> and <strong>{b.title}</strong> on {c.dates.map(dayLabel).join(', ')}
                  </p>
                  {c.type === 'possible' && <p className="muted small">{c.reason}</p>}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      await api('POST', '/api/calendar/clashes/review', { a: c.a, b: c.b, decision: 'keep_both' });
                      refresh();
                    }}
                  >
                    Keep both
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <ErrorNote error={q.error} />
      {s.tab === 'upcoming' && q.isLoading && <Spinner />}

      {s.tab === 'upcoming' && s.view === 'agenda' && q.data && (
        entries.length ? (
          <div className="agenda">
            {[...agendaDays.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([d, list]) => (
                <section key={d} className="agenda-day">
                  <h2 className="day-head">{dayLabel(d)}</h2>
                  {list.map((e) => (
                    <EntryRow key={e.key + d} e={e} clashing={clashKeys.has(e.key)} />
                  ))}
                </section>
              ))}
          </div>
        ) : (
          <Empty title="Nothing planned yet">
            Mark events as <strong>Going</strong> or <strong>Tickets booked</strong>, or add a personal plan.
          </Empty>
        )
      )}

      {s.tab === 'upcoming' && s.view === 'month' && (
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
              const d = month.startOf('month').startOf('week').plus({ days: i });
              if (i >= 35 && d.month !== month.month) return null;
              const iso = d.toISODate()!;
              const list = days.get(iso) ?? [];
              const today = iso === DateTime.now().setZone(PLANNING_TZ).toISODate();
              return (
                <div key={iso} role="gridcell" className={`month-cell ${d.month !== month.month ? 'other' : ''} ${today ? 'today' : ''} ${selectedDay === iso ? 'selected' : ''}`}>
                  <button type="button" className="month-day" aria-label={`${dayLabel(iso)}: ${list.length} item${list.length === 1 ? '' : 's'}`} aria-pressed={selectedDay === iso} onClick={() => setSelectedDay(selectedDay === iso ? null : iso)}>
                    {d.day}
                  </button>
                  {list.slice(0, 3).map((e) =>
                    e.event_id ? (
                      <Link key={e.key} to={`/events/${e.event_id}`} className={`month-item st-${e.status} ${clashKeys.has(e.key) ? 'clash' : ''}`}>
                        {e.title}
                      </Link>
                    ) : (
                      <span key={e.key} className={`month-item st-plan ${clashKeys.has(e.key) ? 'clash' : ''}`}>
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

      {s.tab === 'history' &&
        (hist.isLoading ? (
          <Spinner />
        ) : hist.data?.items.length ? (
          <div className="agenda">
            {hist.data.items.map((e: any) => (
              <Link key={e.id} to={`/events/${e.id}`} className="agenda-row">
                <span className="agenda-time">{dayLabel(e.start_local)}</span>
                <span className="agenda-body">
                  <span className="agenda-title">
                    {e.title} {e.start_local.slice(0, 4)}
                  </span>
                  <span className="muted small">
                    {[e.venue?.name, e.town ?? e.city].filter(Boolean).join(' · ')}
                    {e.bookings.length > 0 && ` · ${e.bookings.map((b: any) => [b.provider, money(b.amount, b.currency), b.reference].filter(Boolean).join(' ')).join('; ')}`}
                  </span>
                </span>
                <PlanChip status={e.state.plan_status} />
              </Link>
            ))}
          </div>
        ) : (
          <Empty title="No past bookings yet">Events you went to or booked stay here after they finish.</Empty>
        ))}

      {s.tab === 'plans' && (
        <div className="agenda">
          {(plans.data?.plans ?? []).map((p: any) => (
            <div key={p.id} className="agenda-row">
              <span className="agenda-time">{dayLabel(p.start_local)}</span>
              <span className="agenda-body">
                <span className="agenda-title">{p.title}</span>
                <span className="muted small">
                  {whenText({ ...p, start_time_known: !!p.start_time_known, end_time_known: !!p.end_time_known }, p.timezone)}
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
                  onClick={async () => {
                    if (!confirm(`Delete “${p.title}”?`)) return;
                    await api('DELETE', `/api/plans/${p.id}`);
                    refresh();
                  }}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </span>
            </div>
          ))}
          {!plans.data?.plans.length && (
            <Empty title="No personal plans">
              <button type="button" className="btn btn-primary" onClick={() => setPlanOpen(true)}>
                <Plus size={16} aria-hidden /> Add a plan
              </button>
            </Empty>
          )}
        </div>
      )}

      <Dialog open={planOpen} onClose={() => setPlanOpen(false)} title="Add a personal plan">
        <PlanForm
          onDone={() => {
            setPlanOpen(false);
            refresh();
          }}
        />
      </Dialog>
      <Dialog open={!!editPlan} onClose={() => setEditPlan(null)} title="Edit plan">
        {editPlan && (
          <PlanForm
            initial={editPlan}
            onDone={() => {
              setEditPlan(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
