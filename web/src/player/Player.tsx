import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Hls from 'hls.js';
import type { Chapter, VideoDto, WatchPayload } from '../lib/api';
import { urls } from '../lib/api';
import { formatDuration } from '../lib/format';
import { flattenChapters } from '../lib/chapters';
import {
  IconCaptions,
  IconCheck,
  IconForward,
  IconFullscreen,
  IconFullscreenExit,
  IconGearSmall,
  IconPause,
  IconPip,
  IconPlay,
  IconSkipNext,
  IconSkipPrevious,
  IconSun,
  IconTheater,
  IconVolume,
  IconVolumeMute,
} from '../components/Icons';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const CONTROL_HIDE_MS = 3000;
const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Cues sit three lines up from the bottom so they clear the control bar, which
 * is where the browser would otherwise park them.
 */
const CUE_LINE = -3;
const CUE_MIN_PX = 16;
const CUE_MAX_PX = 56;

type MenuTab = null | 'root' | 'quality' | 'speed' | 'captions';

interface Props {
  video: VideoDto;
  playback: WatchPayload['playback'];
  startAt: number;
  onProgress: (position: number, duration: number) => void;
  onEnded: () => void;
  theater?: boolean;
  onToggleTheater?: () => void;
  /** Overrides the usual default, e.g. the quality chosen for the whole queue. */
  forcedQuality?: string;
  dataSaver?: boolean;
  /** Wired to the previous/next buttons on a lock screen or in Android Auto. */
  onPrevious?: () => void;
  onNext?: () => void;
  /** Show previous/next in the control bar (when playing a queue). */
  trackButtons?: boolean;
  /** Coarse position updates (about once a second) for things outside the player. */
  onTime?: (seconds: number) => void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function chapterAt(chapters: Chapter[], seconds: number): Chapter | null {
  for (const chapter of chapters) {
    if (seconds >= chapter.start && seconds < chapter.end) return chapter;
  }
  return null;
}

export interface PlayerHandle {
  seekTo: (seconds: number) => void;
  /** The last real playback position, still valid while the player is unmounting. */
  getPosition: () => { position: number; duration: number };
}

/** Dimmest the brightness swipe goes; the top of the bar is the picture as encoded. */
const MIN_BRIGHTNESS = 0.2;
/** A swipe over this share of the player's height covers the whole range. */
const GESTURE_TRAVEL = 0.75;
/** Movement before a touch counts as a swipe rather than a tap. */
const GESTURE_SLOP_PX = 12;
/**
 * Survives moving between videos, so a picture dimmed for night viewing stays
 * dim; resets on reload so it is never stuck dark the next day.
 */
let sessionBrightness = 1;

type GestureKind = 'volume' | 'brightness';

interface TouchTrack {
  id: number;
  x: number;
  y: number;
  side: 'left' | 'right';
  mode: 'pending' | 'scroll' | GestureKind;
  startValue: number;
  height: number;
}

const MEDIA_SESSION_ACTIONS = [
  'play',
  'pause',
  'seekbackward',
  'seekforward',
  'seekto',
  'previoustrack',
  'nexttrack',
];

/**
 * Maps a wanted quality onto something this particular video can actually offer,
 * falling back to the nearest rung by height. A queue set to 1440p will play a
 * 1080p source at 1080p rather than silently dropping to Auto.
 */
function resolveQuality(wanted: string, playback: WatchPayload['playback']): string {
  if (!wanted || wanted === 'auto') return 'auto';
  if (wanted === 'original') return playback.original.available ? 'original' : 'auto';
  if (wanted === 'audio') return playback.audioOnly?.available ? 'audio' : 'auto';

  const exact = playback.renditions.find((r) => r.id === wanted);
  if (exact) return exact.id;

  const target = parseInt(wanted, 10);
  if (!Number.isFinite(target) || playback.renditions.length === 0) return 'auto';

  let best = playback.renditions[0];
  for (const rendition of playback.renditions) {
    if (Math.abs(rendition.height - target) < Math.abs(best.height - target)) best = rendition;
  }
  return best.id;
}

/**
 * Which of the two default qualities applies. A browser cannot tell us we are on
 * mobile data — Chromium never exposed connection.type to pages, and
 * effectiveType reports "4g" on any halfway decent mobile connection — so this
 * follows the explicit data saver switch rather than guessing. Data saver wins
 * over a queue's own quality, since it exists to put a ceiling on data use.
 */
function preferredFor(
  playback: WatchPayload['playback'],
  dataSaver: boolean,
  forced: string | undefined,
): string {
  const wanted = dataSaver ? playback.defaults.cellular : forced || playback.defaults.wifi;
  return resolveQuality(wanted || 'auto', playback);
}

export const Player = forwardRef<PlayerHandle, Props>(function Player(
  {
    video,
    playback,
    startAt,
    onProgress,
    onEnded,
    theater = false,
    onToggleTheater,
    forcedQuality,
    dataSaver = false,
    onPrevious,
    onNext,
    trackButtons = false,
    onTime: onTimeProp,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<number | null>(null);
  const progressTimer = useRef<number | null>(null);
  const resumeRef = useRef<number>(startAt);
  const autoplayedRef = useRef(false);
  /** An in-progress volume fade; the volume it started from is restored afterwards. */
  const fadeRef = useRef<{ interval: number; deadline: number; startVolume: number } | null>(null);
  /** The brief play/pause icon that flashes mid-picture when the big button is hidden. */
  const [flash, setFlash] = useState<{ kind: 'play' | 'pause'; id: number } | null>(null);
  const flashTimer = useRef(0);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | null }>({ time: 0, side: null });

  const preferred = useMemo(
    () => preferredFor(playback, dataSaver, forcedQuality),
    [playback, dataSaver, forcedQuality],
  );
  const [quality, setQuality] = useState<string>(preferred);
  const appliedPreferred = useRef(preferred);
  // The browser's own "exit fullscreen" notice sits along the bottom edge for a
  // few seconds; the control bar steps up out of its way until it has gone.
  const [fsNotice, setFsNotice] = useState(false);
  const [autoLevelLabel, setAutoLevelLabel] = useState<string>('');
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(video.duration ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState<number>(playback.subtitlesDefault && video.subtitles.length ? 0 : -1);
  const [menu, setMenu] = useState<MenuTab>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seekFlash, setSeekFlash] = useState<'left' | 'right' | null>(null);
  const [cueFontPx, setCueFontPx] = useState(22);
  /** What the pointer is over on the scrub bar: a time, and the chapter it falls in. */
  const [scrubHover, setScrubHover] = useState<{ x: number; time: number; title: string } | null>(null);
  const lastReportedRef = useRef(-1);
  /**
   * Last known position and duration. Leaving a video tears the source down
   * (zeroing currentTime) before the final progress save runs, so that save
   * reads from here rather than from the element.
   */
  const lastTimeRef = useRef(startAt);
  const lastDurationRef = useRef(video.duration ?? 0);
  /** The finger currently on the picture, while it might still become a swipe. */
  const touchRef = useRef<TouchTrack | null>(null);
  const [gestureHud, setGestureHud] = useState<{ kind: GestureKind; value: number } | null>(null);
  const hudTimer = useRef(0);
  const [brightness, setBrightness] = useState(sessionBrightness);
  const styleScope = 'cues-' + useId().replace(/[^a-zA-Z0-9]/g, '');

  const useHlsJs = useMemo(() => Hls.isSupported(), []);
  const isOriginal = quality === 'original' && playback.original.available;
  const isAudio = quality === 'audio';

  // Reloading the media element is only needed when the *kind* of source changes.
  const sourceKey = isOriginal
    ? 'original'
    : isAudio
      ? 'audio'
      : useHlsJs
        ? 'hls'
        : `native:${quality}`;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((value) => (value === message ? null : value)), 2200);
  }, []);

  // Subtitles are sized from the rendered height of the video box, so they stay
  // proportionate in the inline, theater and fullscreen layouts alike.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scale = (playback.subtitleFontScale || 125) / 100;
    const recalculate = () => {
      const height = container.getBoundingClientRect().height || 360;
      const size = Math.round(Math.min(CUE_MAX_PX, Math.max(CUE_MIN_PX, height * 0.038 * scale)));
      setCueFontPx(size);
    };

    recalculate();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(recalculate);
    observer.observe(container);
    return () => observer.disconnect();
  }, [playback.subtitleFontScale]);

  /** Cue positions are per-cue, and cues only exist once the track file loads. */
  const liftCues = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    const tracks = element.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const cues = tracks[i].cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        const cue = cues[j] as VTTCue;
        if (cue.snapToLines !== false && cue.line !== CUE_LINE) cue.line = CUE_LINE;
      }
    }
  }, []);

  // ---------------------------------------------------------------- source --
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    setError(null);
    setWaiting(true);

    const seekTo = resumeRef.current;

    const applyResume = () => {
      if (seekTo > 1 && Number.isFinite(element.duration) && seekTo < element.duration - 2) {
        try {
          element.currentTime = seekTo;
        } catch {
          /* some browsers refuse until they have data */
        }
      }
      setWaiting(false);

      // Only on the first load of this video — switching quality must not
      // restart a video the viewer had deliberately paused.
      if (playback.autoplayOnOpen && !autoplayedRef.current) {
        autoplayedRef.current = true;
        void element.play().catch(() => {
          /* blocked until the viewer interacts; the play button is right there */
        });
      }
    };

    element.addEventListener('loadedmetadata', applyResume, { once: true });

    if (isOriginal) {
      element.src = urls.original(video.id);
      element.load();
    } else if (isAudio && !useHlsJs) {
      element.src = urls.hlsAudio(video.id);
      element.load();
    } else if (useHlsJs) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 180,
        // Segments are produced on demand, so the first one can take a moment.
        fragLoadingTimeOut: 60_000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingTimeOut: 20_000,
      });
      hlsRef.current = hls;
      hls.attachMedia(element);
      // Audio-only is a standalone variant rather than a rung of the ladder, so
      // that adaptive switching can never drop the picture on its own.
      hls.loadSource(isAudio ? urls.hlsAudio(video.id) : urls.hlsMaster(video.id));

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyLevel(hls, quality);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls.levels[data.level];
        setAutoLevelLabel(level && level.height ? `${level.height}p` : '');
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setError('Playback failed. The server may still be transcoding — try again in a moment.');
        }
      });
    } else {
      element.src = quality === 'auto' ? urls.hlsMaster(video.id) : urls.hlsVariant(video.id, quality);
      element.load();
    }

    return () => {
      element.removeEventListener('loadedmetadata', applyResume);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      element.removeAttribute('src');
      try {
        element.load();
      } catch {
        /* teardown race */
      }
    };
    // `quality` intentionally excluded: pinning a level does not reload the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, sourceKey]);

  // Flipping the data saver switch mid-video re-picks the quality there and then.
  useEffect(() => {
    if (preferred === appliedPreferred.current) return;
    appliedPreferred.current = preferred;
    switchQuality(preferred);
    // switchQuality is a hoisted declaration below; it only touches refs and state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred]);

  // Pin or unpin the hls.js level when the quality menu changes.
  useEffect(() => {
    if (hlsRef.current) applyLevel(hlsRef.current, quality);
  }, [quality]);

  function applyLevel(hls: Hls, wanted: string) {
    if (wanted === 'auto' || wanted === 'original' || wanted === 'audio') {
      hls.currentLevel = -1;
      return;
    }
    const target = playback.renditions.find((r) => r.id === wanted);
    if (!target) {
      hls.currentLevel = -1;
      return;
    }
    const index = hls.levels.findIndex((level) => level.height === target.height);
    hls.currentLevel = index >= 0 ? index : -1;
  }

  // ------------------------------------------------------------ media events
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const onTime = () => {
      if (!dragging) setCurrent(element.currentTime);
      if (element.currentTime > 0) lastTimeRef.current = element.currentTime;
      if (onTimeProp && Math.abs(element.currentTime - lastReportedRef.current) >= 1) {
        lastReportedRef.current = element.currentTime;
        onTimeProp(element.currentTime);
      }
      const ranges = element.buffered;
      if (ranges.length) {
        for (let i = 0; i < ranges.length; i++) {
          if (element.currentTime >= ranges.start(i) && element.currentTime <= ranges.end(i)) {
            setBuffered(ranges.end(i));
            break;
          }
        }
      }
    };
    const onDuration = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        setDuration(element.duration);
        lastDurationRef.current = element.duration;
      }
    };
    const onPlay = () => {
      setPlaying(true);
      setError(null);
    };
    const onPause = () => setPlaying(false);
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    const onVolume = () => {
      // A fade drives element.volume itself; the slider should stay put.
      if (fadeRef.current) return;
      setVolume(element.volume);
      setMuted(element.muted);
    };
    const onError = () => {
      // A codec the browser cannot decode: drop to the transcoded ladder.
      if (isOriginal) {
        resumeRef.current = element.currentTime || resumeRef.current;
        setQuality('auto');
        showToast('This file needs transcoding — switched to Auto');
      } else {
        setError('Playback failed. Check the server logs for ffmpeg errors.');
      }
    };

    element.addEventListener('timeupdate', onTime);
    element.addEventListener('progress', onTime);
    element.addEventListener('durationchange', onDuration);
    element.addEventListener('loadedmetadata', onDuration);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    element.addEventListener('waiting', onWaiting);
    element.addEventListener('playing', onPlaying);
    element.addEventListener('volumechange', onVolume);
    element.addEventListener('error', onError);
    element.addEventListener('ended', onEnded);

    return () => {
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('progress', onTime);
      element.removeEventListener('durationchange', onDuration);
      element.removeEventListener('loadedmetadata', onDuration);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('waiting', onWaiting);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('volumechange', onVolume);
      element.removeEventListener('error', onError);
      element.removeEventListener('ended', onEnded);
    };
  }, [dragging, isOriginal, onEnded, showToast, onTimeProp]);

  // ------------------------------------------------------------ progress ----
  const report = useCallback(() => {
    const position = lastTimeRef.current;
    const total = lastDurationRef.current;
    if (!(total > 0) || !(position > 0)) return;
    resumeRef.current = position;
    onProgress(position, total);
  }, [onProgress]);

  useEffect(() => {
    if (!playing) return;
    progressTimer.current = window.setInterval(report, PROGRESS_INTERVAL_MS);
    return () => {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    };
  }, [playing, report]);

  useEffect(() => {
    const flush = () => report();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [report]);

  // ------------------------------------------------------------ captions ----
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const tracks = element.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === captions ? 'showing' : 'disabled';
    }

    liftCues();

    const active = captions >= 0 ? tracks[captions] : null;
    if (!active) return;
    active.addEventListener('cuechange', liftCues);
    return () => active.removeEventListener('cuechange', liftCues);
  }, [captions, video.id, sourceKey, liftCues]);

  // ---------------------------------------------------------- interactions --
  const armHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setControlsVisible(true);
    hideTimer.current = window.setTimeout(() => {
      const element = videoRef.current;
      if (element && !element.paused && !dragging) setControlsVisible(false);
    }, CONTROL_HIDE_MS);
  }, [dragging]);

  useEffect(() => {
    armHide();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [armHide, playing]);

  /**
   * Immediate visual confirmation of a play or pause, since with the big button
   * hidden — and especially with a fade running — nothing else changes on
   * screen at the moment of the click.
   */
  const showFlash = useCallback(
    (kind: 'play' | 'pause') => {
      if (playback.centerPlayButton) return;
      window.clearTimeout(flashTimer.current);
      setFlash({ kind, id: Date.now() });
      flashTimer.current = window.setTimeout(() => setFlash(null), 650);
    },
    [playback.centerPlayButton],
  );

  const cancelFade = useCallback((restoreVolume: boolean) => {
    const fade = fadeRef.current;
    if (!fade) return;
    window.clearInterval(fade.interval);
    window.clearTimeout(fade.deadline);
    fadeRef.current = null;
    if (restoreVolume && videoRef.current) videoRef.current.volume = fade.startVolume;
  }, []);

  const play = useCallback(() => {
    // Pressing play mid-fade means "never mind" — bring the sound straight back.
    cancelFade(true);
    showFlash('play');
    void videoRef.current?.play().catch(() => {});
  }, [cancelFade, showFlash]);

  /**
   * Pauses, easing the sound down first if the setting asks for it. The video
   * keeps playing during the fade so the picture does not freeze early.
   */
  const pause = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    showFlash('pause');
    const seconds = playback.fadeOutSeconds || 0;

    // Pause outright when there is nothing to fade, when a fade is already
    // running (a second press means "stop now"), or when the page is in the
    // background — timers crawl there and nobody is watching the fade anyway.
    if (
      seconds <= 0 ||
      element.muted ||
      element.volume === 0 ||
      fadeRef.current ||
      document.visibilityState === 'hidden'
    ) {
      cancelFade(true);
      element.pause();
      return;
    }

    const startVolume = element.volume;
    const durationMs = seconds * 1000;
    const startedAt = performance.now();

    const finish = () => {
      const fade = fadeRef.current;
      if (fade) {
        window.clearInterval(fade.interval);
        window.clearTimeout(fade.deadline);
      }
      fadeRef.current = null;
      element.pause();
      element.volume = startVolume;
    };

    const tick = () => {
      const progress = Math.min(1, Math.max(0, (performance.now() - startedAt) / durationMs));
      // volume throws outside [0, 1]; an overshoot here is what jammed the
      // earlier animation-frame version of this loop.
      element.volume = Math.min(1, Math.max(0, startVolume * (1 - progress)));
      if (progress >= 1) finish();
    };

    fadeRef.current = {
      interval: window.setInterval(tick, 30),
      // Even if the interval is throttled, the pause still lands on time.
      deadline: window.setTimeout(finish, durationMs + 50),
      startVolume,
    };
  }, [cancelFade, playback.fadeOutSeconds, showFlash]);

  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    // A second press while the sound is fading means "just stop now".
    if (element.paused) play();
    else pause();
  }, [play, pause]);

  // Never leave the element half-faded if the component goes away mid-fade.
  useEffect(() => () => cancelFade(true), [cancelFade]);

  const seekBy = useCallback(
    (delta: number) => {
      const element = videoRef.current;
      if (!element) return;
      const next = Math.min(Math.max(0, element.currentTime + delta), element.duration || Infinity);
      element.currentTime = next;
      setCurrent(next);
      setSeekFlash(delta > 0 ? 'right' : 'left');
      window.setTimeout(() => setSeekFlash(null), 480);
      armHide();
    },
    [armHide],
  );

  const seekTo = useCallback((seconds: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(seconds, element.duration || seconds));
    setCurrent(element.currentTime);
    lastTimeRef.current = element.currentTime;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const element = videoRef.current as any;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (container?.requestFullscreen) {
      void container.requestFullscreen().catch(() => {});
    } else if (element?.webkitEnterFullscreen) {
      // iPhone can only fullscreen the video element itself.
      element.webkitEnterFullscreen();
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      const entered = Boolean(document.fullscreenElement);
      setFullscreen(entered);
      window.clearTimeout(timer);
      setFsNotice(entered);
      if (entered) timer = window.setTimeout(() => setFsNotice(false), 6000);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  // Lets the description's timestamps drive the player.
  useImperativeHandle(
    ref,
    () => ({
      seekTo: (seconds: number) => {
        seekTo(seconds);
        void videoRef.current?.play().catch(() => {});
        containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
      getPosition: () => ({ position: lastTimeRef.current, duration: lastDurationRef.current }),
    }),
    [seekTo],
  );

  // Lock screen, notification shade and Android Auto. Which buttons appear is
  // decided by which handlers are registered, so previous/next are only set
  // when there is somewhere to go.
  useEffect(() => {
    const session = (navigator as any).mediaSession;
    if (!session) return;

    const step = playback.seekStep || 10;

    try {
      const Metadata = (window as any).MediaMetadata;
      if (Metadata) {
        session.metadata = new Metadata({
          title: video.title,
          artist: video.channelTitle,
          album: 'PinchTube',
          artwork: video.hasThumb
            ? [256, 384, 512].map((width) => ({
                src: urls.videoThumb(video.id, width),
                sizes: `${width}x${Math.round((width * 9) / 16)}`,
              }))
            : [],
        });
      }
    } catch {
      /* metadata is a nicety, never worth breaking playback over */
    }

    const set = (action: string, handler: ((details: any) => void) | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* this platform does not offer that button */
      }
    };

    set('play', play);
    set('pause', pause);
    set('seekbackward', (details) => seekBy(-(details?.seekOffset || step)));
    set('seekforward', (details) => seekBy(details?.seekOffset || step));
    set('seekto', (details) => {
      if (typeof details?.seekTime === 'number') seekTo(details.seekTime);
    });
    // null removes a button rather than leaving a dead one on screen.
    set('previoustrack', onPrevious ?? null);
    set('nexttrack', onNext ?? null);

    return () => {
      for (const action of MEDIA_SESSION_ACTIONS) set(action, null);
    };
  }, [video, playback.seekStep, seekBy, seekTo, play, pause, onPrevious, onNext]);

  useEffect(() => {
    const session = (navigator as any).mediaSession;
    if (session) session.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  // Feeds the scrubber and elapsed time in the notification.
  useEffect(() => {
    const session = (navigator as any).mediaSession;
    if (!session || typeof session.setPositionState !== 'function') return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      session.setPositionState({
        duration,
        playbackRate: speed,
        position: Math.min(Math.max(0, current), duration),
      });
    } catch {
      /* throws if the numbers disagree while a source is switching */
    }
  }, [current, duration, speed]);

  // Keyboard shortcuts, skipped while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const step = playback.seekStep || 10;

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seekBy(-step);
          break;
        case 'ArrowRight':
          event.preventDefault();
          seekBy(step);
          break;
        case 'j':
          seekBy(-30);
          break;
        // Shift+N / Shift+P, as on YouTube.
        case 'N':
          onNext?.();
          break;
        case 'P':
          onPrevious?.();
          break;
        case 'l':
          seekBy(30);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 't':
          onToggleTheater?.();
          break;
        case 'm': {
          const element = videoRef.current;
          if (element) element.muted = !element.muted;
          break;
        }
        case 'c':
          setCaptions((value) => (value >= 0 ? -1 : video.subtitles.length ? 0 : -1));
          break;
        default:
          if (/^[0-9]$/.test(event.key) && duration) {
            seekTo((Number(event.key) / 10) * duration);
          }
      }
      armHide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    armHide,
    duration,
    onToggleTheater,
    onNext,
    onPrevious,
    playback.seekStep,
    seekBy,
    seekTo,
    toggleFullscreen,
    togglePlay,
    video.subtitles.length,
  ]);

  // Chapter segments for the bar: one piece per stretch of the video, even
  // where chapters overlap. With no chapters the whole bar is one segment, so
  // the rendering path is the same either way.
  const flattened = useMemo(() => flattenChapters(video.chapters, duration), [video.chapters, duration]);
  const hasChapters = flattened.length > 0;
  const segments: Chapter[] = hasChapters
    ? flattened
    : [{ start: 0, end: Math.max(duration, 1), title: '', kind: 'chapter' }];
  const timeline = Math.max(duration, 1);
  const currentChapter = hasChapters ? chapterAt(segments, current) : null;
  const autoSkip = playback.sponsorAutoSkip === true;
  const activeSponsor =
    !autoSkip && playback.sponsorSkipPrompt !== false && currentChapter?.kind === 'sponsor' ? currentChapter : null;

  const skipSponsor = (segment: Chapter) => {
    const element = videoRef.current;
    if (!element) return;
    const total = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : duration;
    // Never jump past the end. A sponsor that runs to the very end lands a
    // hair before it, so the video finishes normally and "ended" still fires
    // for autoplay and the queue.
    seekTo(Math.min(segment.end, Math.max(0, total - 0.05)));
    armHide();
  };

  // Automatic skipping jumps a sponsor segment as playback enters it, and
  // offers a few seconds to undo. A segment that was undone is left to play,
  // and nothing jumps while the bar is being dragged or the video is paused.
  const [skipped, setSkipped] = useState<Chapter | null>(null);
  const keepSponsorRef = useRef<number | null>(null);
  const sponsorStart = currentChapter?.kind === 'sponsor' ? currentChapter.start : null;
  useEffect(() => {
    if (!autoSkip || dragging || !playing || sponsorStart === null || !currentChapter) return;
    if (keepSponsorRef.current === sponsorStart) return;
    skipSponsor(currentChapter);
    setSkipped(currentChapter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSkip, dragging, playing, sponsorStart]);

  useEffect(() => {
    if (!skipped) return;
    const timer = window.setTimeout(() => setSkipped(null), 5000);
    return () => window.clearTimeout(timer);
  }, [skipped]);

  const unskipSponsor = (segment: Chapter) => {
    keepSponsorRef.current = segment.start;
    setSkipped(null);
    seekTo(segment.start);
    armHide();
  };

  // Scrub bar dragging (pointer events cover mouse and touch alike).
  const scrubRef = useRef<HTMLDivElement>(null);

  const positionFromEvent = (clientX: number): number => {
    const rect = scrubRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const onScrubDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDragging(true);
    const next = positionFromEvent(event.clientX);
    setCurrent(next);
  };

  const onScrubMove = (event: ReactPointerEvent) => {
    const time = positionFromEvent(event.clientX);
    const rect = scrubRef.current?.getBoundingClientRect();
    if (rect) {
      const chapter = chapterAt(segments, time);
      setScrubHover({
        x: Math.min(rect.width, Math.max(0, event.clientX - rect.left)),
        time,
        title: chapter?.title ?? '',
      });
    }
    if (dragging) setCurrent(time);
  };

  const onScrubUp = (event: ReactPointerEvent) => {
    if (!dragging) return;
    const next = positionFromEvent(event.clientX);
    setDragging(false);
    seekTo(next);
    armHide();
  };

  // Tap to toggle controls, double-tap either side to skip.
  const tapAt = (side: 'left' | 'right', pointerType: string) => {
    const now = Date.now();
    const last = lastTapRef.current;

    if (now - last.time < 300 && last.side === side) {
      lastTapRef.current = { time: 0, side: null };
      seekBy(side === 'left' ? -(playback.seekStep || 10) : playback.seekStep || 10);
      return;
    }
    lastTapRef.current = { time: now, side };

    if (pointerType === 'mouse') {
      togglePlay();
    } else {
      setControlsVisible((visible) => !visible);
      armHide();
    }
  };

  const sideOf = (clientX: number): 'left' | 'right' => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect && clientX - rect.left < rect.width / 2 ? 'left' : 'right';
  };

  const onSurfacePointer = (event: ReactPointerEvent) => {
    if (
      (event.target as HTMLElement).closest(
        '.player-controls, .player-menu, .player-bigplay, .sponsor-skip',
      )
    ) {
      return;
    }

    // A mouse click acts straight away. A finger is only a tap once it lifts
    // without having moved — until then it might be a swipe.
    if (event.pointerType === 'mouse') {
      tapAt(sideOf(event.clientX), 'mouse');
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    touchRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      side: sideOf(event.clientX),
      mode: 'pending',
      startValue: 0,
      height: rect?.height || 300,
    };
  };

  const applyGesture = (kind: GestureKind, value: number) => {
    if (kind === 'volume') {
      const element = videoRef.current;
      if (element) {
        element.volume = value;
        element.muted = value === 0;
      }
    } else {
      sessionBrightness = value;
      setBrightness(value);
    }
    window.clearTimeout(hudTimer.current);
    setGestureHud({ kind, value });
  };

  const onSurfaceMove = (event: ReactPointerEvent) => {
    const track = touchRef.current;
    if (!track || track.id !== event.pointerId) return;

    if (track.mode === 'pending') {
      const dx = event.clientX - track.x;
      const dy = event.clientY - track.y;
      if (Math.abs(dx) < GESTURE_SLOP_PX && Math.abs(dy) < GESTURE_SLOP_PX) return;

      const kind: GestureKind = track.side === 'right' ? 'volume' : 'brightness';
      const enabled = kind === 'volume' ? playback.gestureVolume : playback.gestureBrightness;
      const vertical = Math.abs(dy) > Math.abs(dx) * 1.3;

      // Gestures are fullscreen-only, so outside it the page keeps scrolling.
      if (!fullscreen || !vertical || enabled === false) {
        track.mode = 'scroll';
        return;
      }

      const element = videoRef.current;
      track.mode = kind;
      track.startValue =
        kind === 'volume' ? (element && !element.muted ? element.volume : 0) : brightness;
      // Measure from here, so the bar does not jump by the slop distance.
      track.y = event.clientY;
      try {
        containerRef.current?.setPointerCapture(event.pointerId);
      } catch {
        /* capture is a nicety */
      }
    }

    if (track.mode === 'volume' || track.mode === 'brightness') {
      const delta = -(event.clientY - track.y) / (track.height * GESTURE_TRAVEL);
      applyGesture(track.mode, clamp01(track.startValue + delta));
    }
  };

  const endGesture = () => {
    window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setGestureHud(null), 700);
  };

  const onSurfaceUp = (event: ReactPointerEvent) => {
    const track = touchRef.current;
    if (!track || track.id !== event.pointerId) return;
    touchRef.current = null;

    if (track.mode === 'volume' || track.mode === 'brightness') {
      endGesture();
      return;
    }
    if (track.mode === 'pending') tapAt(track.side, event.pointerType);
  };

  const onSurfaceCancel = (event: ReactPointerEvent) => {
    const track = touchRef.current;
    if (!track || track.id !== event.pointerId) return;
    touchRef.current = null;
    if (track.mode === 'volume' || track.mode === 'brightness') endGesture();
  };

  // ---------------------------------------------------------------- render --
  const qualityLabel =
    quality === 'auto'
      ? autoLevelLabel
        ? `Auto (${autoLevelLabel})`
        : 'Auto'
      : quality === 'original'
        ? 'Original'
        : quality === 'audio'
          ? 'Audio'
          : quality;

  const playedPercent = duration ? (current / duration) * 100 : 0;
  const bufferedEnd = buffered;

  return (
    <div
      ref={containerRef}
      className={`player ${styleScope}${fullscreen ? ' fullscreen' : ''}${
        fsNotice ? ' fs-notice' : ''
      }${fullscreen && playing && !controlsVisible ? ' hide-cursor' : ''} player-sticky`}
      onPointerDown={onSurfacePointer}
      onPointerMove={onSurfaceMove}
      onPointerUp={onSurfaceUp}
      onPointerCancel={onSurfaceCancel}
      onMouseMove={armHide}
      onMouseLeave={() => playing && setControlsVisible(false)}
    >
      <style>{`.${styleScope} video::cue{font-size:${cueFontPx}px;}`}</style>

      <video
        ref={videoRef}
        playsInline
        style={
          brightness < 1
            ? { filter: `brightness(${MIN_BRIGHTNESS + brightness * (1 - MIN_BRIGHTNESS)})` }
            : undefined
        }
        preload="metadata"
        poster={video.hasThumb ? urls.videoThumb(video.id, 1280) : undefined}
      >
        {video.subtitles.map((track) => (
          <track
            key={track.index}
            kind="subtitles"
            label={track.label}
            srcLang={track.lang === 'und' ? undefined : track.lang}
            src={urls.subtitle(video.id, track.index)}
            onLoad={liftCues}
          />
        ))}
      </video>

      {isAudio ? (
        <div className="player-audio-art">
          {video.hasThumb ? <img src={urls.videoThumb(video.id, 640)} alt="" /> : null}
          <span>Audio only</span>
        </div>
      ) : null}

      {seekFlash ? (
        <div className="seek-flash" style={seekFlash === 'left' ? { left: 0 } : { right: 0 }}>
          {seekFlash === 'left' ? '−' : '+'}
          {playback.seekStep || 10}s
        </div>
      ) : null}

      {/* The button stays in the tree even when hidden, so a tap in the middle
          of the picture still plays or pauses; only its visibility is optional. */}
      <div
        className={`player-center${
          (playback.centerPlayButton && (controlsVisible || !playing)) || (waiting && playing)
            ? ' visible'
            : ''
        }`}
      >
        {waiting && playing ? (
          <div className="spinner" style={{ borderTopColor: '#fff' }} />
        ) : (
          <button
            className="player-bigplay"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>
        )}
      </div>

      {activeSponsor ? (
        <div className="sponsor-skip">
          <button type="button" onClick={() => skipSponsor(activeSponsor)}>
            Skip sponsor
            <IconForward />
          </button>
        </div>
      ) : skipped ? (
        <div className="sponsor-skip">
          <button type="button" onClick={() => unskipSponsor(skipped)}>
            Skipped sponsor
            <span className="sponsor-undo">Undo</span>
          </button>
        </div>
      ) : null}

      {gestureHud ? (
        <div className={`gesture-hud ${gestureHud.kind === 'volume' ? 'right' : 'left'}`} aria-hidden="true">
          <span className="gesture-icon">
            {gestureHud.kind === 'brightness' ? (
              <IconSun />
            ) : gestureHud.value === 0 ? (
              <IconVolumeMute />
            ) : (
              <IconVolume />
            )}
          </span>
          <span className="gesture-bar">
            <span className="gesture-fill" style={{ height: `${gestureHud.value * 100}%` }} />
          </span>
        </div>
      ) : null}

      {flash ? (
        <div className="player-flash" key={flash.id} aria-hidden="true">
          <span className="player-flash-icon">
            {flash.kind === 'pause' ? <IconPause /> : <IconPlay />}
          </span>
        </div>
      ) : null}

      {toast ? <div className="player-toast">{toast}</div> : null}
      {error ? <div className="player-error">{error}</div> : null}

      <div className={`player-overlay${controlsVisible || !playing ? ' visible' : ''}`}>
        <div className="player-controls">
          <div
            ref={scrubRef}
            className={`player-scrub${dragging ? ' dragging' : ''}`}
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            onPointerCancel={onScrubUp}
            onPointerLeave={() => {
              if (!dragging) setScrubHover(null);
            }}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(current)}
            tabIndex={0}
          >
            {/* One track per chapter, each filling on its own, with a hairline
                gap between them — the YouTube treatment. Without chapters this
                collapses to a single full-width segment. */}
            <div className={`track${hasChapters ? ' chaptered' : ''}`}>
              {segments.map((segment, index) => {
                const length = segment.end - segment.start;
                const played = clamp01((current - segment.start) / length);
                const buffered = clamp01((bufferedEnd - segment.start) / length);
                const hovered = scrubHover !== null && chapterAt(segments, scrubHover.time) === segment;
                return (
                  <div
                    key={index}
                    className={`seg${segment.kind === 'sponsor' ? ' sponsor' : ''}${hovered ? ' hovered' : ''}`}
                    // Placed by time rather than laid out in a row, so the bar
                    // matches the clock however many tiny chapters there are.
                    // Every piece but the last leaves a hairline gap after it.
                    style={{
                      left: `${(segment.start / timeline) * 100}%`,
                      width:
                        index === segments.length - 1
                          ? `${(length / timeline) * 100}%`
                          : `max(1px, calc(${(length / timeline) * 100}% - 2px))`,
                    }}
                  >
                    <div className="buffered" style={{ width: `${buffered * 100}%` }} />
                    <div className="played" style={{ width: `${played * 100}%` }} />
                  </div>
                );
              })}
              <div className="knob" style={{ left: `${playedPercent}%` }} />
            </div>

            {scrubHover ? (
              <div className="scrub-tip" style={{ left: scrubHover.x }}>
                {scrubHover.title ? <span className="scrub-tip-title">{scrubHover.title}</span> : null}
                <span className="scrub-tip-time">{formatDuration(scrubHover.time)}</span>
              </div>
            ) : null}
          </div>

          <div className="player-buttons">
            {trackButtons ? (
              <button
                className="pbtn"
                onClick={onPrevious}
                disabled={!onPrevious}
                aria-label="Previous video"
                title="Previous (Shift+P)"
              >
                <IconSkipPrevious />
              </button>
            ) : null}

            <button className="pbtn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>

            {trackButtons ? (
              <button
                className="pbtn"
                onClick={onNext}
                disabled={!onNext}
                aria-label="Next video"
                title="Next (Shift+N)"
              >
                <IconSkipNext />
              </button>
            ) : null}

            <div className="volume-wrap">
              <button
                className="pbtn"
                onClick={() => {
                  const element = videoRef.current;
                  if (element) element.muted = !element.muted;
                }}
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                {muted || volume === 0 ? <IconVolumeMute /> : <IconVolume />}
              </button>
              <input
                className="volume-slider"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                onChange={(event) => {
                  const element = videoRef.current;
                  if (!element) return;
                  element.volume = Number(event.target.value);
                  element.muted = Number(event.target.value) === 0;
                }}
              />
            </div>

            <span className="player-time">
              {formatDuration(current)} / {formatDuration(duration)}
              {currentChapter ? (
                <span className="player-chapter" title={currentChapter.title}>
                  <span className="dot">•</span>
                  {currentChapter.title}
                </span>
              ) : null}
            </span>

            <span className="player-spacer" />

            {video.subtitles.length ? (
              <button
                className="pbtn"
                onClick={() => setMenu(menu === 'captions' ? null : 'captions')}
                aria-label="Subtitles"
                style={captions >= 0 ? { color: 'var(--accent)' } : undefined}
              >
                <IconCaptions />
              </button>
            ) : null}

            <button className="pbtn text" onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
              {qualityLabel}
            </button>

            <button
              className="pbtn"
              onClick={() => setMenu(menu === 'speed' ? null : 'speed')}
              aria-label="Playback settings"
            >
              <IconGearSmall />
            </button>

            {'requestPictureInPicture' in HTMLVideoElement.prototype ? (
              <button
                className="pbtn hide-sm"
                onClick={() => {
                  const element = videoRef.current as any;
                  if (document.pictureInPictureElement) void document.exitPictureInPicture();
                  else void element?.requestPictureInPicture?.().catch(() => {});
                }}
                aria-label="Picture in picture"
              >
                <IconPip />
              </button>
            ) : null}

            {onToggleTheater ? (
              <button
                className="pbtn hide-sm"
                onClick={onToggleTheater}
                aria-label={theater ? 'Exit theater mode' : 'Theater mode'}
                title={theater ? 'Exit theater mode (t)' : 'Theater mode (t)'}
                style={theater ? { color: 'var(--accent)' } : undefined}
              >
                <IconTheater />
              </button>
            ) : null}

            <button className="pbtn" onClick={toggleFullscreen} aria-label="Fullscreen">
              {fullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
            </button>
          </div>
        </div>
      </div>

      {menu === 'quality' ? (
        <div className="player-menu">
          <div className="menu-head">Quality</div>
          <MenuItem
            label="Auto"
            hint={autoLevelLabel}
            selected={quality === 'auto'}
            onClick={() => {
              switchQuality('auto');
            }}
          />
          {playback.original.available ? (
            <MenuItem
              label="Original"
              hint={playback.original.height ? `${playback.original.height}p` : undefined}
              selected={quality === 'original'}
              onClick={() => switchQuality('original')}
            />
          ) : null}
          {playback.renditions.map((rendition) => (
            <MenuItem
              key={rendition.id}
              label={rendition.label}
              selected={quality === rendition.id}
              onClick={() => switchQuality(rendition.id)}
            />
          ))}
          {playback.audioOnly?.available ? (
            <MenuItem
              label={playback.audioOnly.label}
              hint="lowest data"
              selected={quality === 'audio'}
              onClick={() => switchQuality('audio')}
            />
          ) : null}
        </div>
      ) : null}

      {menu === 'speed' ? (
        <div className="player-menu">
          <div className="menu-head">Playback speed</div>
          {SPEEDS.map((value) => (
            <MenuItem
              key={value}
              label={value === 1 ? 'Normal' : `${value}×`}
              selected={speed === value}
              onClick={() => {
                const element = videoRef.current;
                if (element) element.playbackRate = value;
                setSpeed(value);
                setMenu(null);
              }}
            />
          ))}
        </div>
      ) : null}

      {menu === 'captions' ? (
        <div className="player-menu">
          <div className="menu-head">Subtitles</div>
          <MenuItem
            label="Off"
            selected={captions < 0}
            onClick={() => {
              setCaptions(-1);
              setMenu(null);
            }}
          />
          {video.subtitles.map((track) => (
            <MenuItem
              key={track.index}
              label={track.label}
              selected={captions === track.index}
              onClick={() => {
                setCaptions(track.index);
                setMenu(null);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );

  function switchQuality(next: string) {
    const element = videoRef.current;
    if (element && element.currentTime > 0) resumeRef.current = element.currentTime;
    const wasPlaying = element ? !element.paused : false;
    setQuality(next);
    setMenu(null);
    if (wasPlaying) {
      window.setTimeout(() => void videoRef.current?.play().catch(() => {}), 120);
    }
  }
});

function MenuItem({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} type="button">
      <span className="tick">{selected ? <IconCheck /> : null}</span>
      <span>{label}</span>
      {hint ? <span className="sub">{hint}</span> : null}
    </button>
  );
}
