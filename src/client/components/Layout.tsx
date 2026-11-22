import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Building2, CalendarDays, Compass, Mic2, Palmtree, Plus, RefreshCw, Search, Settings, Tent } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage, get } from '../lib/api';
import { relative } from '../lib/format';
import { useMeta, useStatus, useToast } from '../lib/hooks';

const NAV = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/cities', label: 'Cities', icon: Building2 },
  { to: '/festivals', label: 'Festivals', icon: Tent },
  { to: '/artists', label: 'Artists', icon: Mic2 },
  { to: '/ibiza', label: 'Ibiza', icon: Palmtree },
  { to: '/calendar', label: 'My calendar', short: 'Calendar', icon: CalendarDays },
];

export function StatusPill({ compact }: { compact?: boolean }) {
  const status = useStatus();
  const s = status.data;
  if (!s) return null;
  const state = s.executor.state as string;
  const last = s.last_successful_update_at;
  const active = s.queue.active[0];
  const tone = state === 'operational' ? 'ok' : state === 'failing' || state === 'stale' ? 'warn' : 'idle';
  const text = active
    ? active.status === 'running'
      ? 'Search running…'
      : 'Search queued'
    : last
      ? `Updated ${relative(last)}`
      : state === 'awaiting_connection'
        ? 'Research not connected'
        : 'No updates yet';
  return (
    <Link to="/settings/research" className={`status-pill status-${tone}`} title="Research and update status">
      <span className="dot" aria-hidden />
      {!compact && <span>{text}</span>}
      {compact && <span className="sr-only">{text}</span>}
    </Link>
  );
}

export function SearchNowButton() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useStatus();
  const [busy, setBusy] = useState(false);
  const active = status.data?.queue.active?.[0];
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={busy || !!active}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api('POST', '/api/runs', { type: 'adhoc' });
          const connected = status.data?.executor.state !== 'awaiting_connection';
          toast(
            r.existing
              ? 'A search is already queued.'
              : connected
                ? 'Search queued. Results appear when the research service picks it up.'
                : 'Search queued, but no research service is connected yet — see Settings → Research.',
          );
          await qc.invalidateQueries({ queryKey: ['status'] });
        } catch (e) {
          toast(errorMessage(e), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      <RefreshCw size={15} aria-hidden className={active?.status === 'running' ? 'spin' : ''} />
      {active ? (active.status === 'running' ? 'Searching…' : 'Queued') : 'Search now'}
    </button>
  );
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const res = useQuery({ queryKey: ['search', debounced], queryFn: () => get(`/api/search?q=${encodeURIComponent(debounced)}`), enabled: debounced.length >= 2 });
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea,select')) {
        e.preventDefault();
        ref.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const d = res.data;
  const go = (to: string) => {
    setOpen(false);
    setQ('');
    nav(to);
  };
  return (
    <div className="searchbox" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <Search size={17} aria-hidden className="searchbox-icon" />
        <input
          type="search"
          value={q}
          placeholder="Search events, artists, venues, cities"
          aria-label="Search events, artists, venues and cities"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
      </form>
      {open && debounced.length >= 2 && d && (
        <div className="search-pop" role="region" aria-label="Search suggestions">
          {d.cities.length > 0 && (
            <div className="search-sec">
              <h3>Cities</h3>
              {d.cities.map((c: any) => (
                <button key={c.slug} type="button" onClick={() => go(c.slug === 'ibiza' ? '/ibiza' : `/cities/${c.slug}`)}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {d.artists.length > 0 && (
            <div className="search-sec">
              <h3>Artists</h3>
              {d.artists.slice(0, 5).map((a: any) => (
                <button key={a.id} type="button" onClick={() => go(`/artists/${a.id}`)}>
                  {a.name}
                  {a.watch_status && <span className="muted"> · on your watchlist</span>}
                </button>
              ))}
            </div>
          )}
          {d.events.length > 0 && (
            <div className="search-sec">
              <h3>Events</h3>
              {d.events.slice(0, 6).map((e: any) => (
                <button key={e.id} type="button" onClick={() => go(`/events/${e.id}`)}>
                  {e.title}
                  <span className="muted"> · {e.start_local.slice(0, 10)}</span>
                </button>
              ))}
            </div>
          )}
          {d.venues.length > 0 && (
            <div className="search-sec">
              <h3>Venues</h3>
              {d.venues.slice(0, 4).map((v: any) => (
                <button key={v.id} type="button" onClick={() => go(`/search?q=${encodeURIComponent(v.name)}`)}>
                  {v.name}
                  <span className="muted"> · {v.town ?? v.city}</span>
                </button>
              ))}
            </div>
          )}
          {!d.cities.length && !d.artists.length && !d.events.length && !d.venues.length && <p className="muted pad">No matches</p>}
          <button type="button" className="search-all" onClick={() => go(`/search?q=${encodeURIComponent(q.trim())}`)}>
            See all results for “{q.trim()}”
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const feed = useQuery({ queryKey: ['feed'], queryFn: () => get('/api/feed'), refetchInterval: 60_000 });
  const unread = feed.data?.unread ?? 0;
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const appName = meta.data?.app_name ?? 'Quartet';

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          {appName}
        </Link>
        <nav>
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.end} className="nav-link">
                  <n.icon size={19} aria-hidden />
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <ul className="nav-secondary">
            <li>
              <NavLink to="/updates" className="nav-link">
                <Bell size={19} aria-hidden />
                Updates
                {unread > 0 && <span className="count-badge" aria-label={`${unread} unread`}>{unread}</span>}
              </NavLink>
            </li>
            <li>
              <NavLink to="/add" className="nav-link">
                <Plus size={19} aria-hidden />
                Add event or booking
              </NavLink>
            </li>
            <li>
              <NavLink to="/settings" className="nav-link">
                <Settings size={19} aria-hidden />
                Settings
              </NavLink>
            </li>
          </ul>
        </nav>
        <div className="sidebar-foot">
          <StatusPill />
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <Link to="/" className="brand brand-mobile">
            <span className="brand-mark" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </span>
            {appName}
          </Link>
          <SearchBox />
          <div className="topbar-actions">
            <span className="hide-mobile">
              <SearchNowButton />
            </span>
            <span className="show-mobile">
              <StatusPill compact />
            </span>
            <Link to="/add" className="icon-btn show-mobile" aria-label="Add event or booking">
              <Plus size={20} aria-hidden />
            </Link>
            <Link to="/updates" className="icon-btn show-mobile bell" aria-label={`Updates${unread ? `, ${unread} unread` : ''}`}>
              <Bell size={20} aria-hidden />
              {unread > 0 && <span className="dot-badge" aria-hidden />}
            </Link>
            <Link to="/settings" className="icon-btn show-mobile" aria-label="Settings">
              <Settings size={20} aria-hidden />
            </Link>
          </div>
        </header>
        {meta.data?.demo.loaded && (
          <div className="demo-banner" role="note">
            Demo data is loaded: items marked <strong>Demo</strong> are fictional examples, not real listings.{' '}
            <Link to="/settings/data">Remove demo data</Link>
          </div>
        )}
        <main id="main" ref={mainRef} tabIndex={-1}>
          {children}
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="bottom-link">
            <n.icon size={21} aria-hidden />
            <span>{n.short ?? n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
