import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueue } from '../lib/queue-context';
import { Thumb } from './VideoCard';
import { IconClose, IconMore, IconPlay, IconRepeat, IconShuffle } from './Icons';

/**
 * The YouTube-style queue box on the watch page: the queue in play order, the
 * current video marked, with loop and shuffle. Opened from the "In queue" pill.
 */
export function QueuePanel({ currentId, onClose }: { currentId: string; onClose: () => void }) {
  const { playOrder, shuffle, loop, toggleShuffle, toggleLoop, clear } = useQueue();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const index = playOrder.findIndex((item) => item.id === currentId);

  // Keep the playing video in view inside the list, without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('.qp-item.current');
    if (list && row) list.scrollTop = Math.max(0, row.offsetTop - 8);
  }, [currentId, playOrder.length]);

  return (
    <section className="queue-panel" aria-label="Queue">
      <div className="qp-head">
        <div style={{ minWidth: 0 }}>
          <h2>Queue</h2>
          <div className="qp-sub">
            {index >= 0 ? `${index + 1} / ${playOrder.length}` : `${playOrder.length} videos`}
            {shuffle ? ' · shuffled' : ''}
            {loop ? ' · looping' : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close queue" title="Close">
          <IconClose />
        </button>
      </div>

      <div className="qp-controls">
        <button
          className={loop ? 'icon-btn active' : 'icon-btn'}
          onClick={toggleLoop}
          aria-pressed={loop}
          title={loop ? 'Loop is on' : 'Loop the queue'}
        >
          <IconRepeat />
        </button>
        <button
          className={shuffle ? 'icon-btn active' : 'icon-btn'}
          onClick={() => toggleShuffle(currentId)}
          aria-pressed={shuffle}
          title={shuffle ? 'Shuffle is on' : 'Shuffle the queue'}
        >
          <IconShuffle />
        </button>

        <span style={{ flex: 1 }} />

        <div className="qp-menu-wrap">
          <button
            className="icon-btn"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="More"
            aria-expanded={menuOpen}
          >
            <IconMore />
          </button>
          {menuOpen ? (
            <div className="qp-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button onClick={() => navigate('/queue')}>Open queue page</button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  void clear();
                }}
              >
                Clear queue
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="qp-list" ref={listRef}>
        {playOrder.map((video, position) => {
          const current = video.id === currentId;
          return (
            <Link
              key={video.id}
              to={`/watch/${video.id}?queue=1`}
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
