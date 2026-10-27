import { useEffect } from 'react';
import { Link } from 'react-router-dom';

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
