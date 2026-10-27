import { Link, useNavigate } from 'react-router-dom';
import { useQueue } from '../lib/queue-context';
import { useApp } from '../lib/app-context';
import { EmptyState, Select } from '../components/Common';
import { Thumb } from '../components/VideoCard';
import { formatCount, formatRelative } from '../lib/format';
import { LibrarySwitch } from '../components/LibrarySwitch';
import { IconChevronDown, IconChevronUp, IconClose, IconPlay } from '../components/Icons';

const QUEUE_QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto (adapt to connection speed)' },
  { value: 'original', label: 'Original' },
  { value: '2160p', label: '2160p' },
  { value: '1440p', label: '1440p' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
  { value: 'audio', label: 'Audio only' },
];

export function Queue() {
  const { items, playOrder, remove, clear, move, queueMode, setQueueMode } = useQueue();
  const { settings, saveSettings } = useApp();
  const navigate = useNavigate();

  const quality = settings?.playback.queueQuality ?? 'auto';

  // Turning it on drops you straight where the videos are, so it is one tap
  // rather than two; turning it off leaves you where you are.
  const toggleAdding = () => {
    if (queueMode) {
      setQueueMode(false);
    } else {
      setQueueMode(true);
      navigate('/');
    }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <LibrarySwitch current="queue" />
      <h1 className="page-title">Play queue</h1>

      <div className="toolbar">
        <button
          className="btn primary"
          disabled={items.length === 0}
          onClick={() => navigate(`/watch/${(playOrder[0] ?? items[0]).id}?queue=1`)}
        >
          <IconPlay />
          Play all
        </button>

        <button className={queueMode ? 'chip active' : 'chip'} onClick={toggleAdding}>
          {queueMode ? 'Done adding' : 'Add videos'}
        </button>

        <button className="chip" disabled={items.length === 0} onClick={() => void clear()}>
          Clear queue
        </button>

        <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
          {formatCount(items.length, 'video')}
        </span>
      </div>

      <div className="panel">
        <h2>Quality for the queue</h2>
        <p className="panel-sub">
          Applied to every video played from the queue. If a video cannot offer exactly this
          quality, the nearest one it does have is used instead.
        </p>
        <Select
          value={quality}
          options={QUEUE_QUALITY_OPTIONS}
          ariaLabel="Queue quality"
          style={{ height: 38, width: 280, maxWidth: '100%' }}
          onChange={(value) => void saveSettings({ playback: { queueQuality: value } })}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="The queue is empty"
          message="Turn on “Add videos”, then tap any video to line it up here."
          action={
            <button className="btn primary" onClick={toggleAdding}>
              Add videos
            </button>
          }
        />
      ) : (
        <div>
          {items.map((video, index) => (
            <div className="queue-item" key={video.id}>
              <div className="order">
                <button onClick={() => void move(video.id, -1)} aria-label="Move up" disabled={index === 0}>
                  <IconChevronUp />
                </button>
                <button
                  onClick={() => void move(video.id, 1)}
                  aria-label="Move down"
                  disabled={index === items.length - 1}
                >
                  <IconChevronDown />
                </button>
              </div>

              <span className="queue-index">{index + 1}</span>

              <Link to={`/watch/${video.id}?queue=1`} className="queue-thumb">
                <Thumb video={video} width={320} />
              </Link>

              <div className="card-text">
                <Link to={`/watch/${video.id}?queue=1`}>
                  <h3 className="card-title">{video.title}</h3>
                </Link>
                <div className="card-meta">
                  <div>{video.channelTitle}</div>
                  <div>{formatRelative(video.aired)}</div>
                </div>
              </div>

              <button
                className="icon-btn"
                onClick={() => void remove(video.id)}
                aria-label="Remove from queue"
                title="Remove from queue"
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
