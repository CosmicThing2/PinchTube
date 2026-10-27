import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type VideoDto } from '../lib/api';
import { useApp } from '../lib/app-context';
import { setPlaylistShuffle, type PlaylistResponse } from '../lib/playlist-playback';
import { EmptyState, Select, Spinner } from '../components/Common';
import { SortableList } from '../components/SortableList';
import { Thumb } from '../components/VideoCard';
import { formatCount, formatDuration, formatRelative } from '../lib/format';
import { IconClose, IconEdit, IconPlay, IconShuffle, IconTrash } from '../components/Icons';

const QUALITY_NAMES: Record<string, string> = {
  auto: 'Auto',
  original: 'Original',
  '2160p': '2160p',
  '1440p': '1440p',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p',
  '360p': '360p',
  audio: 'Audio only',
};

/** 'auto' here means "no override": the viewer's own default quality applies. */
const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Default' },
  { value: 'original', label: 'Original' },
  { value: '2160p', label: '2160p' },
  { value: '1440p', label: '1440p' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
  { value: 'audio', label: 'Audio only' },
];

export function Playlist() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { settings } = useApp();
  const [data, setData] = useState<PlaylistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The order on screen during a drag, read back when the drag ends. */
  const orderRef = useRef<VideoDto[]>([]);

  const apply = useCallback((response: PlaylistResponse) => {
    setData(response);
    orderRef.current = response.items;
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .get<PlaylistResponse>(`/api/playlists/${encodeURIComponent(id)}`)
      .then(apply)
      .catch((err) => setError(err?.message ?? 'Could not load the playlist'));
  }, [apply, id]);

  const run = async (work: () => Promise<PlaylistResponse | void>) => {
    setError(null);
    try {
      const result = await work();
      if (result) apply(result);
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong');
    }
  };

  if (error && !data) return <EmptyState title="Playlist unavailable" message={error} />;
  if (!data) return <Spinner center />;

  const { playlist, items } = data;
  const mine = playlist.mine;

  const play = (shuffled: boolean) => {
    if (!items.length) return;
    setPlaylistShuffle(playlist.id, items, shuffled);
    let first = items[0].id;
    if (shuffled) {
      try {
        const order = JSON.parse(localStorage.getItem(`ytm-playlist-${playlist.id}-order`) ?? '[]');
        if (Array.isArray(order) && typeof order[0] === 'string') first = order[0];
      } catch {
        /* fall back to the first video */
      }
    }
    navigate(`/watch/${first}?list=${playlist.id}`);
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      const result = await api.patch<PlaylistResponse>(`/api/playlists/${playlist.id}`, { name: name.trim() });
      setRenaming(false);
      return result;
    });
  };

  const moveTo = (from: number, to: number) => {
    const next = orderRef.current.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    orderRef.current = next;
    setData((current) => (current ? { ...current, items: next } : current));
  };

  const saveOrder = () =>
    void run(() =>
      api.post<PlaylistResponse>(`/api/playlists/${playlist.id}/order`, {
        ids: orderRef.current.map((video) => video.id),
      }),
    );

  const renderRow = (video: VideoDto, index: number, handle: ReactNode, dragging: boolean) => (
    <div className={`queue-item${dragging ? ' dragging' : ''}`}>
      {handle}
      <span className="queue-index">{index + 1}</span>
      <Link to={`/watch/${video.id}?list=${playlist.id}`} className="queue-thumb">
        <Thumb video={video} width={320} />
      </Link>
      <div className="card-text">
        <Link to={`/watch/${video.id}?list=${playlist.id}`}>
          <h3 className="card-title">{video.title}</h3>
        </Link>
        <div className="card-meta">
          <div>{video.channelTitle}</div>
          <div>{formatRelative(video.aired)}</div>
        </div>
      </div>
      {mine ? (
        <button
          className="icon-btn"
          onClick={() =>
            void run(() =>
              api.del<PlaylistResponse>(`/api/playlists/${playlist.id}/items/${encodeURIComponent(video.id)}`),
            )
          }
          aria-label="Remove from playlist"
          title="Remove from playlist"
        >
          <IconClose />
        </button>
      ) : null}
    </div>
  );

  return (
    <div style={{ maxWidth: 900 }}>
      {renaming ? (
        <form onSubmit={rename} style={{ display: 'flex', gap: 8, margin: '4px 0 14px' }}>
          <input
            className="input"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            style={{ flex: 1 }}
            aria-label="Playlist name"
          />
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button className="btn" type="button" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{playlist.name}</span>
          {mine ? (
            <button
              className="icon-btn"
              onClick={() => {
                setName(playlist.name);
                setRenaming(true);
              }}
              aria-label="Rename"
              title="Rename"
            >
              <IconEdit />
            </button>
          ) : null}
        </h1>
      )}

      <p className="muted" style={{ margin: '-6px 0 14px', fontSize: 13 }}>
        {mine ? (playlist.shared ? 'Shared with everyone' : 'Private') : `Shared by ${playlist.owner}`}
        {' · '}
        {formatCount(items.length, 'video')}
        {playlist.duration ? ` · ${formatDuration(playlist.duration)}` : ''}
      </p>

      {error ? <div className="notice error">{error}</div> : null}

      <div className="toolbar">
        <button className="btn primary" disabled={!items.length} onClick={() => play(false)}>
          <IconPlay />
          Play all
        </button>
        <button className="btn" disabled={items.length < 2} onClick={() => play(true)}>
          <IconShuffle />
          Shuffle
        </button>
      </div>

      <div className="panel">
        <h2>Playlist settings</h2>
        {mine ? (
          <>
            <div className="settings-row">
              <div className="grow">
                <div className="label">Share with everyone</div>
                <div className="hint">Other users can see and play it, but not change it.</div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={playlist.shared}
                  onChange={(event) =>
                    void run(() =>
                      api.patch<PlaylistResponse>(`/api/playlists/${playlist.id}`, { shared: event.target.checked }),
                    )
                  }
                />
                <span className="track" />
              </label>
            </div>
            <div className={playlist.shared ? 'settings-row' : 'settings-row is-disabled'}>
              <div className="grow">
                <div className="label">Strict access permissions</div>
                <div className="hint">
                  {playlist.strict
                    ? 'On: other users only see and play the videos from channels they have access to.'
                    : 'Off: anyone it is shared with can play every video in it, even from channels they cannot otherwise see.'}
                </div>
              </div>
              <label className={playlist.shared ? 'switch' : 'switch is-disabled'}>
                <input
                  type="checkbox"
                  checked={playlist.strict}
                  disabled={!playlist.shared}
                  onChange={(event) =>
                    void run(() =>
                      api.patch<PlaylistResponse>(`/api/playlists/${playlist.id}`, { strict: event.target.checked }),
                    )
                  }
                />
                <span className="track" />
              </label>
            </div>
          </>
        ) : null}
          <div className="settings-row">
            <div className="grow">
              <div className="label">Quality</div>
              <div className="hint">
                All videos will play at this quality by default. Data saver takes priority when enabled.
              </div>
            </div>
            <Select
              value={playlist.quality}
              options={QUALITY_OPTIONS.map((option) => {
                if (option.value !== 'auto') return option;
                // Show what "Default" currently resolves to: the viewer's own
                // default quality from Settings → Playback.
                const fallback = settings?.playback.defaultQualityWifi;
                return { ...option, label: fallback ? `Default (${QUALITY_NAMES[fallback] ?? fallback})` : 'Default' };
              })}
              ariaLabel="Playlist quality"
              style={{ height: 38, width: 200, maxWidth: '100%' }}
              onChange={(value) =>
                void run(() => api.patch<PlaylistResponse>(`/api/playlists/${playlist.id}`, { quality: value }))
              }
            />
          </div>
          {mine ? (
          <div className="settings-row">
            <div className="grow">
              <div className="label">Delete playlist</div>
              <div className="hint">The videos themselves are not touched.</div>
            </div>
            {confirmDelete ? (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <button className="btn" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  onClick={() =>
                    void run(async () => {
                      await api.del(`/api/playlists/${playlist.id}`);
                      navigate('/playlists');
                    })
                  }
                >
                  Delete
                </button>
              </span>
            ) : (
              <button className="btn" onClick={() => setConfirmDelete(true)}>
                <IconTrash />
                Delete
              </button>
            )}
          </div>
          ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="Nothing in this playlist"
          message={mine ? 'Use “Save” under any video to add it here.' : 'There is nothing here you have access to.'}
        />
      ) : mine ? (
        <SortableList
          items={items}
          keyOf={(video) => video.id}
          onMove={moveTo}
          onDrop={saveOrder}
          renderItem={(video, index, { handle, dragging }) => renderRow(video, index, handle, dragging)}
        />
      ) : (
        <div>
          {items.map((video, index) => (
            <div key={video.id}>{renderRow(video, index, null, false)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
