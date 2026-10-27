import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import './styles/app.css';
import { AppProvider, applyTheme, readCachedTheme, useApp } from './lib/app-context';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/Common';
import { AuthPage } from './pages/AuthPage';
import { Home } from './pages/Home';
import { Search, Videos } from './pages/Videos';
import { Channel, Channels } from './pages/Channels';
import { Watch } from './pages/Watch';
import { Settings } from './pages/Settings';
import { Queue } from './pages/Queue';
import { Playlists } from './pages/Playlists';
import { Playlist } from './pages/Playlist';
import { lastLibraryPage } from './components/LibrarySwitch';
import { QueueProvider } from './lib/queue-context';
import { applyColours, readCachedColours } from './lib/accent';

// Paint the right colours before React mounts, so there is no light flash.
applyTheme(readCachedTheme());
applyColours(readCachedColours());

function Router() {
  const { status } = useApp();

  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
        <Spinner />
      </div>
    );
  }

  if (status === 'setup') return <AuthPage mode="setup" />;
  if (status === 'login') return <AuthPage mode="login" />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/videos" element={<Videos />} />
        <Route path="/channels" element={<Channels />} />
        <Route path="/channel/:id" element={<Channel />} />
        <Route path="/watch/:id" element={<Watch />} />
        <Route path="/search" element={<Search />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/playlist/:id" element={<Playlist />} />
        <Route path="/library" element={<Navigate to={lastLibraryPage()} replace />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <QueueProvider>
          <Router />
        </QueueProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);

// The service worker only registers on a secure origin; over plain HTTP it is a no-op.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
