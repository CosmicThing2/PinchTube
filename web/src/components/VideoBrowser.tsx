import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type VideoDto } from '../lib/api';
import { useApp } from '../lib/app-context';
import { VideoCard } from './VideoCard';
import { EmptyState, Select, SkeletonGrid } from './Common';
import { formatCount } from '../lib/format';
import { IconChevronLeft, IconChevronRight, IconEye, IconEyeOff } from './Icons';

// One pill cycles through the three states rather than two competing toggles.
const WATCHED_CYCLE = ['all', 'unwatched', 'watched'] as const;

const WATCHED_LABELS: Record<string, string> = {
  all: 'All videos',
  unwatched: 'Unwatched only',
  watched: 'Watched only',
};

const SORT_OPTIONS = [
  { value: 'date_desc', label: 'Newest first' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'added_desc', label: 'Recently added' },
  { value: 'title_asc', label: 'Title A–Z' },
  { value: 'title_desc', label: 'Title Z–A' },
];

interface Props {
  channelId?: string;
  search?: string;
  showChannel?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
}

export function VideoBrowser({
  channelId,
  search,
  showChannel = true,
  emptyTitle = 'No videos found',
  emptyMessage,
}: Props) {
  const { settings } = useApp();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<VideoDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const sort = params.get('sort') ?? settings?.ui.defaultSort ?? 'date_desc';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const watched = params.get('watched') ?? (settings?.ui.hideWatched ? 'unwatched' : 'all');
  const pageSize = settings?.ui.pageSize ?? 48;

  const setParam = (key: string, value: string, resetPage = true) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (resetPage) next.delete('page');
    setParams(next, { replace: false });
  };

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);

    const query = new URLSearchParams();
    query.set('sort', sort);
    query.set('page', String(page));
    query.set('watched', watched);
    if (channelId) query.set('channel', channelId);
    if (search) query.set('q', search);

    api
      .get<{ items: VideoDto[]; total: number }>(`/api/videos?${query.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load videos');
      });

    return () => {
      cancelled = true;
    };
  }, [channelId, search, sort, page, watched]);

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="toolbar">
        <Select
          className="chip"
          value={sort}
          options={SORT_OPTIONS}
          ariaLabel="Sort order"
          onChange={(value) => setParam('sort', value)}
        />

        <button
          className={watched === 'all' ? 'chip' : 'chip active'}
          title="Filter by watched state"
          onClick={() => {
            const index = WATCHED_CYCLE.indexOf(watched as (typeof WATCHED_CYCLE)[number]);
            const next = WATCHED_CYCLE[(index + 1) % WATCHED_CYCLE.length];
            setParam('watched', next);
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {watched === 'watched' ? (
              <IconEye style={{ width: 14, height: 14, fill: 'currentColor' }} />
            ) : watched === 'unwatched' ? (
              <IconEyeOff style={{ width: 14, height: 14, fill: 'currentColor' }} />
            ) : null}
            {WATCHED_LABELS[watched] ?? WATCHED_LABELS.all}
          </span>
        </button>

        {items ? (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
            {formatCount(total, 'video')}
          </span>
        ) : null}
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {!items ? (
        <SkeletonGrid count={12} />
      ) : items.length === 0 ? (
        <EmptyState title={emptyTitle} message={emptyMessage} />
      ) : (
        <div className="grid">
          {items.map((video) => (
            <VideoCard key={video.id} video={video} showChannel={showChannel} />
          ))}
        </div>
      )}

      {lastPage > 1 ? (
        <div className="pager">
          <button
            className="btn"
            disabled={page <= 1}
            onClick={() => {
              setParam('page', String(page - 1), false);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <IconChevronLeft />
            Previous
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            Page {page} of {lastPage}
          </span>
          <button
            className="btn"
            disabled={page >= lastPage}
            onClick={() => {
              setParam('page', String(page + 1), false);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            Next
            <IconChevronRight />
          </button>
        </div>
      ) : null}
    </div>
  );
}
