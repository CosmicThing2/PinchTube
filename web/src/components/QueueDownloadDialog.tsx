/*
 * QueueDownloadDialog.tsx — the pop-up behind the Queue page's "Download all".
 *
 * Saves every video in the queue to the browser cache, at one chosen quality
 * (the queue's own, or Original if that is Auto). It says how many videos that
 * is and roughly how much space they take, using a plan from the server
 * (POST /api/downloads/plan), which also picks the nearest quality for any
 * video that cannot offer the chosen one. Videos already saved or on their way
 * are left out.
 *
 * Confirming lines them up in lib/offline.ts, which works through them one at
 * a time in the background; the Downloads page shows how it is going.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, type DownloadPlanItem, type VideoDto } from '../lib/api';
import { formatBytes, formatCount } from '../lib/format';
import { listOffline, startDownload, useDownloadTasks } from '../lib/offline';
import { Dialog, Select } from './Common';
import { IconDownload } from './Icons';

const QUALITY_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: '2160p', label: '2160p' },
  { value: '1440p', label: '1440p' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
  { value: 'audio', label: 'Audio only' },
];

export function QueueDownloadDialog({
  videos,
  userId,
  defaultQuality,
  onClose,
}: {
  videos: VideoDto[];
  userId: number;
  /** The queue's quality; Auto is not a fixed quality, so it starts on Original. */
  defaultQuality: string;
  onClose: () => void;
}) {
  const [quality, setQuality] = useState(
    QUALITY_OPTIONS.some((option) => option.value === defaultQuality) ? defaultQuality : 'original',
  );
  const [savedIds, setSavedIds] = useState<Set<string> | null>(null);
  const [plan, setPlan] = useState<DownloadPlanItem[] | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Downloads already under way when this opened; they are left to finish.
  const tasks = useDownloadTasks();
  const [underWay] = useState(
    () => new Set(tasks.filter((task) => task.phase !== 'failed').map((task) => task.videoId)),
  );

  // What is already saved in this browser, and how much room is left (only
  // browsers on HTTPS will say).
  useEffect(() => {
    listOffline(userId)
      .then((saved) => setSavedIds(new Set(saved.map((video) => video.videoId))))
      .catch(() => setSavedIds(new Set()));
    navigator.storage
      ?.estimate?.()
      .then(({ quota, usage }) => {
        if (quota !== undefined) setFree(quota - (usage ?? 0));
      })
      .catch(() => {});
  }, [userId]);

  const wanted = useMemo(
    () => (savedIds ? videos.filter((video) => !savedIds.has(video.id) && !underWay.has(video.id)) : null),
    [videos, savedIds, underWay],
  );

  // A new plan for each quality, as both the sizes and the fallbacks change.
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    api
      .post<{ items: DownloadPlanItem[] }>('/api/downloads/plan', { ids: wanted.map((video) => video.id), quality })
      .then((result) => {
        if (!cancelled) setPlan(result.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not work out the download');
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, quality]);

  const total = plan?.reduce((sum, item) => sum + (item.bytes ?? 0), 0) ?? 0;
  const exact = plan?.every((item) => item.quality === 'original' && item.bytes !== null) ?? false;
  const skipped = wanted ? videos.length - wanted.length : 0;

  /** Lines everything up, then gets out of the way. */
  const begin = () => {
    if (!plan) return;
    const byId = new Map(videos.map((video) => [video.id, video]));
    for (const item of plan) {
      const video = byId.get(item.id);
      if (!video) continue;
      startDownload(
        {
          userId,
          videoId: video.id,
          title: video.title,
          channelTitle: video.channelTitle,
          channelId: video.channelId,
          aired: video.aired,
          quality: item.quality,
          qualityLabel: item.label,
          mode: 'device',
          release: true,
        },
        { atBack: true },
      );
    }
    onClose();
  };

  return (
    <Dialog title="Download all videos to browser cache" onClose={onClose} width={480}>
      {error ? <div className="notice error">{error}</div> : null}

      <div className="field">
        <label htmlFor="queue-download-quality">Quality</label>
        <Select
          value={quality}
          onChange={setQuality}
          ariaLabel="Download quality"
          style={{ width: '100%', height: 40 }}
          wrapStyle={{ display: 'block' }}
          options={QUALITY_OPTIONS}
        />
        <div className="hint">
          {quality === 'original'
            ? 'The files as they are, with no converting.'
            : 'If a video cannot offer this quality, the nearest one is used. The server converts each video first, which can take a while.'}
        </div>
      </div>

      {/* How many, and how big */}
      {!plan ? (
        error ? null : (
          <p className="muted">Working out the size…</p>
        )
      ) : plan.length === 0 ? (
        <p>Everything in the queue is already in the browser cache.</p>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            Download <strong>{formatCount(plan.length, 'video')}</strong>
            {total ? (
              <>
                , {exact ? '' : 'about '}
                <strong>{formatBytes(total)}</strong>
              </>
            ) : null}
            ?
          </p>
          {free !== null && total > free ? (
            <div className="notice error">
              This browser reports only {formatBytes(free)} free, so some of these may not fit.
            </div>
          ) : null}
          <p className="hint">
            {skipped ? `${formatCount(skipped, 'video')} already saved or downloading will be skipped. ` : ''}
            They download one at a time while you carry on using PinchTube, and play from the cache afterwards. Keep
            PinchTube open until they finish; if you close it, press Download all again to pick up the rest. While each
            one saves, the browser briefly needs room for it twice.
          </p>
        </>
      )}

      <div className="download-actions" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!plan || plan.length === 0} onClick={begin}>
          <IconDownload />
          Download
        </button>
      </div>
    </Dialog>
  );
}
