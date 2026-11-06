/*
 * Downloads.tsx — the Downloads page (/downloads), in the Library, and one
 * channel's downloads (/downloads/channel/:key).
 *
 *   Downloads         the videos this account saved to the browser cache, as
 *                     one sortable list; or, with the "Organise downloads by
 *                     channel" setting on, a grid of the channels they came
 *                     from (like the Channels page). Downloads still being
 *                     prepared or fetched are shown above, and "Delete all"
 *                     removes every saved video after typing "delete all".
 *   DownloadsChannel  one channel's downloaded videos, as a sortable list
 * The sort order is kept in the address bar (?sort=…), so Back keeps it.
 * Everything here lives in this browser only (lib/offline.ts); another phone
 * or computer has its own list.
 */

import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { urls } from '../lib/api';
import { useApp } from '../lib/app-context';
import { formatBytes, formatCount, formatRelative } from '../lib/format';
import {
  OFFLINE_SORTS,
  cancelAllDownloads,
  cancelDownload,
  completeDetails,
  listOffline,
  removeAllOffline,
  removeOffline,
  sortOffline,
  taskLabel,
  useDownloadTasks,
  useOfflineVersion,
  type OfflineVideo,
} from '../lib/offline';
import { ChannelCard, Dialog, EmptyState, Select, Spinner } from '../components/Common';
import { LibrarySwitch } from '../components/LibrarySwitch';
import { DownloadedBadge } from '../components/VideoCard';
import { IconClose, IconTrash } from '../components/Icons';

/** The sort used until another is picked: the order things were downloaded in. */
const DEFAULT_SORT = 'saved_desc';

/** What has to be typed before "Delete all" will go ahead (any capitals). */
const CONFIRM_PHRASE = 'delete all';

/** A channel's place in the grid and its address; copies with no known channel are grouped by name. */
const channelKey = (video: OfflineVideo) => video.channelId || `name:${video.channelTitle}`;

/** The account's downloads, reloaded whenever one is stored or removed. */
function useDownloads(): { items: OfflineVideo[] | null; error: string | null } {
  const { user } = useApp();
  const version = useOfflineVersion();
  const [items, setItems] = useState<OfflineVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listOffline(user.id)
      .then(completeDetails)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not read the downloads in this browser');
      });
    return () => {
      cancelled = true;
    };
  }, [user, version]);

  return { items, error };
}

/** The sort order from the address bar, and a way to change it. */
function useSort(): [string, (sort: string) => void] {
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') ?? DEFAULT_SORT;
  const setSort = (next: string) => {
    const query = new URLSearchParams(params);
    if (next === DEFAULT_SORT) query.delete('sort');
    else query.set('sort', next);
    setParams(query, { replace: true });
  };
  return [OFFLINE_SORTS.some((option) => option.value === sort) ? sort : DEFAULT_SORT, setSort];
}

const totalSize = (videos: OfflineVideo[]) => videos.reduce((sum, video) => sum + video.size, 0);

/** The whole Downloads page. */
export function Downloads() {
  const { settings } = useApp();
  const { items, error } = useDownloads();
  const [sort, setSort] = useSort();
  const [confirming, setConfirming] = useState(false);
  const byChannel = settings?.ui.downloadsByChannel === true;

  return (
    <div style={{ maxWidth: byChannel ? undefined : 900 }}>
      <LibrarySwitch current="downloads" />
      <h1 className="page-title">Downloads</h1>
      <p className="muted" style={{ margin: '-6px 0 14px', fontSize: 13 }}>
        All videos are saved to the browser cache and will play automatically from the cache. Be aware that
        clearing your browser data for PinchTube will remove all your videos.
      </p>

      {error ? <div className="notice error">{error}</div> : null}

      <TaskList />

      {/* What is stored: a channel grid or one list, with the total and "Delete all" */}
      {!items ? (
        error ? null : <Spinner center />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing downloaded yet"
          message="Use “Download” under any video, then “Save to browser cache”."
        />
      ) : (
        <>
          <div className="toolbar">
            {byChannel ? null : <SortMenu value={sort} onChange={setSort} />}
            <span className="muted" style={{ fontSize: 13 }}>
              {formatCount(items.length, 'video')} · {formatBytes(totalSize(items))}
            </span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setConfirming(true)}>
              <IconTrash />
              Delete all
            </button>
          </div>
          {byChannel ? <ChannelGrid items={items} /> : <VideoList items={sortOffline(items, sort)} />}
        </>
      )}

      {confirming && items ? <DeleteAllDialog items={items} onClose={() => setConfirming(false)} /> : null}
    </div>
  );
}

