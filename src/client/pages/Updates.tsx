import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FEED_TYPE_LABELS, type FeedType } from '../../shared/taxonomy';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { get, qs } from '../lib/api';
import { relative } from '../lib/format';
import { updateLocal, useLocal } from '../lib/local';

const CHANGE_LABELS: Record<string, string> = {
  date_changed: 'Date changed',
  venue_changed: 'Venue changed',
  status_changed: 'Status changed',
  lineup_added: 'Lineup addition',
  lineup_removed: 'Lineup change',
  ticket_sale: 'Ticket sale dates',
  ticket_status: 'Ticket availability',
};

export function UpdatesPage() {
  const local = useLocal();
  const q = useQuery({ queryKey: ['feed'], queryFn: () => get('/api/feed') });
  const savedIds = Object.entries(local.states)
    .filter(([id, s]) => !id.startsWith('loc_') && (s.favourite || s.plan_status !== 'none'))
    .map(([id]) => id);
  const changes = useQuery({
    queryKey: ['changes', savedIds.join(',')],
    queryFn: () => get(`/api/changes${qs({ ids: savedIds.join(',') })}`),
    enabled: savedIds.length > 0,
  });
  const seen = local.feed_seen_at;
  const items = q.data?.items ?? [];
  // Opening Updates marks everything as read on this device (after a short delay).
  useEffect(() => {
    if (!q.data) return;
    const t = setTimeout(
      () =>
        updateLocal((d) => {
          d.feed_seen_at = new Date().toISOString();
          d.changes_seen_at = d.feed_seen_at;
        }),
      1500,
    );
    return () => clearTimeout(t);
  }, [q.data]);
  const mine = changes.data?.changes ?? [];
  return (
    <div className="page narrow">
      <PageHeader
        title="Updates"
        sub="New events, appearances by your artists, ticket sales and changes to listings."
        actions={
          <Link to="/settings/notifications" className="btn btn-ghost btn-sm">
            Notification settings
          </Link>
        }
      />
      {mine.length > 0 && (
        <section>
          <h2 className="section-title">Changes to events you saved</h2>
          <ul className="feed">
            {mine.slice(0, 30).map((c: any) => (
              <li key={c.id} className={`feed-item ${!local.changes_seen_at || c.created_at > local.changes_seen_at ? 'unread' : ''}`}>
                <span className="feed-type">{CHANGE_LABELS[c.change_type] ?? c.change_type}</span>
                <Link to={`/events/${c.event_id}`} className="feed-title">
                  {c.title}
                </Link>
                <span className="muted small">{relative(c.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <h2 className="section-title">All updates</h2>
      <ErrorNote error={q.error} />
      {q.isLoading && <Spinner />}
      {!q.isLoading && !items.length && (
        <Empty title="No updates yet" icon={<Bell size={28} />}>
          Updates appear here after research runs find something relevant.
        </Empty>
      )}
      <ul className="feed">
        {items.map((i: any) => (
          <li key={i.id} className={`feed-item feed-${i.type} ${!seen || i.created_at > seen ? 'unread' : ''}`}>
            <span className="feed-type">{FEED_TYPE_LABELS[i.type as FeedType] ?? i.type}</span>
            {i.event_id ? (
              <Link to={`/events/${i.event_id}`} className="feed-title">
                {i.title}
              </Link>
            ) : (
              <span className="feed-title">{i.title}</span>
            )}
            {i.body && <span className="feed-body">{i.body}</span>}
            <span className="muted small">
              {relative(i.created_at)}
              {i.email_status === 'sent' ? ' · emailed' : i.email_status === 'failed' ? ' · email failed' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
