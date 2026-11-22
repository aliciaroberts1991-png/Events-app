import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { get } from './lib/api';
import { ArtistDetailPage, ArtistsPage } from './pages/Artists';
import { CalendarPage } from './pages/Calendar';
import { CitiesPage, CityPage } from './pages/Cities';
import { DiscoverPage } from './pages/Discover';
import { EventDetailPage } from './pages/EventDetail';
import { AddPage, EditEventPage } from './pages/EventEditor';
import { FestivalsPage } from './pages/Festivals';
import { IbizaPage } from './pages/Ibiza';
import { LoginPage } from './pages/Login';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/Settings';
import { UpdatesPage } from './pages/Updates';

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Discover'],
  [/^\/cities/, 'Cities'],
  [/^\/festivals/, 'Festivals'],
  [/^\/artists/, 'Artists'],
  [/^\/ibiza/, 'Ibiza'],
  [/^\/calendar/, 'My calendar'],
  [/^\/events/, 'Event'],
  [/^\/updates/, 'Updates'],
  [/^\/settings/, 'Settings'],
  [/^\/add/, 'Add'],
  [/^\/search/, 'Search'],
];

export function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => get('/api/auth/state'), staleTime: 60_000 });
  const loc = useLocation();
  const appName = auth.data?.app_name ?? 'Quartet';

  useEffect(() => {
    const onOut = () => {
      qc.clear();
      qc.invalidateQueries({ queryKey: ['auth'] });
    };
    window.addEventListener('quartet:signed-out', onOut);
    return () => window.removeEventListener('quartet:signed-out', onOut);
  }, [qc]);

  useEffect(() => {
    const t = TITLES.find(([r]) => r.test(loc.pathname))?.[1];
    document.title = t ? `${t} · ${appName}` : appName;
  }, [loc.pathname, appName]);

  if (auth.isLoading) return <Spinner label="Starting" />;
  if (!auth.data?.user) return <LoginPage appName={appName} hasOwner={!!auth.data?.has_owner} onDone={() => qc.invalidateQueries()} />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/cities" element={<CitiesPage />} />
        <Route path="/cities/:slug" element={<CityPage />} />
        <Route path="/festivals" element={<FestivalsPage />} />
        <Route path="/artists" element={<ArtistsPage />} />
        <Route path="/artists/:id" element={<ArtistDetailPage />} />
        <Route path="/ibiza" element={<IbizaPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/events/:id/edit" element={<EditEventPage />} />
        <Route path="/add" element={<AddPage />} />
        <Route path="/add/:mode" element={<AddPage />} />
        <Route path="/updates" element={<UpdatesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
