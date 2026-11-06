/*
 * DownloadDialog.tsx — the pop-up behind the watch page's Download button.
 *
 * Pick a quality (Original, a converted quality such as 720p, or audio only,
 * each with a rough size), then either:
 *   - "Save to browser cache": saved inside the browser, and from then on
 *     the video plays from the cache whenever it is opened here
 *   - "Save to device": a normal download to the device's Downloads folder
 * Anything but Original is converted by the server first, shown as
 * "Preparing…". Downloads carry on if the dialog is closed. For a video
 * already in the browser cache it shows that, with a button to remove it.
 * The work itself is done by lib/offline.ts.
 */

import { useState } from 'react';
import type { WatchPayload } from '../lib/api';
import { formatBytes } from '../lib/format';
import {
  cancelDownload,
  removeOffline,
  startDownload,
  taskLabel,
  useDownloadTask,
  type OfflineVideo,
} from '../lib/offline';
import { Dialog, Select } from './Common';
import { IconCheck, IconDownload, IconTrash } from './Icons';

/** Kilobits per second of audio assumed when estimating a converted copy's size. */
const AUDIO_KBPS_ESTIMATE = 160;

interface Choice {
  value: string;
  label: string;
  /** Rough size in bytes, if it can be worked out. */
  bytes: number | null;
}

/** The qualities this user can download, with rough sizes. */
function choicesFor(data: WatchPayload): Choice[] {
  const { video, playback } = data;
  const seconds = video.duration ?? 0;
  const estimate = (kbps: number) => (seconds ? (kbps * 1000 * seconds) / 8 : null);
  const out: Choice[] = [];
  if (playback.original.available) out.push({ value: 'original', label: 'Original', bytes: video.size });
  for (const rendition of playback.renditions) {
    out.push({ value: rendition.id, label: rendition.label, bytes: estimate(rendition.bitrate + AUDIO_KBPS_ESTIMATE) });
  }
  if (playback.audioOnly?.available) {
    out.push({ value: 'audio', label: 'Audio only', bytes: estimate(AUDIO_KBPS_ESTIMATE) });
  }
  return out;
}

export function DownloadDialog({
  data,
  userId,
  saved,
  onClose,
}: {
  data: WatchPayload;
  userId: number;
  /** The copy already in the browser cache, if there is one. */
  saved: OfflineVideo | null;
  onClose: () => void;
}) {
  const choices = choicesFor(data);
  const [quality, setQuality] = useState(choices[0]?.value ?? 'original');
  const task = useDownloadTask(data.video.id);
  const chosen = choices.find((choice) => choice.value === quality);

  /** Starts a download of the chosen quality in the chosen way. */
  const begin = (mode: 'device' | 'file') => {
    if (!chosen) return;
    startDownload({
      userId,
      videoId: data.video.id,
      title: data.video.title,
      channelTitle: data.video.channelTitle,
      channelId: data.video.channelId,
      aired: data.video.aired,
      quality: chosen.value,
      qualityLabel: chosen.label,
      mode,
    });
  };

  const busy = task !== null && task.phase !== 'failed';

  return (
    <Dialog title="Download" onClose={onClose} width={440}>
      {/* Already in the browser cache */}
      {saved ? (
        <div className="download-saved">
          <IconCheck />
          <div className="grow">
            <div className="label">In the browser cache</div>
            <div className="hint">
              {saved.qualityLabel} · {formatBytes(saved.size)}. Plays from the cache whenever you open it.
            </div>
          </div>
          <button className="btn" onClick={() => void removeOffline(userId, data.video.id)}>
            <IconTrash />
            Remove
          </button>
        </div>
      ) : null}

      {/* Progress of a download under way, or why it failed */}
      {task ? (
        <div className={task.phase === 'failed' ? 'notice error download-task' : 'download-task'}>
          {task.phase === 'failed' ? (
            <span>{task.error}</span>
          ) : (
            <>
              <div className="download-task-text">{taskLabel(task)}</div>
              <div className="download-bar">
                <span style={{ width: `${Math.round(task.progress * 100)}%` }} />
              </div>
            </>
          )}
          <button className="btn" onClick={() => cancelDownload(data.video.id)}>
            {task.phase === 'failed' ? 'Dismiss' : 'Cancel'}
          </button>
        </div>
      ) : null}

      {/* Quality and the two ways to download */}
      {choices.length === 0 ? (
        <p className="muted">This video cannot be downloaded.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="download-quality">Quality</label>
            <Select
              value={quality}
              onChange={setQuality}
              ariaLabel="Download quality"
              style={{ width: '100%', height: 40 }}
              wrapStyle={{ display: 'block' }}
              options={choices.map((choice) => ({
                value: choice.value,
                label: choice.bytes ? `${choice.label} · ${choice.value === 'original' ? '' : 'about '}${formatBytes(choice.bytes)}` : choice.label,
              }))}
            />
            {quality !== 'original' ? (
              <div className="hint">The server converts the whole video first, which can take a few minutes.</div>
            ) : null}
          </div>

          <div className="download-actions">
            <button className="btn primary" disabled={busy} onClick={() => begin('device')}>
              <IconDownload />
              Save to browser cache
            </button>
            <button className="btn" disabled={busy} onClick={() => begin('file')}>
              Save to device
            </button>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Saving to the browser cache is seamless and PinchTube will automatically play videos from the cache,
            however you still need an internet connection to load the PinchTube site itself and then open the
            video. Saving to device will fully download the video for use in other apps and is entirely offline,
            but PinchTube cannot see it or play it.
          </p>
        </>
      )}
    </Dialog>
  );
}