/** One channel's downloads, reached from the channel grid. */
export function DownloadsChannel() {
  const { key = '' } = useParams();
  const { items, error } = useDownloads();
  const [sort, setSort] = useSort();
  const videos = items?.filter((video) => channelKey(video) === key) ?? null;
  const channelId = key.startsWith('name:') ? null : key;
  const title = videos?.[0]?.channelTitle ?? (key.startsWith('name:') ? key.slice(5) : 'Downloads');

  return (
    <div style={{ maxWidth: 900 }}>
      <LibrarySwitch current="downloads" />

      {/* Avatar, name and what is downloaded from the channel */}
      <div className="channel-hero">
        <div className="channel-hero-body">
          {channelId ? (
            <img
              className="avatar-lg"
              src={urls.channelArt(channelId, 'poster', 240)}
              alt=""
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <h1>{title}</h1>
            <div className="sub">
              {videos ? `${formatCount(videos.length, 'video')} downloaded · ${formatBytes(totalSize(videos))}` : null}
            </div>
            <Link to="/downloads" className="muted" style={{ fontSize: 13, fontWeight: 650 }}>
              All downloads
            </Link>
          </div>
        </div>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {!videos ? (
        error ? null : <Spinner center />
      ) : videos.length === 0 ? (
        <EmptyState title="Nothing downloaded" message="No videos from this channel are saved to the browser cache." />
      ) : (
        <>
          <div className="toolbar">
            <SortMenu value={sort} onChange={setSort} />
          </div>
          <VideoList items={sortOffline(videos, sort)} />
        </>
      )}
    </div>
  );
}

/** The sort menu, styled like the channel pages' one. */
function SortMenu({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Select className="chip" value={value} options={OFFLINE_SORTS} ariaLabel="Sort order" onChange={onChange} />;
}

/** Downloads under way, or ones that failed, with their progress. */
function TaskList() {
  const tasks = useDownloadTasks();
  if (!tasks.length) return null;
  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <h2 style={{ margin: 0 }}>In progress</h2>
        {tasks.length > 1 ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={cancelAllDownloads}>
            Cancel all
          </button>
        ) : null}
      </div>
      {tasks.map((task) => (
        <div key={task.videoId} className="download-task">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="download-task-text">
              <Link to={`/watch/${task.videoId}`}>{task.title}</Link>
            </div>
            {task.phase === 'failed' ? (
              <div className="hint">{task.error}</div>
            ) : (
              <>
                <div className="hint">{taskLabel(task)}</div>
                <div className="download-bar">
                  <span style={{ width: `${Math.round(task.progress * 100)}%` }} />
                </div>
              </>
            )}
          </div>
          <button className="btn" onClick={() => cancelDownload(task.videoId)}>
            {task.phase === 'failed' ? 'Dismiss' : 'Cancel'}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Every channel with something downloaded, A–Z, laid out like the Channels page. */
function ChannelGrid({ items }: { items: OfflineVideo[] }) {
  const { settings } = useApp();
  const groups = new Map<string, OfflineVideo[]>();
  for (const video of items) {
    const key = channelKey(video);
    groups.set(key, [...(groups.get(key) ?? []), video]);
  }
  const channels = Array.from(groups, ([key, videos]) => ({ key, videos, title: videos[0].channelTitle })).sort(
    (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  );

  return (
    <div className={`channel-${settings?.appearance.channelLayout ?? 'auto'}`}>
      {channels.map(({ key, videos, title }) => (
        <ChannelCard
          key={key}
          channel={{ id: key, title, videoCount: videos.length, unwatchedCount: 0 }}
          to={`/downloads/channel/${encodeURIComponent(key)}`}
          detail={`${formatCount(videos.length, 'video')} · ${formatBytes(totalSize(videos))}`}
        />
      ))}
    </div>
  );
}

/** Downloaded videos as rows, each with a button to remove it. */
function VideoList({ items }: { items: OfflineVideo[] }) {
  const { user } = useApp();
  return (
    <>
      {items.map((video) => (
        <div className="queue-item" key={video.key}>
          <Link to={`/watch/${video.videoId}`} className="queue-thumb">
            <div className="thumb">
              <img src={urls.videoThumb(video.videoId, 320)} alt="" loading="lazy" />
              <DownloadedBadge />
            </div>
          </Link>
          <div className="card-text">
            <Link to={`/watch/${video.videoId}`}>
              <h3 className="card-title">{video.title}</h3>
            </Link>
            <div className="card-meta">
              <div>{video.channelTitle}</div>
              <div>
                {video.qualityLabel} · {formatBytes(video.size)} · saved {formatRelative(video.savedAt)}
              </div>
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={() => user && void removeOffline(user.id, video.videoId)}
            aria-label="Remove from the browser cache"
            title="Remove from the browser cache"
          >
            <IconClose />
          </button>
        </div>
      ))}
    </>
  );
}

/** Asks for "delete all" to be typed before removing every saved video. */
function DeleteAllDialog({ items, onClose }: { items: OfflineVideo[]; onClose: () => void }) {
  const { user } = useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === CONFIRM_PHRASE;

  const confirm = async () => {
    if (!user || !matches) return;
    setBusy(true);
    try {
      await removeAllOffline(user.id);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Could not delete the downloads');
      setBusy(false);
    }
  };

  return (
    <Dialog title="Delete all downloads" onClose={onClose} width={420}>
      <p style={{ marginTop: 0 }}>
        This removes all {formatCount(items.length, 'video')} ({formatBytes(totalSize(items))}) saved to this
        browser’s cache. It cannot be undone.
      </p>
      {error ? <div className="notice error">{error}</div> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <div className="field">
          <label htmlFor="delete-all-confirm">Type “{CONFIRM_PHRASE}” to confirm</label>
          <input
            id="delete-all-confirm"
            className="input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="download-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={!matches || busy}>
            <IconTrash />
            Confirm
          </button>
        </div>
      </form>
    </Dialog>
  );
}
