/*
 * AppShell.tsx — the frame around every page once signed in.
 *
 * Draws the parts that stay put while pages change (main.tsx puts each page
 * inside it):
 *   - the header: menu button, logo, search box, and buttons for queue
 *     mode, data saver and light/dark theme
 *   - the side menu on a wide screen (a slide-out drawer in theater mode)
 *   - the bottom tab bar on a phone
 * Also applies layout-wide classes, such as the card size setting and
 * theater mode on the watch page, which styles/app.css responds to, and runs
 * the "delete downloads once watched" setting, since it is not tied to a page.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/app-context';
import { useQueue } from '../lib/queue-context';
import { removeWatchedDownloads } from '../lib/offline';
import {
  IconChannels,
  IconClose,
  IconGrid,
  IconHome,
  IconLibrary,
  IconLogout,
  IconMenu,
  IconDataSaver,
  IconDownload,
  IconMoon,
  IconPlaylist,
  IconQueue,
  IconQueueAdd,
  IconSearch,
  IconSettings,
  IconSun,
} from './Icons';
import { LogoMark } from './Logo';

/** The logo, sized for the header. */
function BrandMark() {
  return <LogoMark className="brand-mark" />;
}

/** The side menu's links. */
const NAV = [
  { to: '/', label: 'Home', Icon: IconHome, end: true },
  { to: '/videos', label: 'All videos', Icon: IconGrid, end: false },
  { to: '/channels', label: 'Channels', Icon: IconChannels, end: false },
  { to: '/queue', label: 'Queue', Icon: IconQueue, end: false },
  { to: '/playlists', label: 'Playlists', Icon: IconPlaylist, end: false },
  { to: '/downloads', label: 'Downloads', Icon: IconDownload, end: false },
  { to: '/settings', label: 'Settings', Icon: IconSettings, end: false },
];

/**
 * A phone has room for five tabs, so the queue, playlists and downloads share
 * one "Library" tab; the pages themselves carry a switch between them.
 */
const TABS = [
  { to: '/', label: 'Home', Icon: IconHome, match: (p: string) => p === '/' },
  { to: '/videos', label: 'Videos', Icon: IconGrid, match: (p: string) => p.startsWith('/videos') },
  { to: '/channels', label: 'Channels', Icon: IconChannels, match: (p: string) => p.startsWith('/channel') },
  {
    to: '/library',
    label: 'Library',
    Icon: IconLibrary,
    match: (p: string) =>
      p.startsWith('/queue') || p.startsWith('/playlist') || p.startsWith('/downloads') || p === '/library',
  },
  { to: '/settings', label: 'Settings', Icon: IconSettings, match: (p: string) => p.startsWith('/settings') },
];

/** How long after leaving a video to check, so its last progress save has landed. */
const WATCHED_CHECK_DELAY_MS = 2000;

/**
 * The "delete downloads once watched" setting: checks when the app opens and
 * each time a video is left, never touching the video open right now.
 */
