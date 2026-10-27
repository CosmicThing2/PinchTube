import { db } from './db.js';
import { config } from './config.js';

export type HomeRowId = 'continue' | 'recent' | 'random' | 'channels';

export type CardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export const CARD_SIZES: CardSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

/** Older installs stored three sizes under different names. */
const LEGACY_CARD_SIZES: Record<string, CardSize> = {
  small: 'sm',
  medium: 'md',
  large: 'lg',
};

export interface HomeRow {
  id: HomeRowId;
  enabled: boolean;
  title: string;
  limit: number;
  /** Only meaningful for the "channels" row type. */
  videosPerChannel?: number;
}

/**
 * Per-channel control over the home page rows. Visibility and ordering are
 * deliberately separate ideas: `enabled` decides whether the row appears at all,
 * while `pinned` lifts it above the channels that just follow `channelOrder`.
 * Array order is the pin order.
 */
export interface ChannelRow {
  id: string;
  enabled: boolean;
  pinned: boolean;
}

export type HwAccelMode = 'auto' | 'vaapi' | 'qsv' | 'nvenc' | 'none';

export const HWACCEL_MODES: HwAccelMode[] = ['auto', 'vaapi', 'qsv', 'nvenc', 'none'];

/** The web app holds the actual colours; the server only checks the name. */
const ACCENT_PRESETS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink'];

/** Sections shared by the whole server, which only an administrator may change. */
export const GLOBAL_SECTIONS = ['library', 'transcode'] as const;
/** Sections every user keeps their own copy of. */
export const PERSONAL_SECTIONS = ['appearance', 'home', 'playback', 'ui'] as const;

export interface AppSettings {
  library: {
    mediaPath: string;
    scanIntervalMinutes: number;
    watcherEnabled: boolean;
    /** Needed when the media folder is on NFS/SMB, where inotify events never fire. */
    watcherUsePolling: boolean;
  };
  appearance: {
    theme: 'system' | 'dark' | 'light';
    /** A preset name from ACCENT_PRESETS, or a custom colour as #rrggbb. */
    accent: string;
    /** The tint for SponsorBlock segments, in the same form as the accent. */
    sponsorColor: string;
    cardSize: CardSize;
    /** Fade the thumbnail of anything already watched. */
    dimWatched: boolean;
    /** 'auto' means a grid on a wide screen and a compact list on a phone. */
    channelLayout: 'auto' | 'grid' | 'list';
    /** Slide the side menu in and out rather than having it just appear. */
    animateMenu: boolean;
  };
  home: {
    rows: HomeRow[];
    channelOrder: 'name' | 'recent';
    /**
     * Explicit ordering and on/off state for individual channel rows. Channels
     * missing from this list are shown after the listed ones, so a newly added
     * channel appears on its own without needing to be configured first.
     */
    channelRows: ChannelRow[];
  };
  playback: {
    defaultQualityWifi: string;
    defaultQualityCellular: string;
    maxQuality: string;
    /** Quality used for every video played from the queue. */
    queueQuality: string;
    /**
     * What "next" does to the video being left while playing the queue:
     * mark it watched and drop it from the queue always, past the watched
     * threshold, past a custom percentage, only if finished, or never.
     */
    queueAdvance: 'always' | 'threshold' | 'custom' | 'complete' | 'never';
    /** The percentage used when queueAdvance is 'custom'. */
    queueAdvancePercent: number;
    /** The large play/pause button in the middle of the picture. Off by default. */
    centerPlayButton: boolean;
    /** Seconds to fade the sound out over when pausing; 0 pauses instantly. */
    fadeOutSeconds: number;
    /** Offer a "Skip sponsor" button during SponsorBlock-marked segments. */
    sponsorSkipPrompt: boolean;
    /** Jump over sponsor segments without asking; the skip button is then unused. */
    sponsorAutoSkip: boolean;
    /** Fullscreen touch gestures: right-side swipe for volume, left for brightness. */
    gestureVolume: boolean;
    gestureBrightness: boolean;
    autoplayNext: boolean;
    /** Start playing as soon as a video page is opened. */
    autoplayOnOpen: boolean;
    watchedThreshold: number;
    resumeThresholdSeconds: number;
    seekStep: number;
    subtitlesDefault: boolean;
    /** Subtitle size as a percentage of the standard size. */
    subtitleFontScale: number;
  };
  transcode: {
    /**
     * 'vaapi' covers AMD and Intel through the kernel's render node, 'qsv' is
     * Intel Quick Sync, 'nvenc' is NVIDIA. 'auto' picks the first that passed
     * the start-up test, trying NVIDIA, then VAAPI, then Quick Sync.
     */
    hwaccel: HwAccelMode;
    preset: string;
    segmentSeconds: number;
    cacheSizeGb: number;
    maxConcurrentJobs: number;
  };
  ui: {
    defaultSort: 'date_desc' | 'date_asc' | 'title_asc' | 'added_desc';
    hideWatched: boolean;
    pageSize: number;
  };
}

