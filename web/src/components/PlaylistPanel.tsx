import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { PlaylistPlayback } from '../lib/playlist-playback';
import { Thumb } from './VideoCard';
import { IconClose, IconPlay, IconRepeat, IconShuffle } from './Icons';

/**
 * The box beside the player while a playlist plays: the list in play order,
 * the current video marked, with loop and shuffle. Mirrors the queue's box.
 */
export function PlaylistPanel({
  playback,
  currentId,
  onClose,
}: {
  playback: PlaylistPlayback;
  currentId: string;
  onClose: () => void;
}) {
  const { playlist, playOrder, shuffle, loop, toggleShuffle, toggleLoop } = playback;
  const listRef = useRef<HTMLDivElement>(null);
  const index = playOrder.findIndex((item) => item.id === currentId);

  // Keep the playing video in view inside the list, without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('.qp-item.current');
    if (list && row) list.scrollTop = Math.max(0, row.offsetTop - 8);
  }, [currentId, playOrder.length]);

  if (!playlist) return null;

  return (
    <section className="queue-panel" aria-label="Playlist">
      <div className="qp-head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <Link to={`/playlist/${playlist.id}`}>{playlist.name}</Link>
          </h2>
          <div className="qp-sub">
            {playlist.mine ? '' : `${playlist.owner} · `}
            {index >= 0 ? `${index + 1} / ${playOrder.length}` : `${playOrder.length} videos`}
            {shuffle ? ' · shuffled' : ''}
            {loop ? ' · looping' : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close playlist" title="Close">
          <IconClose />
        </button>
      </div>

      <div className="qp-controls">
        <button
          className={loop ? 'icon-btn active' : 'icon-btn'}
          onClick={toggleLoop}
          aria-pressed={loop}
          title={loop ? 'Loop is on' : 'Loop the playlist'}
        >
          <IconRepeat />
        </button>
        <button
          className={shuffle ? 'icon-btn active' : 'icon-btn'}
          onClick={() => toggleShuffle(currentId)}
          aria-pressed={shuffle}
          title={shuffle ? 'Shuffle is on' : 'Shuffle the playlist'}
        >
          <IconShuffle />
        </button>
      </div>

      <div className="qp-list" ref={listRef}>
        {playOrder.map((video, position) => {
          const current = video.id === currentId;
          return (
            <Link
              key={video.id}
              to={`/watch/${video.id}?list=${playlist.id}`}
              className={current ? 'qp-item current' : 'qp-item'}
              title={video.title}
            >
              <span className="qp-index">{current ? <IconPlay /> : position + 1}</span>
              <span className="qp-thumb">
                <Thumb video={video} width={240} />
              </span>
              <span className="qp-text">
                <span className="qp-title">{video.title}</span>
                <span className="qp-channel">{video.channelTitle}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
