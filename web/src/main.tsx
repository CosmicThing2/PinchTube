/*
 * main.tsx — the web app's entry point.
 *
 * The web app is a React single-page app: the server sends one HTML page
 * (web/index.html) and this script draws everything in it, switching
 * "pages" in the browser without reloading. This file:
 *   - paints the saved theme and colours before anything else, so the page
 *     does not flash the wrong colours while loading
 *   - wraps the app in its shared state providers: AppProvider
 *     (lib/app-context.tsx: who is signed in, their settings) and
 *     QueueProvider (lib/queue-context.tsx: the play queue)
 *   - shows the setup or sign-in screen (pages/AuthPage.tsx) until signed
 *     in, then the main layout (components/AppShell.tsx) with the router
 *     that maps each address (/, /watch/:id, /settings, ...) to its page
 *   - registers the service worker (public/sw.js) when served over HTTPS
 */

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

/** Picks the screen: a spinner while checking the session, setup, sign-in, or the app itself. */
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

  // Signed in: the page for the current address, inside the header and side menu.
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

// Start the app in the page's #root element.
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
