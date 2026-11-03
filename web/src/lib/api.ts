/*
 * api.ts — how the web app talks to the server.
 *
 * Three things:
 *   - `api`: get/post/put/patch/del helpers that call the server's JSON API
 *     (server/src/routes/), add the X-Requested-With header the server
 *     requires for changes, and turn error replies into an ApiError. A
 *     "not signed in" reply fires an event that sends the app back to sign-in.
 *   - TypeScript types describing what each API call returns; these mirror
 *     the server's own types (e.g. VideoDto in server/src/lib/videos.ts)
 *   - `urls`: builders for addresses that are used directly by <img> and
 *     <video> elements rather than fetched as JSON (artwork, streams, subtitles)
 */

/** An error reply from the server, with its HTTP status and readable message. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Fired when the server rejects a call as unauthenticated, so the app can bounce to login. */
export const UNAUTHORIZED_EVENT = 'ytm:unauthorized';

/** Makes one API call and returns the parsed JSON reply, or throws an ApiError. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      // The server refuses changes without this header, which a cross-site
      // form or image request has no way to add.
      'X-Requested-With': 'PinchTube',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }

  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
  }
  return data as T;
}

/** One helper per HTTP method; `body` is sent as JSON. */
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** A small POST that still completes if the page is closing, e.g. the last playback position. */
  postKeepalive: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), keepalive: true }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ------------------------------------------------------------------ users --

/** The signed-in user. */
export interface CurrentUser {
  id: number;
  username: string;
  isAdmin: boolean;
  twoFactor: boolean;
}

/** An account as the admin's Users panel sees it. */
export interface ManagedUser {
  id: number;
  username: string;
  isAdmin: boolean;
  allChannels: boolean;
  channels: string[];
  twoFactor: boolean;
  createdAt: number;
  /** When the account last used the app; null if it never has. */
  lastActive: number | null;
}

/** A playlist, as listed. */
export interface PlaylistDto {
  id: number;
  name: string;
  shared: boolean;
  /** Off: viewers can play everything in it, even from channels they cannot otherwise see. */
  strict: boolean;
  /** The signed-in user's own quality for this playlist. */
  quality: string;
  owner: string;
  mine: boolean;
  count: number;
  duration: number;
  coverVideoId: string | null;
  updatedAt: number;
}

// ------------------------------------------------------------------ types --

/** A video, with this user's progress through it. */
export interface VideoDto {
  id: string;
  title: string;
  plot: string | null;
  aired: number | null;
  addedAt: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  vcodec: string | null;
  acodec: string | null;
  container: string | null;
  size: number | null;
  season: string | null;
  path: string;
  relPath: string;
  channelId: string;
  channelTitle: string;
  hasThumb: boolean;
  subtitles: { index: number; lang: string; label: string }[];
  youtubeId: string | null;
  chapters: Chapter[];
  progress: { position: number; watched: boolean };
}

/** A chapter or SponsorBlock segment, in seconds. */
export interface Chapter {
  start: number;
  end: number;
  title: string;
  kind: 'chapter' | 'sponsor';
}

/** A channel, with counts for this user. */
export interface ChannelDto {
  id: string;
  title: string;
  plot: string | null;
  videoCount: number;
  latestAired: number | null;
  unwatchedCount: number;
  hasPoster: boolean;
  hasBanner: boolean;
  hasFanart: boolean;
}

/** One row of the home page. */
export interface HomeRowDto {
  id: string;
  kind: 'videos';
  title: string;
  items: VideoDto[];
  channel?: ChannelDto;
  link?: string;
}

/** A converted quality the video can be played at. */
export interface RenditionDto {
  id: string;
  label: string;
  /** The shorter side of the picture, as in "1080p". */
  size: number;
  bitrate: number;
}

/** Everything the watch page gets for a video (GET /api/videos/:id). */
export interface WatchPayload {
  video: VideoDto;
  /** False when a playlist granted this video without access to its channel. */
  channelAccessible: boolean;
  playback: {
    renditions: RenditionDto[];
    original: {
      available: boolean;
      container?: string | null;
      vcodec?: string | null;
      acodec?: string | null;
      height?: number | null;
      width?: number | null;
      size?: number | null;
    };
    defaults: { wifi: string; cellular: string };
    audioOnly: { id: string; label: string; available: boolean };
    subtitlesDefault: boolean;
    subtitleFontScale: number;
    autoplayNext: boolean;
    autoplayOnOpen: boolean;
    queueQuality: string;
    centerPlayButton: boolean;
    fadeOutSeconds: number;
    sponsorSkipPrompt: boolean;
    sponsorAutoSkip: boolean;
    gestureVolume: boolean;
    gestureBrightness: boolean;
    seekStep: number;
    resumeThresholdSeconds: number;
  };
  upNext: VideoDto[];
}

