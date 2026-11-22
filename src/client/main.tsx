import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './lib/hooks';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, retry: (n, e: any) => e?.status !== 401 && e?.status !== 404 && n < 2, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
