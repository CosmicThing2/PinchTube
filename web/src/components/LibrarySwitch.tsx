/*
 * LibrarySwitch.tsx — the Queue / Playlists tabs shown on a phone.
 *
 * On a phone, Queue and Playlists share one "Library" tab in the bottom bar;
 * this switch at the top of pages/Queue.tsx and pages/Playlists.tsx moves
 * between them, and remembers which was used last so the Library tab
 * (the /library address in main.tsx) reopens it.
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';

/** Browser storage key for the last-used half. */
const LAST_KEY = 'ytm-library-tab';

/** Where the phone's "Library" tab should land: whichever half was used last. */
export function lastLibraryPage(): '/queue' | '/playlists' {
  try {
    return localStorage.getItem(LAST_KEY) === 'playlists' ? '/playlists' : '/queue';
  } catch {
    return '/queue';
  }
}

/**
 * The Queue / Playlists switch at the top of both pages. Only shown on a
 * phone, where the two share one tab; the desktop sidebar lists them apart.
 */
export function LibrarySwitch({ current }: { current: 'queue' | 'playlists' }) {
  // Remember this half as the last used.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_KEY, current);
    } catch {
      /* private browsing */
    }
  }, [current]);

  return (
    <div className="library-switch" role="tablist">
      <Link
        to="/queue"
        role="tab"
        aria-selected={current === 'queue'}
        className={current === 'queue' ? 'active' : undefined}
      >
        Queue
      </Link>
      <Link
        to="/playlists"
        role="tab"
        aria-selected={current === 'playlists'}
        className={current === 'playlists' ? 'active' : undefined}
      >
        Playlists
      </Link>
    </div>
  );
}
