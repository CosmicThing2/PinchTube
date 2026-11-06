/*
 * Watch.tsx — the watch page (/watch/:id), where a video plays.
 *
 * Fetches everything about the video in one call (GET /api/videos/:id) and
 * lays out:
 *   - the player itself (player/Player.tsx)
 *   - title, channel, and buttons: mark watched, queue, save to playlist,
 *     download (components/DownloadDialog.tsx), open on YouTube
 *   - the description with clickable links and timestamps (lib/linkify.tsx),
 *     and the chapter list, which follows playback
 *   - a side column with the queue or playlist box and "More from" the channel
 * It also decides what plays next. The address says how the video was
 * opened: ?queue=1 plays through the queue (lib/queue-context.tsx, applying
 * the "when moving on" setting), ?list=<id> through a playlist
 * (lib/playlist-playback.ts), and otherwise autoplay moves on to the channel's
 * next video if that setting is on. Progress is saved as it plays. A video
 * saved to the browser cache (lib/offline.ts) plays from there instead of
 * streaming.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, urls, type WatchPayload } from '../lib/api';
import { Player, type PlayerHandle } from '../player/Player';
import { QueuePanel } from '../components/QueuePanel';
import { PlaylistPanel } from '../components/PlaylistPanel';
import { SaveToPlaylist } from '../components/SaveToPlaylist';
import { DownloadDialog } from '../components/DownloadDialog';
import {
  getOffline,
  offlineSource,
  useDownloadTask,
  useOfflineVersion,
  type OfflineVideo,
} from '../lib/offline';
import { usePlaylistPlayback } from '../lib/playlist-playback';

/** How long to wait for browser storage to say whether a video is cached before streaming it. */
const OFFLINE_CHECK_MS = 3000;
import { EmptyState, Spinner } from '../components/Common';
import { useApp } from '../lib/app-context';
import { useQueue } from '../lib/queue-context';
import { linkify } from '../lib/linkify';
import { chapterOwning, uniqueChapters } from '../lib/chapters';
import { VideoListItem } from '../components/VideoCard';
import { formatBytes, formatDate, formatDuration, shortSide } from '../lib/format';
import {
  IconCheck,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconPlaylistAdd,
  IconQueue,
  IconYouTube,
} from '../components/Icons';