export type HwAccelMode = 'auto' | 'vaapi' | 'qsv' | 'nvenc' | 'none';

/**
 * `library` and `transcode` are server-wide and only sent to administrators —
 * for anyone else they are simply absent, so only read them behind an
 * isAdmin check. Everything else is the signed-in user's own.
 */
/** Every setting, by section (see server/src/settings.ts). */
export interface AppSettings {
  library: {
    mediaPath: string;
    scanIntervalMinutes: number;
    watcherEnabled: boolean;
    watcherUsePolling: boolean;
  };
  appearance: {
    theme: 'system' | 'dark' | 'light';
    accent: string;
    sponsorColor: string;
    cardSize: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
    dimWatched: boolean;
    channelLayout: 'auto' | 'grid' | 'list';
    animateMenu: boolean;
  };
  home: {
    rows: { id: string; enabled: boolean; title: string; limit: number; videosPerChannel?: number }[];
    channelOrder: 'name' | 'recent';
    channelRows: { id: string; enabled: boolean; pinned: boolean }[];
  };
  playback: {
    defaultQualityWifi: string;
    defaultQualityCellular: string;
    maxQuality: string;
    queueQuality: string;
    queueAdvance: 'always' | 'threshold' | 'custom' | 'complete' | 'never';
    queueAdvancePercent: number;
    centerPlayButton: boolean;
    fadeOutSeconds: number;
    sponsorSkipPrompt: boolean;
    sponsorAutoSkip: boolean;
    gestureVolume: boolean;
    gestureBrightness: boolean;
    autoplayNext: boolean;
    autoplayOnOpen: boolean;
    watchedThreshold: number;
    resumeThresholdSeconds: number;
    seekStep: number;
    subtitlesDefault: boolean;
    subtitleFontScale: number;
  };
  transcode: {
    hwaccel: HwAccelMode;
    preset: string;
    segmentSeconds: number;
    cacheSizeGb: number;
    maxConcurrentJobs: number;
  };
  ui: { defaultSort: string; hideWatched: boolean; pageSize: number };
}

export type CodecKey = 'h264' | 'vp9' | 'av1' | 'hevc' | 'other';

export interface SizeSegment {
  codec: CodecKey;
  bytes: number;
  videos: number;
}

/** Disk use per channel and codec, for the size charts. */
export interface SizeBreakdown {
  totalBytes: number;
  totalVideos: number;
  channels: { id: string; title: string; bytes: number; videos: number; segments: SizeSegment[] }[];
  codecs: (SizeSegment & { label: string })[];
}

/** A channel's row on the home page, for the Home settings list. */
export interface HomeChannelDto {
  id: string;
  title: string;
  videoCount: number;
  enabled: boolean;
  pinned: boolean;
}

/** Progress of a library scan. */
export interface ScanStatus {
  running: boolean;
  full: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  phase: string;
  currentPath: string | null;
  channelsSeen: number;
  videosAdded: number;
  videosUpdated: number;
  videosRemoved: number;
  error: string | null;
}

/** The System section of Settings (GET /api/system). */
export interface SystemInfo {
  library: { videos: number; channels: number; watched: number; totalBytes: number };
  scan: ScanStatus;
  transcode: {
    status: string;
    ffmpegVersion: string | null;
    vaapiDevice: string | null;
    available: Record<'vaapi' | 'qsv' | 'nvenc', boolean>;
    tested: Record<'vaapi' | 'qsv' | 'nvenc', string>;
    details: Record<'vaapi' | 'qsv' | 'nvenc', string | null>;
    error: string | null;
    activeJobs: { video: string; rendition: string; startSegment: number; hardware: boolean }[];
  };
  cache: { bytes: number; limitBytes: number };
  paths: { media: string; data: string; cache: string };
  version: string;
}

// ------------------------------------------------------------------ urls ---

/** Addresses used directly by images, the video player and subtitle tracks. */
export const urls = {
  videoThumb: (id: string, width = 480) => `/api/images/video/${id}/thumb?w=${width}`,
  channelArt: (id: string, kind: 'poster' | 'banner' | 'fanart', width = 320) =>
    `/api/images/channel/${id}/${kind}?w=${width}`,
  original: (id: string) => `/api/stream/${id}/original`,
  hlsMaster: (id: string) => `/api/stream/${id}/master.m3u8`,
  hlsVariant: (id: string, rendition: string) => `/api/stream/${id}/${rendition}/index.m3u8`,
  hlsAudio: (id: string) => `/api/stream/${id}/audio/index.m3u8`,
  subtitle: (id: string, index: number) => `/api/stream/${id}/subtitles/${index}.vtt`,
};
