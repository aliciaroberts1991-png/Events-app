import { CalendarCheck, Check, Eye, EyeOff, Heart, Star, Ticket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PLAN_STATUS_LABELS } from '../../shared/taxonomy';
import { catLabel, dayLabel, displayOccurrence, formatLabel, groupOf, nearText, placeText, priceText, saleText, whenText } from '../lib/format';
import { useEventState, useHubNames } from '../lib/hooks';
import type { EventSummary } from '../lib/types';
import { Badge } from './ui';

export function StatusBadges({ e }: { e: EventSummary }) {
  return (
    <>
      {e.is_demo && <Badge tone="demo" title="Fictional example data, not a real listing">Demo</Badge>}
      {e.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
      {e.status === 'postponed' && <Badge tone="warn">Postponed</Badge>}
      {e.status === 'rescheduled' && <Badge tone="warn">Rescheduled</Badge>}
      {e.needs_review && <Badge tone="warn" title="The last check could not confirm this listing">Needs review</Badge>}
      {e.origin === 'manual' && <Badge tone="neutral">Added in the app</Badge>}
      {e.ticket_status === 'sold_out' && <Badge tone="danger">Sold out</Badge>}
      {e.ticket_status === 'sale_not_started' && <Badge tone="info">Sale not started</Badge>}
    </>
  );
}

export function PlanChip({ status }: { status: string }) {
  if (status === 'none') return null;
  const Icon = status === 'booked' ? Ticket : status === 'going' ? CalendarCheck : Eye;
  return (
    <span className={`plan-chip plan-${status}`}>
      <Icon size={14} aria-hidden />
      {PLAN_STATUS_LABELS[status as keyof typeof PLAN_STATUS_LABELS]}
    </span>
  );
}

export function EventCard({ e, showDate = true }: { e: EventSummary; showDate?: boolean }) {
  const occ = displayOccurrence(e);
  const hubNames = useHubNames();
  const { state, set } = useEventState(e);
  const near = nearText(e, hubNames);
  const headliners = e.artists.filter((a) => a.billing === 'headliner' || a.followed).slice(0, 3);
  const shown = headliners.length ? headliners : e.artists.slice(0, 2);
  const price = priceText(e);
  const sale = saleText(e);
  const group = groupOf(e);
  const tags = [...new Set([...e.categories.filter((c) => !['music-festival'].includes(c)), ...e.genres])].slice(0, 3);

  return (
    <article className={`card event-card tone-${group} ${e.status === 'cancelled' ? 'is-cancelled' : ''}`}>
      <div className="card-top">
        {showDate && (
          <p className="card-when">
            {e.recurring && e.occurrence_count > 1 ? `Next: ${whenText(occ, e.timezone)}` : whenText(occ, e.timezone)}
          </p>
        )}
        <div className="card-flags">
          <PlanChip status={state.plan_status} />
          <button
            type="button"
            className={`icon-btn fav ${state.favourite ? 'on' : ''}`}
            aria-pressed={state.favourite}
            aria-label={state.favourite ? `Remove ${e.title} from favourites` : `Add ${e.title} to favourites`}
            onClick={() => set({ favourite: !state.favourite })}
          >
            <Heart size={18} aria-hidden fill={state.favourite ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      <h3 className="card-title">
        <Link to={`/events/${e.id}`} className="stretched">
          {e.title}
        </Link>
      </h3>
      <p className="card-place">
        {placeText(e) || 'Location to be announced'}
        {near && <span className="muted"> · {near}</span>}
      </p>
      {shown.length > 0 && (
        <p className="card-artists">
          {shown.map((a, i) => (
            <span key={a.id} className={a.followed ? 'followed' : ''}>
              {i > 0 && ', '}
              {a.followed && <Star size={12} aria-label="Followed" className="star" />}
              {a.name}
              {a.format !== 'unknown' && <span className="muted"> ({formatLabel(a.format).toLowerCase()})</span>}
            </span>
          ))}
          {e.artists.length > shown.length && <span className="muted"> +{e.artists.length - shown.length} more</span>}
        </p>
      )}
      <div className="card-foot">
        <div className="tags">
          {tags.map((t) => (
            <span key={t} className="tag">
              {catLabel(t)}
            </span>
          ))}
          <StatusBadges e={e} />
        </div>
        {(price || sale) && <p className="card-price">{sale ?? price}</p>}
      </div>
      {e.highlight && e.reasons[0] && (
        <p className="card-reason">
          <Check size={14} aria-hidden /> {e.reasons[0]}
        </p>
      )}
    </article>
  );
}

/** Groups cards under day headings; events already under way come first as "Continuing". */
export function EventList({ items, rangeStart, empty }: { items: EventSummary[]; rangeStart?: string; empty?: React.ReactNode }) {
  if (!items.length) return <>{empty}</>;
  const groups = new Map<string, EventSummary[]>();
  for (const e of items) {
    const o = displayOccurrence(e);
    const day = o.start_local.slice(0, 10);
    const key = rangeStart && day < rangeStart ? 'continuing' : day;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return (
    <div className="event-groups">
      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="day-group" aria-label={day === 'continuing' ? 'Already under way' : dayLabel(day)}>
          <h2 className="day-head">{day === 'continuing' ? 'Already under way' : dayLabel(day)}</h2>
          <div className="card-grid">
            {list.map((e) => (
              <EventCard key={e.id} e={e} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function HideButton({ e }: { e: EventSummary }) {
  const { state, set } = useEventState(e);
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ hidden: !state.hidden })}>
      {state.hidden ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
      {state.hidden ? 'Show again' : 'Hide'}
    </button>
  );
}
