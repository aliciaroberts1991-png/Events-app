import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FEED_TYPE_LABELS, type FeedType } from '../../shared/taxonomy';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api, get } from '../lib/api';
import { relative } from '../lib/format';

export function UpdatesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['feed'], queryFn: () => get('/api/feed') });
  const items = q.data?.items ?? [];
  return (
    <div className="page narrow">
      <PageHeader
        title="Updates"
        sub="New events, your artists’ appearances, ticket sales and changes to things you’ve saved."
        actions={
          <div className="btn-row">
            {(q.data?.unread ?? 0) > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={async () => {
                  await api('POST', '/api/feed/read', { ids: 'all' });
                  qc.invalidateQueries({ queryKey: ['feed'] });
                }}
              >
                Mark all as read
              </button>
            )}
            <Link to="/settings/notifications" className="btn btn-ghost">
              Notification settings
            </Link>
          </div>
        }
      />
      <ErrorNote error={q.error} />
      {q.isLoading && <Spinner />}
      {!q.isLoading && !items.length && (
        <Empty title="No updates yet" icon={<Bell size={28} />}>
          Updates appear here after research runs find something relevant.
        </Empty>
      )}
      <ul className="feed">
        {items.map((i: any) => (
          <li key={i.id} className={`feed-item feed-${i.type} ${i.read_at ? '' : 'unread'}`}>
            <span className="feed-type">{FEED_TYPE_LABELS[i.type as FeedType] ?? i.type}</span>
            {i.event_id ? (
              <Link
                to={`/events/${i.event_id}`}
                className="feed-title"
                onClick={() => {
                  if (!i.read_at) api('POST', '/api/feed/read', { ids: [i.id] }).then(() => qc.invalidateQueries({ queryKey: ['feed'] }));
                }}
              >
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
