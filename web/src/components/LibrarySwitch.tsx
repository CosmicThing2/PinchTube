/*
 * LibrarySwitch.tsx — the Queue / Playlists / Downloads tabs shown on a phone.
 *
 * On a phone, Queue, Playlists and Downloads share one "Library" tab in the
 * bottom bar; this switch at the top of pages/Queue.tsx, pages/Playlists.tsx
 * and pages/Downloads.tsx moves between them, and remembers which was used
 * last so the Library tab (the /library address in main.tsx) reopens it.
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';

/** Browser storage key for the last-used page. */
const LAST_KEY = 'ytm-library-tab';

type LibraryPage = 'queue' | 'playlists' | 'downloads';

const PAGES: { id: LibraryPage; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'downloads', label: 'Downloads' },
];

/** Where the phone's "Library" tab should land: whichever page was used last. */
export function lastLibraryPage(): string {
  try {
    const last = localStorage.getItem(LAST_KEY);
    return PAGES.some((page) => page.id === last) ? `/${last}` : '/queue';
  } catch {
    return '/queue';
  }
}

/**
 * The Queue / Playlists / Downloads switch at the top of those pages. Only
 * shown on a phone, where they share one tab; the desktop sidebar lists them apart.
 */
export function LibrarySwitch({ current }: { current: LibraryPage }) {
  // Remember this page as the last used.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_KEY, current);
    } catch {
      /* private browsing */
    }
  }, [current]);

  return (
    <div className="library-switch" role="tablist">
      {PAGES.map((page) => (
        <Link
          key={page.id}
          to={`/${page.id}`}
          role="tab"
          aria-selected={current === page.id}
          className={current === page.id ? 'active' : undefined}
        >
          {page.label}
        </Link>
      ))}
    </div>
  );
}
