/*
 * VideoCard.tsx — how a single video is shown in lists.
 *
 *   Thumb          the thumbnail with its duration, "Watched" badge and
 *                  progress bar; also used by the queue and playlist lists
 *   VideoCard      a thumbnail, title, channel and date, as on the home page
 *                  rows (VideoRail.tsx) and grids (VideoBrowser.tsx)
 *   VideoListItem  a smaller side-by-side version for the watch page's "Up next"
 * In "queue mode" (lib/queue-context.tsx) tapping a card adds the video to
 * the queue instead of opening it.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { VideoDto } from '../lib/api';
import { urls } from '../lib/api';
import { formatDuration, formatRelative } from '../lib/format';
import { IconCheck, IconFilm } from './Icons';
import { useQueue } from '../lib/queue-context';
import { useApp } from '../lib/app-context';

interface Props {
  video: VideoDto;
  showChannel?: boolean;
  showAvatar?: boolean;
  compact?: boolean;
  thumbWidth?: number;
}

/** A video's thumbnail, faded if watched (when that setting is on), with its badges. */
export function Thumb({ video, width = 480 }: { video: VideoDto; width?: number }) {
  const [failed, setFailed] = useState(false);
  const { settings } = useApp();
  const dimmed = video.progress.watched && settings?.appearance.dimWatched !== false;
  const percent =
    video.duration && video.progress.position > 0
      ? Math.min(100, (video.progress.position / video.duration) * 100)
      : 0;

  return (
    <div className={dimmed ? 'thumb watched-dim' : 'thumb'}>
      {video.hasThumb && !failed ? (
        <img
          src={urls.videoThumb(video.id, width)}
          alt=""
          loading="lazy"
          decoding="async"
          width={width}
          height={Math.round((width * 9) / 16)}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="thumb-fallback">
          <IconFilm />
        </div>
      )}

      {video.duration ? <span className="badge-duration">{formatDuration(video.duration)}</span> : null}

      {video.progress.watched ? (
        <span className="badge-watched">
          <IconCheck />
          Watched
        </span>
      ) : null}

      {percent > 0 && !video.progress.watched ? (
        <div className="progress-bar">
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** A video tile linking to its watch page. */
export function VideoCard({ video, showChannel = true, showAvatar = true, thumbWidth = 480 }: Props) {
  const { queueMode, add, contains } = useQueue();
  const queued = contains(video.id);

  return (
    <Link
      className={queueMode ? 'card queueing' : 'card'}
      to={`/watch/${video.id}`}
      title={video.title}
      onClick={(event) => {
        // While adding to the queue, a tap collects the video rather than
        // opening it.
        if (!queueMode) return;
        event.preventDefault();
        if (!queued) void add(video.id);
      }}
    >
      {queueMode ? (
        <span className={queued ? 'queue-flag added' : 'queue-flag'}>
          {queued ? 'In queue' : 'Add'}
        </span>
      ) : null}
      <Thumb video={video} width={thumbWidth} />
      <div className="card-body">
        {showAvatar && showChannel ? (
          <img
            className="card-avatar"
            src={urls.channelArt(video.channelId, 'poster', 160)}
            alt=""
            loading="lazy"
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
        ) : null}
        <div className="card-text">
          <h3 className="card-title">{video.title}</h3>
          <div className="card-meta">
            {showChannel ? <div>{video.channelTitle}</div> : null}
            <div>{formatRelative(video.aired)}</div>
          </div>
        </div>
      </div>
    </Link>
  );
}

/** A compact row version of the card, for "Up next". */
export function VideoListItem({ video, showChannel = true }: Props) {
  const { queueMode, add, contains } = useQueue();
  const queued = contains(video.id);

  return (
    <Link
      className={queueMode ? 'upnext-item queueing' : 'upnext-item'}
      to={`/watch/${video.id}`}
      title={video.title}
      onClick={(event) => {
        if (!queueMode) return;
        event.preventDefault();
        if (!queued) void add(video.id);
      }}
    >
      <Thumb video={video} width={320} />
      <div className="card-text">
        <h3 className="card-title">{video.title}</h3>
        <div className="card-meta">
          {showChannel ? <div>{video.channelTitle}</div> : null}
          <div>{formatRelative(video.aired)}</div>
        </div>
      </div>
    </Link>
  );
}
