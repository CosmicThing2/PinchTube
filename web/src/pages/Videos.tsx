/*
 * Videos.tsx — the "All videos" page (/videos) and search results (/search?q=…).
 *
 * Both are a heading over components/VideoBrowser.tsx, which does the
 * sorting, filtering and paging. The search box itself is in the header
 * (components/AppShell.tsx).
 */

import { useSearchParams } from 'react-router-dom';
import { VideoBrowser } from '../components/VideoBrowser';

/** Every video in the library the user may see. */
export function Videos() {
  return (
    <div>
      <h1 className="page-title">All videos</h1>
      <VideoBrowser emptyMessage="Nothing matched these filters." />
    </div>
  );
}

/** Videos whose title, description or channel name match the search words. */
export function Search() {
  const [params] = useSearchParams();
  const query = params.get('q') ?? '';

  return (
    <div>
      <h1 className="page-title">
        Results for <span style={{ color: 'var(--accent)' }}>{query}</span>
      </h1>
      <VideoBrowser
        search={query}
        emptyTitle="No matches"
        emptyMessage="Try a different word, or part of a channel name."
      />
    </div>
  );
}