export const defaultSettings: AppSettings = {
  library: {
    mediaPath: config.defaultMediaDir,
    scanIntervalMinutes: 60,
    watcherEnabled: true,
    watcherUsePolling: false,
  },
  appearance: {
    theme: 'system',
    accent: 'red',
    sponsorColor: 'green',
    cardSize: 'md',
    dimWatched: true,
    channelLayout: 'auto',
    animateMenu: true,
  },
  home: {
    rows: [
      { id: 'continue', enabled: true, title: 'Continue watching', limit: 20 },
      { id: 'recent', enabled: true, title: 'Recently added', limit: 20 },
      { id: 'random', enabled: true, title: 'Rediscover', limit: 20 },
      { id: 'channels', enabled: true, title: 'Channels', limit: 20, videosPerChannel: 15 },
    ],
    channelOrder: 'recent',
    channelRows: [],
  },
  playback: {
    defaultQualityWifi: 'original',
    defaultQualityCellular: '720p',
    maxQuality: 'original',
    queueQuality: 'auto',
    queueAdvance: 'always',
    queueAdvancePercent: 80,
    centerPlayButton: false,
    fadeOutSeconds: 0,
    sponsorSkipPrompt: true,
    sponsorAutoSkip: false,
    gestureVolume: true,
    gestureBrightness: true,
    autoplayNext: false,
    autoplayOnOpen: true,
    watchedThreshold: 0.9,
    resumeThresholdSeconds: 15,
    seekStep: 10,
    subtitlesDefault: false,
    subtitleFontScale: 125,
  },
  transcode: {
    hwaccel: 'auto',
    preset: 'veryfast',
    segmentSeconds: 4,
    cacheSizeGb: 20,
    maxConcurrentJobs: 3,
  },
  ui: {
    defaultSort: 'date_desc',
    hideWatched: false,
    pageSize: 48,
  },
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive merge that only accepts keys already present in the defaults, and
 * only values of the same kind as the default (a string for a string, a list
 * for a list). Inherited names such as __proto__ or constructor never match.
 */
function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return base;
  const out: Record<string, any> = { ...(base as any) };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
    const current = (base as any)[key];
    if (isPlainObject(current)) {
      out[key] = mergeKnown(current, value);
    } else if (Array.isArray(current)) {
      if (Array.isArray(value)) out[key] = value;
    } else if (value !== undefined && value !== null && typeof value === typeof current) {
      out[key] = value;
    }
  }
  return out as T;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function pick(source: any, sections: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(source)) return out;
  for (const section of sections) if (section in source) out[section] = source[section];
  return out;
}

let globalCache: AppSettings | null = null;
const userCache = new Map<number, AppSettings>();

/**
 * The server-wide sections (library, transcoding). The personal sections in
 * the result are just the defaults — anything about a particular viewer has
 * to come from settingsFor().
 */
export function getSettings(): AppSettings {
  if (globalCache) return globalCache;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
    | { value: string }
    | undefined;
  globalCache = mergeKnown(structuredClone(defaultSettings), pick(parseJson(row?.value), GLOBAL_SECTIONS));
  return globalCache;
}

/** Everything one user sees: the global sections plus their own personal ones. */
export function settingsFor(userId: number): AppSettings {
  const hit = userCache.get(userId);
  if (hit) return hit;
  const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId) as
    | { settings: string | null }
    | undefined;
  const merged = mergeKnown(structuredClone(getSettings()), pick(parseJson(row?.settings), PERSONAL_SECTIONS));
  clampSettings(merged);
  userCache.set(userId, merged);
  return merged;
}

/**
 * Applies a patch for one user. Personal sections always land on their own
 * account; the global sections are only touched when `admin` is true and are
 * silently ignored otherwise (the route rejects that case before we get here).
 */
export function saveSettings(userId: number, patch: unknown, admin: boolean): AppSettings {
  const allowed = pick(patch, admin ? [...GLOBAL_SECTIONS, ...PERSONAL_SECTIONS] : PERSONAL_SECTIONS);
  const next = mergeKnown(structuredClone(settingsFor(userId)), allowed);
  next.home.rows = normaliseRows((allowed as any)?.home?.rows ?? next.home.rows);
  next.home.channelRows = normaliseChannelRows(
    (allowed as any)?.home?.channelRows ?? next.home.channelRows,
  );
  clampSettings(next);

  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(
    JSON.stringify(pick(next, PERSONAL_SECTIONS)),
    userId,
  );
  if (admin && GLOBAL_SECTIONS.some((section) => section in allowed)) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('app', JSON.stringify(pick(next, GLOBAL_SECTIONS)));
    invalidateSettingsCache();
  } else {
    userCache.delete(userId);
  }
  return settingsFor(userId);
}

