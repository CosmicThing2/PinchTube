import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import Hls from 'hls.js';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';

/*
 * "Stats for nerds": what the player and the server are doing right now, for
 * working out why a video pauses to buffer. The numbers answer three
 * questions: is enough saved up ahead (buffer), is data arriving faster than
 * it plays (loading), and for converted qualities, is the time going on the
 * server encoding a segment or on the network carrying it.
 */

interface Props {
  videoRef: RefObject<HTMLVideoElement>;
  hlsRef: MutableRefObject<Hls | null>;
  videoId: string;
  /** What is playing, as the quality button shows it. */
  label: string;
  /** True when the file itself is playing rather than a converted copy. */
  direct: boolean;
  /** The converted quality being played, as the server names it, or null. */
  rendition: () => string | null;
  /** The file's average bitrate in bits per second, when known. */
  fileBitrate: number | null;
  codec: string | null;
  onClose: () => void;
}

interface Segment {
  bytes: number;
  /** From asking to the first byte: the server finding or encoding it. */
  waitMs: number;
  /** From the first byte to the last: the network. */
  transferMs: number;
}

interface EncodeStatus {
  running: boolean;
  encoder: string | null;
  speed: number | null;
}

/** How far back the loading rate is averaged over. */
const RATE_WINDOW_MS = 6000;
const SEGMENTS_KEPT = 6;
const STATUS_POLL_MS = 2000;

const ENCODER_NAMES: Record<string, string> = {
  vaapi: 'Graphics card (VA-API)',
  qsv: 'Graphics card (Quick Sync)',
  nvenc: 'Graphics card (NVENC)',
  software: 'Processor (software)',
};

