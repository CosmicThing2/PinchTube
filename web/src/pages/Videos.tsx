import { useSearchParams } from 'react-router-dom';
import { VideoBrowser } from '../components/VideoBrowser';

export function Videos() {
  return (
    <div>
      <h1 className="page-title">All videos</h1>
      <VideoBrowser emptyMessage="Nothing matched these filters." />
    </div>
  );
}

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
