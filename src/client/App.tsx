import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { UnlockProvider } from './components/Editor';
import { Layout } from './components/Layout';
import { get } from './lib/api';
import { ArtistDetailPage, ArtistsPage } from './pages/Artists';
import { CalendarPage } from './pages/Calendar';
import { CitiesPage, CityPage } from './pages/Cities';
import { DiscoverPage } from './pages/Discover';
import { EventDetailPage } from './pages/EventDetail';
import { AddPage, EditEventPage, EntryPage } from './pages/EventEditor';
import { FestivalsPage } from './pages/Festivals';
import { IbizaPage } from './pages/Ibiza';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/Settings';
import { UpdatesPage } from './pages/Updates';

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Discover'],
  [/^\/cities/, 'Cities'],
  [/^\/festivals/, 'Festivals'],
  [/^\/artists/, 'Artists'],
  [/^\/ibiza/, 'Ibiza'],
  [/^\/plans|^\/calendar|^\/entries/, 'My plans'],
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
    // An editor session ended (expired or locked elsewhere): refresh the editing state.
    const onOut = () => qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('quartet:signed-out', onOut);
    return () => window.removeEventListener('quartet:signed-out', onOut);
  }, [qc]);

  useEffect(() => {
    const t = TITLES.find(([r]) => r.test(loc.pathname))?.[1];
    document.title = t ? `${t} · ${appName}` : appName;
  }, [loc.pathname, appName]);

  return (
    <UnlockProvider>
    <Layout>
      <Routes>
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/cities" element={<CitiesPage />} />
        <Route path="/cities/:slug" element={<CityPage />} />
        <Route path="/festivals" element={<FestivalsPage />} />
        <Route path="/artists" element={<ArtistsPage />} />
        <Route path="/artists/:id" element={<ArtistDetailPage />} />
        <Route path="/ibiza" element={<IbizaPage />} />
        <Route path="/plans" element={<CalendarPage />} />
        <Route path="/calendar" element={<Navigate to="/plans?tab=calendar" replace />} />
        <Route path="/entries/:id" element={<EntryPage />} />
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
    </UnlockProvider>
  );
}