export function StatsPanel({ videoRef, hlsRef, videoId, label, direct, rendition, fileBitrate, codec, onClose }: Props) {
  const [, setTick] = useState(0);
  const samples = useRef<{ at: number; end: number }[]>([]);
  const segments = useRef<Segment[]>([]);
  const stalls = useRef({ count: 0, totalMs: 0, lastMs: 0, since: 0 });
  const [status, setStatus] = useState<EncodeStatus | null>(null);

  // Redraw once a second, sampling how far ahead the buffer reaches each time.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const element = videoRef.current;
      if (element) {
        const end = bufferedEnd(element);
        const list = samples.current;
        const now = performance.now();
        // A seek starts a new stretch of buffer, so the old samples no longer compare.
        if (list.length && end < list[list.length - 1].end) list.length = 0;
        list.push({ at: now, end });
        while (list.length > 1 && now - list[0].at > RATE_WINDOW_MS) list.shift();
      }
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [videoRef]);

  // Pauses to buffer, leaving out the ones that follow a seek.
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const onWaiting = () => {
      if (!element.seeking && !stalls.current.since) stalls.current.since = performance.now();
    };
    const onPlaying = () => {
      const { since } = stalls.current;
      if (!since) return;
      const ms = performance.now() - since;
      stalls.current = { count: stalls.current.count + 1, totalMs: stalls.current.totalMs + ms, lastMs: ms, since: 0 };
    };
    const onSeeking = () => {
      stalls.current.since = 0;
    };
    element.addEventListener('waiting', onWaiting);
    element.addEventListener('playing', onPlaying);
    element.addEventListener('seeking', onSeeking);
    return () => {
      element.removeEventListener('waiting', onWaiting);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('seeking', onSeeking);
    };
  }, [videoRef]);

  // Timings of each converted segment. The player's hls.js instance is
  // replaced when the source changes, so the subscription follows it.
  useEffect(() => {
    let subscribed: Hls | null = null;
    const onLoaded = (_event: string, data: any) => {
      const stats = data?.frag?.stats ?? data?.stats;
      const loading = stats?.loading;
      if (!loading || !(loading.end > 0)) return;
      const first = loading.first > 0 ? loading.first : loading.end;
      segments.current.push({
        bytes: stats.loaded || stats.total || 0,
        waitMs: Math.max(0, first - loading.start),
        transferMs: Math.max(0, loading.end - first),
      });
      if (segments.current.length > SEGMENTS_KEPT) segments.current.shift();
    };
    const follow = () => {
      const hls = hlsRef.current;
      if (hls === subscribed) return;
      subscribed?.off(Hls.Events.FRAG_LOADED, onLoaded);
      segments.current = [];
      subscribed = hls;
      subscribed?.on(Hls.Events.FRAG_LOADED, onLoaded);
    };
    follow();
    const timer = window.setInterval(follow, 1000);
    return () => {
      window.clearInterval(timer);
      subscribed?.off(Hls.Events.FRAG_LOADED, onLoaded);
    };
  }, [hlsRef]);

  // What the server's encoder is up to, for converted qualities.
  const renditionRef = useRef(rendition);
  renditionRef.current = rendition;
  useEffect(() => {
    if (direct) {
      setStatus(null);
      return;
    }
    let busy = false;
    let cancelled = false;
    const poll = () => {
      const id = renditionRef.current();
      if (busy || !id) return;
      busy = true;
      api
        .get<EncodeStatus>(`/api/stream/${videoId}/${id}/status`)
        .then((next) => !cancelled && setStatus(next))
        .catch(() => !cancelled && setStatus(null))
        .finally(() => {
          busy = false;
        });
    };
    poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [direct, videoId]);

  const element = videoRef.current;
  const ahead = element ? Math.max(0, bufferedEnd(element) - element.currentTime) : 0;

  const list = samples.current;
  const span = list.length > 1 ? (list[list.length - 1].at - list[0].at) / 1000 : 0;
  const rate = span >= 2 ? (list[list.length - 1].end - list[0].end) / span : null;
  const rateBits = rate !== null && direct && fileBitrate ? rate * fileBitrate : null;

  const quality = element?.getVideoPlaybackQuality?.();
  const picture = element?.videoWidth ? `${element.videoWidth}×${element.videoHeight}` : '–';

  const segs = segments.current;
  const average = (pick: (s: Segment) => number) => segs.reduce((sum, s) => sum + pick(s), 0) / segs.length;
  const waitMs = segs.length ? average((s) => s.waitMs) : 0;
  const transferMs = segs.length ? average((s) => s.transferMs) : 0;
  const segBytes = segs.length ? average((s) => s.bytes) : 0;
  // Very short transfers are too quick to time; the speed is just "plenty".
  const networkBits = segs.length && transferMs >= 20 ? (segBytes * 8) / (transferMs / 1000) : null;

  const stall = stalls.current;

  return (
    <div
      className="player-stats"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button className="player-stats-close" type="button" onClick={onClose} aria-label="Close stats">
        ×
      </button>
      <dl>
        <dt>Playing</dt>
        <dd>
          {label} · {direct ? 'the file itself' : 'converted'}
        </dd>

        <dt>Picture</dt>
        <dd>
          {picture}
          {codec ? ` · ${codec.toUpperCase()}` : ''}
          {direct && fileBitrate ? ` · ${formatBits(fileBitrate)} average` : ''}
        </dd>

        <dt>Saved ahead</dt>
        <dd>{ahead.toFixed(1)} s</dd>

        <dt>Loading</dt>
        <dd>
          {rate === null ? 'measuring…' : `${rate.toFixed(1)}× playback speed`}
          {rateBits !== null && rate! > 0.05 ? ` (≈ ${formatBits(rateBits)})` : ''}
        </dd>

        <dt>Buffering stops</dt>
        <dd>
          {stall.count === 0
            ? stall.since
              ? 'waiting now…'
              : 'none since opened'
            : `${stall.count} · last ${(stall.lastMs / 1000).toFixed(1)} s · total ${(stall.totalMs / 1000).toFixed(1)} s`}
        </dd>

        <dt>Dropped frames</dt>
        <dd>
          {quality ? `${quality.droppedVideoFrames.toLocaleString()} of ${quality.totalVideoFrames.toLocaleString()}` : '–'}
        </dd>

        {!direct ? (
          <>
            <dt>Segments</dt>
            <dd>
              {segs.length
                ? `${formatBytes(segBytes)} · server ${(waitMs / 1000).toFixed(2)} s · network ${(transferMs / 1000).toFixed(2)} s`
                : 'none loaded yet'}
            </dd>

            <dt>Network</dt>
            <dd>{networkBits !== null ? formatBits(networkBits) : segs.length ? 'too quick to measure' : '–'}</dd>

            <dt>Server encoder</dt>
            <dd>
              {status === null
                ? '–'
                : status.running
                  ? `${ENCODER_NAMES[status.encoder ?? ''] ?? status.encoder}${
                      status.speed !== null ? ` · ${status.speed.toFixed(1)}× playback speed` : ''
                    }`
                  : 'idle (this part is already made)'}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** The end of the buffered stretch the playhead is in, or the playhead itself. */
function bufferedEnd(element: HTMLVideoElement): number {
  const ranges = element.buffered;
  const time = element.currentTime;
  for (let i = 0; i < ranges.length; i++) {
    if (time >= ranges.start(i) - 0.25 && time <= ranges.end(i)) return ranges.end(i);
  }
  return time;
}

function formatBits(bitsPerSecond: number): string {
  const mbit = bitsPerSecond / 1_000_000;
  return mbit >= 10 ? `${Math.round(mbit)} Mbit/s` : `${mbit.toFixed(1)} Mbit/s`;
}