/** The settings a user may see: non-administrators get only their own sections. */
export function visibleSettings(settings: AppSettings, admin: boolean): Partial<AppSettings> {
  return admin ? settings : (pick(settings, PERSONAL_SECTIONS) as Partial<AppSettings>);
}

export function forgetUserSettings(userId: number): void {
  userCache.delete(userId);
}

/** Rows arrive from the client as a re-ordered list; keep only known ids, keep order. */
function normaliseRows(rows: unknown): HomeRow[] {
  if (!Array.isArray(rows)) return defaultSettings.home.rows;
  const valid: HomeRowId[] = ['continue', 'recent', 'random', 'channels'];
  const seen = new Set<string>();
  const out: HomeRow[] = [];
  for (const raw of rows) {
    if (!isPlainObject(raw)) continue;
    const id = raw.id as HomeRowId;
    if (!valid.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const fallback = defaultSettings.home.rows.find((r) => r.id === id)!;
    out.push({
      id,
      enabled: raw.enabled !== false,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fallback.title,
      limit: clampInt(raw.limit, 4, 100, fallback.limit),
      videosPerChannel:
        id === 'channels'
          ? clampInt(raw.videosPerChannel, 4, 50, fallback.videosPerChannel ?? 15)
          : undefined,
    });
  }
  // Any row the client omitted keeps existing behaviour by being appended, disabled.
  for (const fallback of defaultSettings.home.rows) {
    if (!seen.has(fallback.id)) out.push({ ...fallback, enabled: false });
  }
  return out;
}

/** Channel rows are free-form ids, so just keep well-formed, de-duplicated entries. */
function normaliseChannelRows(rows: unknown): ChannelRow[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: ChannelRow[] = [];
  for (const raw of rows) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, enabled: raw.enabled !== false, pinned: raw.pinned === true });
  }
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function colourSetting(value: unknown, fallback: string): string {
  const colour = String(value ?? '').toLowerCase();
  return ACCENT_PRESETS.includes(colour) || /^#[0-9a-f]{6}$/.test(colour) ? colour : fallback;
}

function clampSettings(s: AppSettings): void {
  s.library.scanIntervalMinutes = clampInt(s.library.scanIntervalMinutes, 1, 10080, 60);
  s.playback.watchedThreshold = Math.min(0.99, Math.max(0.5, Number(s.playback.watchedThreshold) || 0.9));
  s.playback.resumeThresholdSeconds = clampInt(s.playback.resumeThresholdSeconds, 0, 600, 15);
  s.playback.seekStep = clampInt(s.playback.seekStep, 5, 60, 10);
  s.playback.fadeOutSeconds = clampInt(s.playback.fadeOutSeconds, 0, 3, 0);
  s.playback.queueAdvancePercent = clampInt(s.playback.queueAdvancePercent, 1, 100, 80);
  if (!['always', 'threshold', 'custom', 'complete', 'never'].includes(s.playback.queueAdvance)) {
    s.playback.queueAdvance = 'always';
  }
  s.playback.subtitleFontScale = clampInt(s.playback.subtitleFontScale, 75, 300, 125);
  s.transcode.segmentSeconds = clampInt(s.transcode.segmentSeconds, 2, 10, 4);
  s.transcode.cacheSizeGb = Math.min(2000, Math.max(1, Number(s.transcode.cacheSizeGb) || 20));
  s.transcode.maxConcurrentJobs = clampInt(s.transcode.maxConcurrentJobs, 1, 10, 3);
  s.ui.pageSize = clampInt(s.ui.pageSize, 12, 200, 48);
  if (!['system', 'dark', 'light'].includes(s.appearance.theme)) s.appearance.theme = 'system';

  const size = s.appearance.cardSize as string;
  if (LEGACY_CARD_SIZES[size]) s.appearance.cardSize = LEGACY_CARD_SIZES[size];
  if (!CARD_SIZES.includes(s.appearance.cardSize)) s.appearance.cardSize = 'md';

  if (!['auto', 'grid', 'list'].includes(s.appearance.channelLayout)) {
    s.appearance.channelLayout = 'auto';
  }
  s.appearance.animateMenu = s.appearance.animateMenu !== false;
  s.appearance.accent = colourSetting(s.appearance.accent, 'red');
  s.appearance.sponsorColor = colourSetting(s.appearance.sponsorColor, 'green');
  s.playback.sponsorAutoSkip = s.playback.sponsorAutoSkip === true;
  if (!HWACCEL_MODES.includes(s.transcode.hwaccel)) s.transcode.hwaccel = 'auto';
}

export function invalidateSettingsCache(): void {
  globalCache = null;
  userCache.clear();
}