export function Watch() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<WatchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [watched, setWatched] = useState(false);
  // Held in app state so the shell can collapse its nav to match.
  const { theater, toggleTheater, settings, dataSaver, user } = useApp();
  const playerRef = useRef<PlayerHandle>(null);
  /** Coarse playback position, so the chapter list can follow along. */
  const [currentTime, setCurrentTime] = useState(0);
  // How the video was opened: from the queue, from a playlist, or on its own.
  const [params] = useSearchParams();
  const playingQueue = params.get('queue') === '1';
  const listParam = params.get('list');
  const listId = !playingQueue && listParam && /^\d+$/.test(listParam) ? Number(listParam) : null;
  const list = usePlaylistPlayback(listId);
  const playingList = listId !== null && list.playlist !== null;
  const [listPanelOpen, setListPanelOpen] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

  // A copy in the browser cache (lib/offline.ts): its details for the Download
  // button, and a playable address so the player can use it instead of
  // streaming. `device` stays undefined until the check is done, and the
  // player waits for it, so it does not start streaming first.
  const offlineVersion = useOfflineVersion();
  const downloadTask = useDownloadTask(id);
  const [saved, setSaved] = useState<OfflineVideo | null>(null);
  const [device, setDevice] = useState<{ url: string; label: string } | null | undefined>(undefined);
  /** The address handed to the player, kept until the stored copy itself changes. */
  const deviceRef = useRef<{ key: string; savedAt: number; url: string } | null>(null);
  const checkedKey = useRef<string | null>(null);
  const userId = user?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    const key = `${userId}:${id}`;
    const forget = () => {
      if (deviceRef.current) URL.revokeObjectURL(deviceRef.current.url);
      deviceRef.current = null;
    };
    // A different video: start from "not checked yet" so the player waits.
    if (checkedKey.current !== key) {
      checkedKey.current = key;
      forget();
      setSaved(null);
      setDevice(undefined);
    }
    void (async () => {
      // Never hold the player back for long over browser storage: if it does
      // not answer quickly, stream instead.
      const meta =
        userId === null
          ? null
          : await Promise.race([
              getOffline(userId, id),
              new Promise<null>((resolve) => window.setTimeout(() => resolve(null), OFFLINE_CHECK_MS)),
            ]).catch(() => null);
      if (cancelled) return;
      // Something else was stored or removed, but not this video's copy: keep
      // the address the player already has.
      const current = deviceRef.current;
      if (meta && current && current.savedAt === meta.savedAt) {
        setSaved(meta);
        return;
      }
      const source = meta && userId !== null ? await offlineSource(userId, id).catch(() => null) : null;
      if (cancelled) {
        if (source) URL.revokeObjectURL(source.url);
        return;
      }
      forget();
      if (meta && source) deviceRef.current = { key, savedAt: meta.savedAt, url: source.url };
      setSaved(meta);
      setDevice(source);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, userId, offlineVersion]);

  // Let go of the stored copy's address when leaving the page.
  useEffect(
    () => () => {
      if (deviceRef.current) URL.revokeObjectURL(deviceRef.current.url);
    },
    [],
  );
  const {
    playOrder,
    loop: queueLoop,
    add: addToQueue,
    remove: removeFromQueue,
    contains,
  } = useQueue();
  // Remembered, so the box stays open as the queue moves from video to video.
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem('ytm-queue-panel') === '1';
    } catch {
      return false;
    }
  });
  const setPanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem('ytm-queue-panel', open ? '1' : '0');
    } catch {
      /* private browsing */
    }
  };

  // Load the video (and its playback details) whenever the address changes.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setExpanded(false);
    window.scrollTo({ top: 0 });

    api
      .get<WatchPayload>(`/api/videos/${id}`)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setWatched(payload.video.progress.watched);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load this video');
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  /** The player reports the position every few seconds; it is saved on the server. */
  const onProgress = useCallback(
    (position: number, duration: number) => {
      void api.postKeepalive(`/api/videos/${id}/progress`, { position, duration }).catch(() => {});
    },
    [id],
  );

  // ---- what plays before and after this video ----

  /** The channel's next video, for autoplay when not in a queue or playlist. */
  const next = useMemo(() => data?.upNext?.[0] ?? null, [data]);

  // Position within the playlist, in play order (shuffled or not).
  const listIndex = playingList ? list.playOrder.findIndex((item) => item.id === id) : -1;
  const listPrevious = !playingList
    ? null
    : listIndex > 0
      ? list.playOrder[listIndex - 1]
      : list.loop && list.playOrder.length > 1
        ? list.playOrder[list.playOrder.length - 1]
        : null;
  const listNext = !playingList
    ? null
    : ((listIndex >= 0 ? list.playOrder[listIndex + 1] : list.playOrder[0]) ??
      (list.loop && list.playOrder.length > 0 ? list.playOrder[0] : null));

  /**
   * Moves on to the next queued video, first deciding whether the one being
   * left counts as done — marked watched and dropped from the queue — under
   * the user's rule. A video that played to its end is always marked watched,
   * and leaves the queue unless the rule is "never".
   */
  const advanceQueue = useCallback(
    (reason: 'next' | 'ended') => {
      // Work out where to go before anything is dropped off the queue.
      const index = playOrder.findIndex((item) => item.id === id);
      let following = index >= 0 ? playOrder[index + 1] : playOrder[0];
      if (!following && queueLoop) following = playOrder[0];

      const rule = settings?.playback.queueAdvance ?? 'always';
      let done: boolean;
      if (reason === 'ended') {
        done = rule !== 'never';
      } else {
        const { position, duration } = playerRef.current?.getPosition() ?? { position: 0, duration: 0 };
        const fraction = duration > 0 ? position / duration : 0;
        switch (rule) {
          case 'always':
            done = true;
            break;
          case 'threshold':
            done = fraction >= (settings?.playback.watchedThreshold ?? 0.9);
            break;
          case 'custom':
            done = fraction >= (settings?.playback.queueAdvancePercent ?? 80) / 100;
            break;
          case 'complete':
            // "To the end" allows for the credits' last couple of seconds.
            done = duration > 0 && duration - position <= 2;
            break;
          default:
            done = false;
        }
      }

      // Finishing a video always counts as watching it; the rule only decides
      // whether "next" counts too, and whether the video leaves the queue.
      if (done || reason === 'ended') {
        setWatched(true);
        void api.post(`/api/videos/${id}/watched`, { watched: true }).catch(() => {});
      }
      if (done && index >= 0) void removeFromQueue(id);
      if (!following) return;
      if (following.id === id) {
        // Looping a queue of one: start it again rather than "navigating" to
        // the page already open. If it was just removed, there is nothing left.
        if (!done) playerRef.current?.seekTo(0);
        return;
      }
      navigate(`/watch/${following.id}?queue=1`);
    },
    [id, navigate, playOrder, queueLoop, removeFromQueue, settings],
  );

  /** When the video finishes: mark it watched, then move on as the queue, playlist or autoplay says. */
  const onEnded = useCallback(() => {
    if (!data) return;

    if (playingQueue) {
      advanceQueue('ended');
      return;
    }

    setWatched(true);
    void api.post(`/api/videos/${id}/watched`, { watched: true }).catch(() => {});

    // A playlist always plays on to its next video, the way YouTube's do.
    if (playingList) {
      if (!listNext) return;
      if (listNext.id === id) playerRef.current?.seekTo(0);
      else navigate(`/watch/${listNext.id}?list=${listId}`);
      return;
    }

    if (data.playback.autoplayNext && next) navigate(`/watch/${next.id}`);
  }, [advanceQueue, data, id, listId, listNext, navigate, next, playingList, playingQueue]);

  // Position within the queue, for the player's previous / next buttons.
  const queueIndex = playingQueue ? playOrder.findIndex((item) => item.id === id) : -1;
  const previousVideo = !playingQueue
    ? null
    : queueIndex > 0
      ? playOrder[queueIndex - 1]
      : queueLoop && playOrder.length > 1
        ? playOrder[playOrder.length - 1]
        : null;
  const nextVideo = !playingQueue
    ? next
    : ((queueIndex >= 0 ? playOrder[queueIndex + 1] : playOrder[0]) ??
      (queueLoop && playOrder.length > 0 ? playOrder[0] : null));

  // The player's previous / next track buttons.
  const goPrevious = useCallback(() => {
    if (playingList) {
      if (listPrevious) navigate(`/watch/${listPrevious.id}?list=${listId}`);
      return;
    }
    if (previousVideo) navigate(`/watch/${previousVideo.id}?queue=1`);
  }, [listId, listPrevious, navigate, playingList, previousVideo]);

  const goNext = useCallback(() => {
    if (playingQueue) {
      advanceQueue('next');
      return;
    }
    if (playingList) {
      if (listNext && listNext.id !== id) navigate(`/watch/${listNext.id}?list=${listId}`);
      else if (listNext) playerRef.current?.seekTo(0);
      return;
    }
    if (nextVideo) navigate(`/watch/${nextVideo.id}`);
  }, [advanceQueue, id, listId, listNext, navigate, nextVideo, playingList, playingQueue]);

  /** The "Mark watched / unwatched" button. */
  const toggleWatched = async () => {
    const value = !watched;
    setWatched(value);
    await api.post(`/api/videos/${id}/watched`, { watched: value }).catch(() => {});
  };

  if (error) {
    return <EmptyState title="Video unavailable" message={error} />;
  }
  if (!data) return <Spinner center />;

  const { video, playback, upNext } = data;
  const inQueue = contains(video.id);
  // Playing from the queue keeps the box available even once this video has
  // been taken off it.
  const showPanel = panelOpen && (inQueue || playingQueue) && playOrder.length > 0;
  const resumeAt =
    video.progress.position > (playback.resumeThresholdSeconds ?? 15) && !video.progress.watched
      ? video.progress.position
      : 0;

  // The technical line in the description box: quality, codec, size, length.
  const details = [
    shortSide(video.width, video.height) ? `${shortSide(video.width, video.height)}p source` : null,
    video.vcodec ? video.vcodec.toUpperCase() : null,
    video.size ? formatBytes(video.size) : null,
    video.duration ? formatDuration(video.duration) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // The player, playing at the queue's or playlist's quality when there is one.
  const player = (
    <Player
      ref={playerRef}
      key={video.id}
      video={video}
      playback={playback}
      startAt={resumeAt}
      onProgress={onProgress}
      onEnded={onEnded}
      theater={theater}
      onToggleTheater={toggleTheater}
      trackButtons={playingQueue || playingList}
      forcedQuality={
        playingQueue
          ? (settings?.playback.queueQuality ?? 'auto')
          : playingList && list.playlist && list.playlist.quality !== 'auto'
            ? list.playlist.quality
            : undefined
      }
      dataSaver={dataSaver}
      onPrevious={(playingList ? listPrevious : previousVideo) ? goPrevious : undefined}
      onNext={(playingList ? listNext : nextVideo) ? goNext : undefined}
      onTime={video.chapters.length ? setCurrentTime : undefined}
      offline={device ?? null}
    />
  );

  // Listed once each, with one highlighted even where chapters overlap — the
  // same one the progress bar shows.
  const chapterList = uniqueChapters(video.chapters);
  const activeChapter = chapterOwning(chapterList, currentTime);

  // youtube.com bounces phones to m.youtube.com anyway, but linking there
  // directly skips the redirect on a touch device.
  const youtubeUrl = video.youtubeId
    ? `https://${window.matchMedia('(pointer: coarse)').matches ? 'm' : 'www'}.youtube.com/watch?v=${video.youtubeId}`
    : null;

  return (
    <div className={theater ? 'watch theater' : 'watch'}>
      <div className="watch-main">
        {/* This wrapper always exists: swapping it in and out would remount the
            player and restart the video. */}
        <div className={theater ? 'theater-stage' : undefined}>
          {device === undefined ? (
            <div className="player" aria-hidden="true" style={{ display: 'grid', placeItems: 'center' }}>
              <Spinner />
            </div>
          ) : (
            player
          )}
        </div>

        <h1 className="watch-title">{video.title}</h1>

        {/* Channel, then the action buttons */}
        <div className="watch-meta">
          {(() => {
            const inner = (
              <>
                <img
                  src={urls.channelArt(video.channelId, 'poster', 160)}
                  alt=""
                  onError={(event) => {
                    (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
                <div>
                  <div className="name">{video.channelTitle}</div>
                  <div className="count">{formatDate(video.aired)}</div>
                </div>
              </>
            );
            // A playlist can let someone play a video from a channel they
            // have no access to; there is no channel page to send them to.
            return data.channelAccessible === false ? (
              <div className="watch-channel">{inner}</div>
            ) : (
              <Link className="watch-channel" to={`/channel/${video.channelId}`}>
                {inner}
              </Link>
            );
          })()}

          <div className="watch-actions">
            <button className="btn" onClick={() => void toggleWatched()}>
              {watched ? <IconEyeOff /> : <IconEye />}
              {watched ? 'Mark unwatched' : 'Mark watched'}
            </button>

            {inQueue ? (
              <button
                className={panelOpen ? 'btn btn-on' : 'btn'}
                onClick={() => setPanel(!panelOpen)}
                aria-expanded={panelOpen}
                title={panelOpen ? 'Hide the queue' : 'Show the queue'}
              >
                <IconQueue />
                In queue
              </button>
            ) : (
              <button className="btn" onClick={() => void addToQueue(video.id)}>
                <IconQueue />
                Add to queue
              </button>
            )}

            <button className="btn" onClick={() => setSaveOpen(true)}>
              <IconPlaylistAdd />
              Save
            </button>

            <button
              className={saved ? 'btn btn-on' : 'btn'}
              onClick={() => setDownloadOpen(true)}
              title={saved ? 'Saved to the browser cache' : 'Download'}
            >
              {saved ? <IconCheck /> : <IconDownload />}
              {downloadTask && downloadTask.phase !== 'failed'
                ? downloadTask.phase === 'saving'
                  ? 'Saving…'
                  : downloadTask.phase === 'waiting'
                    ? 'Waiting…'
                    : `${downloadTask.phase === 'preparing' ? 'Preparing' : 'Downloading'} ${Math.round(downloadTask.progress * 100)}%`
                : saved
                  ? 'Downloaded'
                  : 'Download'}
            </button>

            {youtubeUrl ? (
              <a
                className="btn"
                href={youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open on YouTube"
              >
                <IconYouTube />
                YouTube
              </a>
            ) : null}
            {watched ? (
              <span className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconCheck style={{ width: 13, height: 13, fill: 'currentColor' }} />
                Watched
              </span>
            ) : null}
          </div>
        </div>

        {/* Description box: technical details, file path (admins), description */}
        <div className={expanded ? 'watch-desc' : 'watch-desc collapsed'}>
          <div className="stats">{details}</div>
          {/* Only administrators are sent the path at all. */}
          {video.path ? (
            <div className="filepath" title={video.path}>
              {video.path}
            </div>
          ) : null}
          <div className="text">
            {video.plot
              ? linkify(video.plot, {
                  duration: video.duration,
                  onSeek: (seconds) => playerRef.current?.seekTo(seconds),
                })
              : 'No description.'}
          </div>
          {(video.plot?.length ?? 0) > 160 ? (
            <button onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>

        {/* Chapter list; clicking one jumps there */}
        {chapterList.length ? (
          <div className="chapters">
            <h2>Chapters</h2>
            {chapterList.map((chapter, index) => {
              const active = chapter === activeChapter;
              return (
                <button
                  key={index}
                  type="button"
                  className={`chapter-row${active ? ' active' : ''}${chapter.kind === 'sponsor' ? ' sponsor' : ''}`}
                  onClick={() => playerRef.current?.seekTo(chapter.start)}
                >
                  <span className="chapter-time">{formatDuration(chapter.start)}</span>
                  <span className="chapter-title">{chapter.title}</span>
                  {chapter.kind === 'sponsor' ? <span className="chapter-tag">SponsorBlock</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {saveOpen ? <SaveToPlaylist videoId={video.id} onClose={() => setSaveOpen(false)} /> : null}
      {downloadOpen && user ? (
        <DownloadDialog data={data} userId={user.id} saved={saved} onClose={() => setDownloadOpen(false)} />
      ) : null}

      {/* Side column: playlist or queue box, then more from this channel */}
      <aside className="upnext">
        {playingList && listPanelOpen ? (
          <PlaylistPanel playback={list} currentId={video.id} onClose={() => setListPanelOpen(false)} />
        ) : null}
        {showPanel && !playingList ? <QueuePanel currentId={video.id} onClose={() => setPanel(false)} /> : null}

        <h2>More from {video.channelTitle}</h2>
        {upNext.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Nothing else in this channel yet.
          </p>
        ) : (
          upNext.map((item) => <VideoListItem key={item.id} video={item} showChannel={false} />)
        )}
      </aside>
    </div>
  );
}