function useDeleteWatchedDownloads(pathname: string): void {
  const { user, settings } = useApp();
  const userId = user?.id ?? null;
  const enabled = settings?.ui.autoDeleteWatchedDownloads === true;
  const since = settings?.ui.autoDeleteSince ?? 0;
  const watching = pathname.startsWith('/watch/') ? pathname.split('/')[2] : null;
  const previous = useRef<string | null>(null);
  const checkedOnOpen = useRef(false);

  useEffect(() => {
    const left = previous.current;
    previous.current = watching;
    if (!enabled || userId === null) return;
    const opening = !checkedOnOpen.current;
    checkedOnOpen.current = true;
    if (!opening && (!left || left === watching)) return;

    const timer = window.setTimeout(() => {
      void removeWatchedDownloads(userId, since, watching).catch(() => {});
    }, WATCHED_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [watching, enabled, since, userId]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, setTheme, logout, theater, settings, dataSaver, setDataSaver } = useApp();
  const { count: queueCount, queueMode, setQueueMode } = useQueue();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  useDeleteWatchedDownloads(location.pathname);
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  /**
   * The drawer only animates once ☰ has been pressed. Switching into theater
   * layout moves the closed drawer off screen too, and that move must not
   * play as a slide every time a video opens.
   */
  const [drawerArmed, setDrawerArmed] = useState(false);

  // Theater only reshapes the layout on a watch page — elsewhere the nav stays put.
  const theaterLayout = theater && location.pathname.startsWith('/watch/');

  // Close the drawer on navigation, and whenever theater mode is left.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  useEffect(() => {
    if (!theaterLayout) {
      setNavOpen(false);
      setDrawerArmed(false);
    }
  }, [theaterLayout]);

  // Keep the box in step with the URL when arriving on /search directly.
  useEffect(() => {
    setQuery(location.pathname === '/search' ? (params.get('q') ?? '') : '');
  }, [location.pathname, params]);

  /** Searching goes to the search page with the words in the address. */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <div
      className={`app card-${settings?.appearance.cardSize ?? 'md'}${theaterLayout ? ' theater' : ''}${
        drawerArmed && settings?.appearance.animateMenu !== false ? ' drawer-animated' : ''
      }`}
    >
      {/* ---- header ---- */}
      <header className="header">
        <button
          className="icon-btn burger"
          onClick={() => {
            setDrawerArmed(true);
            setNavOpen((open) => !open);
          }}
          aria-label="Menu"
          aria-expanded={navOpen}
        >
          <IconMenu />
        </button>

        <Link className="brand" to="/">
          <BrandMark />
          <span className="hide-sm">PinchTube</span>
        </Link>

        <form className="search" onSubmit={submit} role="search">
          <IconSearch className="search-icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search videos and channels"
            aria-label="Search"
            enterKeyHint="search"
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <IconClose style={{ width: 15, height: 15, fill: 'currentColor' }} />
            </button>
          ) : null}
        </form>

        {/* Queue mode: tapping videos adds them to the queue */}
        <button
          className={queueMode ? 'icon-btn active' : 'icon-btn'}
          onClick={() => {
            const next = !queueMode;
            setQueueMode(next);
            // The queue page has nothing to add, so go where the videos are.
            if (next && location.pathname === '/queue') navigate('/');
          }}
          aria-pressed={queueMode}
          aria-label="Add-to-queue mode"
          title={
            queueMode
              ? `Adding to the queue (${queueCount}) — tap videos to add them`
              : 'Add-to-queue mode is off'
          }
        >
          <IconQueueAdd />
        </button>

        {/* Data saver: plays at the mobile-data default quality (this device only) */}
        <button
          className={dataSaver ? 'icon-btn active' : 'icon-btn'}
          onClick={() => setDataSaver(!dataSaver)}
          aria-pressed={dataSaver}
          aria-label="Data saver"
          title={dataSaver ? 'Data saver is on' : 'Data saver is off'}
        >
          <IconDataSaver />
        </button>

        {/* Light / dark theme */}
        <button
          className="icon-btn"
          onClick={() => setTheme(nextTheme)}
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      <div className="body">
        {theaterLayout ? (
          <div className={navOpen ? 'nav-scrim open' : 'nav-scrim'} onClick={() => setNavOpen(false)} />
        ) : null}

        {/* ---- side menu (a drawer in theater mode) ---- */}
        <nav className={navOpen ? 'sidebar open' : 'sidebar'}>
          <div className="drawer-head">
            <button className="icon-btn" onClick={() => setNavOpen(false)} aria-label="Close menu">
              <IconMenu />
            </button>
            <Link className="brand" to="/">
              <BrandMark />
              <span>PinchTube</span>
            </Link>
          </div>

          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <Icon />
              <span>{label}</span>
              {to === '/queue' && queueCount > 0 ? <span className="badge">{queueCount}</span> : null}
            </NavLink>
          ))}

          <div className="nav-section">Account</div>
          <button className="nav-link" onClick={() => void logout()} style={{ width: '100%' }}>
            <IconLogout />
            <span>Sign out</span>
          </button>
        </nav>

        {/* ---- the current page ---- */}
        <main className="main">{children}</main>
      </div>

      {/* ---- phone tab bar ---- */}
      <nav className="tabbar">
        {TABS.map(({ to, label, Icon, match }) => (
          <Link key={to} to={to} className={match(location.pathname) ? 'tab active' : 'tab'}>
            <span className="tab-icon">
              <Icon />
              {to === '/library' && queueCount > 0 ? <span className="dot" /> : null}
            </span>
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
