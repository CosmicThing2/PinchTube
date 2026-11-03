/*
 * Downloads.tsx — the Downloads page (/downloads), in the Library.
 *
 * Lists the videos this account has kept on this device (newest first),
 * with their quality, size and the total space they take, and buttons to
 * play or remove each. Downloads still being prepared or fetched are shown
 * above them with their progress. Everything here lives in this browser
 * only (lib/offline.ts); another phone or computer has its own list.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { urls } from '../lib/api';
import { useApp } from '../lib/app-context';
import { formatBytes, formatCount, formatRelative } from '../lib/format';
import {
  cancelDownload,
  listOffline,
  removeOffline,
  useDownloadTasks,
  useOfflineVersion,
  type OfflineVideo,
} from '../lib/offline';
import { EmptyState, Spinner } from '../components/Common';
import { LibrarySwitch } from '../components/LibrarySwitch';
import { IconClose } from '../components/Icons';

export function Downloads() {
  const { user } = useApp();
  const version = useOfflineVersion();
  const tasks = useDownloadTasks();
  const [items, setItems] = useState<OfflineVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reload whenever something is stored or removed.
  useEffect(() => {
    if (!user) return;
    listOffline(user.id)
      .then(setItems)
      .catch((err) => setError(err?.message ?? 'Could not read this device’s downloads'));
  }, [user, version]);

  const total = items?.reduce((sum, video) => sum + video.size, 0) ?? 0;

  return (
    <div style={{ maxWidth: 900 }}>
      <LibrarySwitch current="downloads" />
      <h1 className="page-title">Downloads</h1>
      <p className="muted" style={{ margin: '-6px 0 14px', fontSize: 13 }}>
        Videos kept on this device play from here instead of streaming. They are stored in this browser, so
        clearing its data for this site removes them.
      </p>

      {error ? <div className="notice error">{error}</div> : null}

      {/* Downloads under way */}
      {tasks.length ? (
        <div className="panel">
          <h2>In progress</h2>
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
                    <div className="hint">
                      {task.phase === 'preparing' ? 'Preparing on the server' : 'Downloading'} ·{' '}
                      {Math.round(task.progress * 100)}%
                    </div>
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
      ) : null}

      {/* What is stored */}
      {!items ? (
        error ? null : <Spinner center />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing downloaded yet"
          message="Use “Download” under any video, then “Keep on this device”."
        />
      ) : (
        <>
          <h2 className="section-title">
            {formatCount(items.length, 'video')} · {formatBytes(total)}
          </h2>
          {items.map((video) => (
            <div className="queue-item" key={video.key}>
              <Link to={`/watch/${video.videoId}`} className="queue-thumb">
                <div className="thumb">
                  <img src={urls.videoThumb(video.videoId, 320)} alt="" loading="lazy" />
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
                aria-label="Remove from this device"
                title="Remove from this device"
              >
                <IconClose />
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
