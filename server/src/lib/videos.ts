/*
 * videos.ts — reading the library: videos, channels, progress and the queue.
 *
 * Almost every database query about the library lives here, so the API
 * route files (routes/library.ts, routes/queue.ts, routes/stream.ts and
 * others) stay short. It covers:
 *   - access control: which channels and videos a user may see. Admins and
 *     "all channels" users see everything; others only the channels granted
 *     to them, plus videos lent out by someone's shared, non-strict playlist.
 *     Every query below goes through channelScope() or videoScope().
 *   - turning database rows into the objects the web app receives (mapVideo)
 *   - listing and searching videos, the home page rows, channel lists
 *   - saving watch progress and the "watched" flag
 *   - each user's play queue
 *   - library size statistics for Settings → Library
 * The tables themselves are defined in db.ts and filled by
 * library/scanner.ts. Playlists have their own file, lib/playlists.ts.
 */

import { db } from '../db.js';
import { settingsFor } from '../settings.js';

// ---- access control ---------------------------------------------------------

/** Who is asking: decides whose watch progress is joined in and which channels show. */
export interface Viewer {
  id: number;
  isAdmin: boolean;
  allChannels: boolean;
}

/**
 * SQL that limits `column` (a channel id) to the channels the viewer may see.
 * Administrators and "all channels" users see everything, including channels
 * added later; everyone else sees only what has been granted to them.
 */
export function channelScope(viewer: Viewer, column = 'v.channel_id'): string {
  if (viewer.isAdmin || viewer.allChannels) return '1 = 1';
  return `${column} IN (SELECT channel_id FROM user_channels WHERE user_id = @viewerId)`;
}

/** Whether a viewer may browse a channel. */
export function canSeeChannel(viewer: Viewer, channelId: string): boolean {
  if (viewer.isAdmin || viewer.allChannels) return true;
  return Boolean(
    db.prepare('SELECT 1 FROM user_channels WHERE user_id = ? AND channel_id = ?').get(viewer.id, channelId),
  );
}

/**
 * SQL that is true when the owner of playlist `pl` (joined as user `owner`)
 * may currently see video `v`. A playlist only ever lends out what its owner
 * has, so taking a channel away from the owner takes it out of the loan too.
 */
export function ownerSees(pl: string, owner: string, v: string): string {
  return `(${owner}.is_admin = 1 OR ${owner}.all_channels = 1 OR ${v}.channel_id IN
           (SELECT channel_id FROM user_channels WHERE user_id = ${pl}.user_id))`;
}

/**
 * Videos a playlist hands out regardless of channel access: what is in
 * someone else's shared playlist with "strict access permissions" off, as far
 * as its owner can see it. Unsharing it, or turning strict back on, takes that
 * away. Never the viewer's own playlists, or a channel taken away from them
 * would stay playable through any playlist they had already put it in.
 */
const GRANTED_VIDEOS = `
  SELECT gi.video_id FROM playlist_items gi
    JOIN playlists gp ON gp.id = gi.playlist_id
    JOIN users gu ON gu.id = gp.user_id
    JOIN videos gv ON gv.id = gi.video_id
   WHERE gp.strict = 0 AND gp.shared = 1 AND gp.user_id <> @viewerId
     AND ${ownerSees('gp', 'gu', 'gv')}`;

/**
 * Like channelScope, but for opening and playing a single video, which a
 * non-strict playlist can allow outside the viewer's channels. Browsing — the
 * home page, all videos, search, channel pages — sticks to channelScope, so
 * such videos are only reachable through the playlist (and the viewer's own
 * history and queue once they have played one).
 */
export function videoScope(viewer: Viewer): string {
  if (viewer.isAdmin || viewer.allChannels) return '1 = 1';
  return `(${channelScope(viewer)} OR v.id IN (${GRANTED_VIDEOS}))`;
}

/** Whether a viewer may open and play a video. */
export function canSeeVideo(viewer: Viewer, videoId: string): boolean {
  if (viewer.isAdmin || viewer.allChannels) return true;
  return Boolean(
    db.prepare(`SELECT 1 FROM videos v WHERE v.id = @id AND ${videoScope(viewer)}`).get({ id: videoId, viewerId: viewer.id }),
  );
}

/** Channel artwork: for a viewer's own channels, and for any a playlist granted a video from. */
export function canSeeChannelArt(viewer: Viewer, channelId: string): boolean {
  if (canSeeChannel(viewer, channelId)) return true;
  return Boolean(
    db
      .prepare(`SELECT 1 FROM videos v WHERE v.channel_id = @channelId AND v.id IN (${GRANTED_VIDEOS}) LIMIT 1`)
      .get({ channelId, viewerId: viewer.id }),
  );
}

// ---- turning rows into what the web app receives ----------------------------

/** A subtitle file found next to a video. */
export interface SubtitleTrack {
  index: number;
  lang: string;
  label: string;
  ext: string;
  file: string;
}

/** A row of the videos table, plus the joined channel name and this viewer's progress. */
export interface VideoRow {
  id: string;
  channel_id: string;
  path: string;
  rel_path: string;
  season: string | null;
  title: string;
  plot: string | null;
  aired: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  container: string | null;
  bitrate: number | null;
  size: number | null;
  thumb: string | null;
  subtitles: string | null;
  youtube_id?: string | null;
  chapters?: string | null;
  added_at: number;
  channel_title?: string;
  p_position?: number | null;
  p_watched?: number | null;
}

/** Readable names for the language codes in subtitle file names. */
const LANG_NAMES: Record<string, string> = {
  en: 'English',
  'en-gb': 'English (UK)',
  'en-us': 'English (US)',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  pt: 'Portuguese',
  ru: 'Russian',
  zh: 'Chinese',
  und: 'Subtitles',
};

/** The subtitle list stored as JSON by the scanner, numbered and labelled. */
export function parseSubtitles(raw: string | null): SubtitleTrack[] {
  if (!raw) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry: any, index: number) => {
    const lang = String(entry?.lang ?? 'und');
    return {
      index,
      lang,
      label: LANG_NAMES[lang.toLowerCase()] ?? lang.toUpperCase(),
      ext: String(entry?.ext ?? 'srt'),
      file: String(entry?.file ?? ''),
    };
  });
}

/** A video as the web app receives it (see VideoDto in web/src/lib/api.ts). */
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
  chapters: { start: number; end: number; title: string; kind: 'chapter' | 'sponsor' }[];
  progress: { position: number; watched: boolean };
}

/** The chapter list stored as JSON by the scanner. */
function parseChapters(raw: string | null | undefined): VideoDto['chapters'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `viewer` decides what is safe to show: where a file lives on the server is
 * only for administrators, so everyone else gets the path left empty.
 */
export function mapVideo(row: VideoRow, viewer?: Viewer): VideoDto {
  const position = Number(row.p_position ?? 0) || 0;
  const showPath = viewer?.isAdmin === true;
  return {
    id: row.id,
    title: row.title,
    plot: row.plot,
    aired: row.aired,
    addedAt: row.added_at,
    duration: row.duration,
    width: row.width,
    height: row.height,
    vcodec: row.vcodec,
    acodec: row.acodec,
    container: row.container,
    size: row.size,
    season: row.season,
    path: showPath ? row.path : '',
    relPath: showPath ? row.rel_path : '',
    channelId: row.channel_id,
    channelTitle: row.channel_title ?? '',
    // Without a thumbnail file we can still extract a frame on demand, so long
    // as ffprobe managed to read the video at all.
    hasThumb: Boolean(row.thumb) || Boolean(row.duration),
    subtitles: parseSubtitles(row.subtitles).map(({ index, lang, label }) => ({ index, lang, label })),
    youtubeId: row.youtube_id ?? null,
    chapters: parseChapters(row.chapters),
    progress: { position, watched: Boolean(row.p_watched) },
  };
}

// ---- listing videos ---------------------------------------------------------

/** The start of every video query: the video, its channel's name and this viewer's progress. */
const SELECT_BASE = `
  SELECT v.*, c.title AS channel_title,
         p.position AS p_position, p.watched AS p_watched
    FROM videos v
    JOIN channels c ON c.id = v.channel_id
    LEFT JOIN progress p ON p.video_id = v.id AND p.user_id = @viewerId
`;

export type SortKey = 'date_desc' | 'date_asc' | 'title_asc' | 'title_desc' | 'added_desc' | 'added_asc';

/** The SQL ORDER BY for each sort choice. */
function orderBy(sort: SortKey): string {
  switch (sort) {
    case 'date_asc':
      return 'v.aired ASC, v.title COLLATE NOCASE ASC';
    case 'title_asc':
      return 'v.title COLLATE NOCASE ASC';
    case 'title_desc':
      return 'v.title COLLATE NOCASE DESC';
    case 'added_desc':
      return 'v.added_at DESC, v.aired DESC';
    case 'added_asc':
      return 'v.added_at ASC, v.aired ASC';
    case 'date_desc':
    default:
      return 'v.aired DESC, v.title COLLATE NOCASE ASC';
  }
}

/** Filters for a video list: channel, search text, sort, watched state and paging. */
export interface QueryOptions {
  channelId?: string;
  search?: string;
  sort?: SortKey;
  watched?: 'all' | 'watched' | 'unwatched';
  limit?: number;
  offset?: number;
}

/** A page of videos for the browse pages, plus how many match in total. */
export function queryVideos(viewer: Viewer, options: QueryOptions): { items: VideoDto[]; total: number } {
  const where: string[] = [channelScope(viewer)];
  const params: Record<string, unknown> = { viewerId: viewer.id };

  if (options.channelId) {
    where.push('v.channel_id = @channelId');
    params.channelId = options.channelId;
  }

  if (options.search && options.search.trim()) {
    // % and _ are LIKE wildcards; escaped, so a search for "100%" means exactly that.
    where.push(
      "(v.title LIKE @search ESCAPE '\\' OR v.plot LIKE @search ESCAPE '\\' OR c.title LIKE @search ESCAPE '\\')",
    );
    params.search = `%${options.search.trim().replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
  }

  if (options.watched === 'watched') where.push('COALESCE(p.watched, 0) = 1');
  if (options.watched === 'unwatched') where.push('COALESCE(p.watched, 0) = 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, options.limit ?? settingsFor(viewer.id).ui.pageSize));
  const offset = Math.max(0, options.offset ?? 0);

  // The total, for "load more", then the page itself.
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM videos v
         JOIN channels c ON c.id = v.channel_id
         LEFT JOIN progress p ON p.video_id = v.id AND p.user_id = @viewerId
       ${whereSql}`,
    )
    .get(params) as { n: number };

  const rows = db
    .prepare(`${SELECT_BASE} ${whereSql} ORDER BY ${orderBy(options.sort ?? 'date_desc')} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as VideoRow[];

  return { items: rows.map((row) => mapVideo(row, viewer)), total: countRow.n };
}

/** A video the viewer is allowed to see, or undefined — never someone else's. */
export function getVideo(viewer: Viewer, id: string): VideoRow | undefined {
  return db
    .prepare(`${SELECT_BASE} WHERE v.id = @id AND ${videoScope(viewer)}`)
    .get({ id, viewerId: viewer.id }) as VideoRow | undefined;
}

// ---- home page rows ---------------------------------------------------------

/** Videos started but not finished, most recently watched first. */
export function continueWatching(viewer: Viewer, limit: number): VideoDto[] {
  const settings = settingsFor(viewer.id);
  const rows = db
    .prepare(
      `${SELECT_BASE}
        WHERE ${videoScope(viewer)}
          AND p.position > @minPosition
          AND COALESCE(p.watched, 0) = 0
          AND (v.duration IS NULL OR p.position < v.duration * @threshold)
        ORDER BY p.updated_at DESC
        LIMIT @limit`,
    )
    .all({
      minPosition: settings.playback.resumeThresholdSeconds,
      threshold: settings.playback.watchedThreshold,
      limit,
      viewerId: viewer.id,
    }) as VideoRow[];
  return rows.map((row) => mapVideo(row, viewer));
}

/** The newest downloads. */
export function recentlyAdded(viewer: Viewer, limit: number, hideWatched: boolean): VideoDto[] {
  const rows = db
    .prepare(
      `${SELECT_BASE}
        WHERE ${channelScope(viewer)}
        ${hideWatched ? 'AND COALESCE(p.watched, 0) = 0' : ''}
        ORDER BY v.added_at DESC, v.aired DESC
        LIMIT @limit`,
    )
    .all({ limit, viewerId: viewer.id }) as VideoRow[];
  return rows.map((row) => mapVideo(row, viewer));
}

/** A random handful of never-started videos. */
export function rediscover(viewer: Viewer, limit: number): VideoDto[] {
  // Older, unwatched and untouched — the stuff buried at the bottom of a channel.
  const rows = db
    .prepare(
      `${SELECT_BASE}
        WHERE ${channelScope(viewer)}
          AND COALESCE(p.watched, 0) = 0 AND COALESCE(p.position, 0) = 0
        ORDER BY RANDOM()
        LIMIT @limit`,
    )
    .all({ limit, viewerId: viewer.id }) as VideoRow[];
  return rows.map((row) => mapVideo(row, viewer));
}

// ---- channels ---------------------------------------------------------------

/** A channel as the web app receives it, with counts for this viewer. */
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
  /** Changes when an uploaded image does; part of the image's address, so browsers refetch it. */
  artVersion: number;
}

/** Channels with their video counts, newest upload and this viewer's unwatched count. */
const CHANNEL_SELECT = `
  SELECT c.id, c.title, c.plot, c.poster, c.banner, c.fanart,
         COALESCE(e.art_version, 0) AS art_version,
         COUNT(v.id) AS video_count,
         MAX(v.aired) AS latest_aired,
         SUM(CASE WHEN COALESCE(p.watched, 0) = 0 THEN 1 ELSE 0 END) AS unwatched_count
    FROM channels c
    LEFT JOIN channel_edits e ON e.channel_id = c.id
    LEFT JOIN videos v ON v.channel_id = c.id
    LEFT JOIN progress p ON p.video_id = v.id AND p.user_id = @viewerId
`;

/** A channel row into the shape the web app receives. */
function mapChannel(row: any): ChannelDto {
  return {
    id: row.id,
    title: row.title,
    plot: row.plot ?? null,
    videoCount: Number(row.video_count) || 0,
    latestAired: row.latest_aired ?? null,
    unwatchedCount: Number(row.unwatched_count) || 0,
    hasPoster: Boolean(row.poster),
    hasBanner: Boolean(row.banner),
    hasFanart: Boolean(row.fanart),
    artVersion: Number(row.art_version) || 0,
  };
}

/** The channels a viewer may see, by name or by latest upload. */
export function listChannels(viewer: Viewer, order: 'name' | 'recent' = 'name'): ChannelDto[] {
  const sql = `${CHANNEL_SELECT} WHERE ${channelScope(viewer, 'c.id')} GROUP BY c.id ORDER BY ${
    order === 'recent' ? 'latest_aired DESC, c.title COLLATE NOCASE ASC' : 'c.title COLLATE NOCASE ASC'
  }`;
  return (db.prepare(sql).all({ viewerId: viewer.id }) as any[]).map(mapChannel);
}

/** One channel, if the viewer may see it. */
export function getChannel(viewer: Viewer, id: string): ChannelDto | undefined {
  const row = db
    .prepare(`${CHANNEL_SELECT} WHERE c.id = @id AND ${channelScope(viewer, 'c.id')} GROUP BY c.id`)
    .get({ id, viewerId: viewer.id }) as any;
  return row ? mapChannel(row) : undefined;
}

/** Every channel, for the administrator's access picker. */
export function allChannelNames(): { id: string; title: string }[] {
  return db.prepare('SELECT id, title FROM channels ORDER BY title COLLATE NOCASE ASC').all() as {
    id: string;
    title: string;
  }[];
}

/** The file path of a channel's poster, banner or background, if it has one. */
export function channelArtwork(id: string, kind: 'poster' | 'banner' | 'fanart'): string | null {
  const row = db.prepare(`SELECT ${kind} AS file FROM channels WHERE id = ?`).get(id) as
    | { file: string | null }
    | undefined;
  return row?.file ?? null;
}

// ---- watch progress ---------------------------------------------------------

/**
 * Stores how far into a video someone is; passing the "watched" threshold
 * marks it watched, and it stays watched even if they later rewind.
 */
export function saveProgress(userId: number, videoId: string, position: number, duration: number): void {
  const settings = settingsFor(userId);
  const watched = duration > 0 && position >= duration * settings.playback.watchedThreshold ? 1 : 0;
  const now = Date.now();
  db.prepare(
    `INSERT INTO progress (user_id, video_id, position, duration, watched, updated_at, watched_at)
     VALUES (@userId, @videoId, @position, @duration, @watched, @now, @watchedAt)
     ON CONFLICT(user_id, video_id) DO UPDATE SET
       position = excluded.position,
       duration = excluded.duration,
       watched_at = CASE WHEN progress.watched = 0 AND excluded.watched = 1 THEN excluded.updated_at
                         ELSE progress.watched_at END,
       watched = MAX(progress.watched, excluded.watched),
       updated_at = excluded.updated_at`,
  ).run({ userId, videoId, position, duration, watched, now, watchedAt: watched ? now : null });
}

/** Marks a video watched or unwatched by hand, resetting the position to the start. */
export function setWatched(userId: number, videoId: string, watched: boolean, duration: number | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO progress (user_id, video_id, position, duration, watched, updated_at, watched_at)
     VALUES (@userId, @videoId, @position, @duration, @watched, @now, @watchedAt)
     ON CONFLICT(user_id, video_id) DO UPDATE SET
       watched_at = CASE WHEN excluded.watched = 0 THEN NULL
                         WHEN progress.watched = 0 THEN excluded.updated_at
                         ELSE progress.watched_at END,
       watched = excluded.watched,
       position = excluded.position,
       updated_at = excluded.updated_at`,
  ).run({
    userId,
    videoId,
    position: 0,
    duration: duration ?? 0,
    watched: watched ? 1 : 0,
    now,
    watchedAt: watched ? now : null,
  });
}

/** When each of a user's watched videos was marked watched, where that is known. */
export function watchedTimes(userId: number): Map<string, number> {
  const rows = db
    .prepare('SELECT video_id, watched_at FROM progress WHERE user_id = ? AND watched = 1 AND watched_at IS NOT NULL')
    .all(userId) as { video_id: string; watched_at: number }[];
  return new Map(rows.map((row) => [row.video_id, row.watched_at]));
}

// ---------------------------------------------------------------- queue ----

// Queue and playlist listings filter by channel access as well: a channel
// taken away from someone quietly drops out of their lists rather than
// leaving entries behind that would only fail to play.

/** A user's queue, in order. */
export function listQueue(viewer: Viewer): VideoDto[] {
  const rows = db
    .prepare(
      `${SELECT_BASE} JOIN queue q ON q.video_id = v.id AND q.user_id = @viewerId
        WHERE ${videoScope(viewer)}
        ORDER BY q.position ASC`,
    )
    .all({ viewerId: viewer.id }) as VideoRow[];
  return rows.map((row) => mapVideo(row, viewer));
}

/** The most videos a queue may hold. */
export const QUEUE_MAX = 5000;

/** False when the queue is already full. */
export function addToQueue(userId: number, videoId: string): boolean {
  const next = db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n, COUNT(*) AS count FROM queue WHERE user_id = ?')
    .get(userId) as { n: number; count: number };
  if (next.count >= QUEUE_MAX) return false;
  db.prepare(
    `INSERT INTO queue (user_id, video_id, position, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, video_id) DO NOTHING`,
  ).run(userId, videoId, next.n, Date.now());
  return true;
}

/** Takes one video out of the queue. */
export function removeFromQueue(userId: number, videoId: string): void {
  db.prepare('DELETE FROM queue WHERE user_id = ? AND video_id = ?').run(userId, videoId);
}

/** Empties the queue. */
export function clearQueue(userId: number): void {
  db.prepare('DELETE FROM queue WHERE user_id = ?').run(userId);
}

/** Swaps a video with its neighbour, so the list can be nudged into order. */
export function moveInQueue(userId: number, videoId: string, direction: -1 | 1): void {
  const current = db
    .prepare('SELECT position FROM queue WHERE user_id = ? AND video_id = ?')
    .get(userId, videoId) as { position: number } | undefined;
  if (!current) return;

  const neighbour = db
    .prepare(
      direction < 0
        ? 'SELECT video_id, position FROM queue WHERE user_id = ? AND position < ? ORDER BY position DESC LIMIT 1'
        : 'SELECT video_id, position FROM queue WHERE user_id = ? AND position > ? ORDER BY position ASC LIMIT 1',
    )
    .get(userId, current.position) as { video_id: string; position: number } | undefined;
  if (!neighbour) return;

  const swap = db.transaction(() => {
    const update = db.prepare('UPDATE queue SET position = ? WHERE user_id = ? AND video_id = ?');
    update.run(neighbour.position, userId, videoId);
    update.run(current.position, userId, neighbour.video_id);
  });
  swap();
}

/**
 * Puts the queue in exactly the given order. Ids the client sent that are not
 * in the queue are ignored, and anything it left out keeps its place after
 * the ones it did send — so a stale client cannot lose entries.
 */
export function reorderQueue(userId: number, ids: string[]): void {
  const existing = (
    db.prepare('SELECT video_id FROM queue WHERE user_id = ? ORDER BY position ASC').all(userId) as {
      video_id: string;
    }[]
  ).map((row) => row.video_id);
  const order = mergeOrder(existing, ids);
  const update = db.prepare('UPDATE queue SET position = ? WHERE user_id = ? AND video_id = ?');
  db.transaction(() => order.forEach((id, index) => update.run(index + 1, userId, id)))();
}

/** `wanted` first (only ids that exist, once each), then whatever it missed. */
export function mergeOrder(existing: string[], wanted: unknown): string[] {
  const known = new Set(existing);
  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(wanted)) {
    for (const raw of wanted) {
      const id = String(raw);
      if (known.has(id) && !seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
  }
  for (const id of existing) if (!seen.has(id)) out.push(id);
  return out;
}

// ------------------------------------------------------------ size stats ---

/** Fixed order, so a codec keeps the same colour no matter which channel is filtered. */
export const CODEC_ORDER = ['h264', 'vp9', 'av1', 'hevc', 'other'] as const;
export type CodecKey = (typeof CODEC_ORDER)[number];

export const CODEC_LABELS: Record<CodecKey, string> = {
  h264: 'H.264',
  vp9: 'VP9',
  av1: 'AV1',
  hevc: 'HEVC',
  other: 'Other',
};

/** Groups ffprobe's codec names into the few the size chart shows. */
function codecKey(raw: string | null): CodecKey {
  const value = (raw ?? '').toLowerCase();
  if (value === 'h264' || value === 'avc' || value === 'avc1') return 'h264';
  if (value === 'vp9' || value === 'vp09') return 'vp9';
  if (value === 'av1' || value === 'av01') return 'av1';
  if (value === 'hevc' || value === 'h265' || value === 'hvc1') return 'hevc';
  return 'other';
}

/** How much space one codec takes up. */
export interface SizeSegment {
  codec: CodecKey;
  bytes: number;
  videos: number;
}

/** How much space one channel takes, split by codec. */
export interface ChannelSize {
  id: string;
  title: string;
  bytes: number;
  videos: number;
  segments: SizeSegment[];
}

/** The whole library's size, per channel and per codec. */
export interface SizeBreakdown {
  totalBytes: number;
  totalVideos: number;
  channels: ChannelSize[];
  codecs: (SizeSegment & { label: string })[];
}

/**
 * Bytes per channel, split by codec. The scanner already stores every video's
 * size and codec, so this is one GROUP BY — no filesystem access at all.
 */
export function sizeBreakdown(): SizeBreakdown {
  const rows = db
    .prepare(
      `SELECT c.id AS channel_id, c.title AS channel_title,
              v.vcodec AS vcodec,
              COUNT(v.id) AS videos,
              COALESCE(SUM(v.size), 0) AS bytes
         FROM channels c
         LEFT JOIN videos v ON v.channel_id = c.id
        GROUP BY c.id, v.vcodec`,
    )
    .all() as {
    channel_id: string;
    channel_title: string;
    vcodec: string | null;
    videos: number;
    bytes: number;
  }[];

  const channels = new Map<string, ChannelSize & { byCodec: Map<CodecKey, SizeSegment> }>();
  const codecs = new Map<CodecKey, SizeSegment>();
  let totalBytes = 0;
  let totalVideos = 0;

  // Add each (channel, codec) group to its channel's total and to the library-wide total.
  for (const row of rows) {
    if (!row.videos) continue;
    const codec = codecKey(row.vcodec);
    const bytes = Number(row.bytes) || 0;
    const videos = Number(row.videos) || 0;

    let channel = channels.get(row.channel_id);
    if (!channel) {
      channel = {
        id: row.channel_id,
        title: row.channel_title,
        bytes: 0,
        videos: 0,
        segments: [],
        byCodec: new Map(),
      };
      channels.set(row.channel_id, channel);
    }
    channel.bytes += bytes;
    channel.videos += videos;
    const seg = channel.byCodec.get(codec) ?? { codec, bytes: 0, videos: 0 };
    seg.bytes += bytes;
    seg.videos += videos;
    channel.byCodec.set(codec, seg);

    const total = codecs.get(codec) ?? { codec, bytes: 0, videos: 0 };
    total.bytes += bytes;
    total.videos += videos;
    codecs.set(codec, total);

    totalBytes += bytes;
    totalVideos += videos;
  }

  // Biggest channels first, each with its codecs in the fixed order.
  const channelList: ChannelSize[] = Array.from(channels.values())
    .map(({ byCodec, ...channel }) => ({
      ...channel,
      segments: CODEC_ORDER.map((codec) => byCodec.get(codec)).filter(
        (seg): seg is SizeSegment => Boolean(seg && seg.bytes > 0),
      ),
    }))
    .filter((channel) => channel.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    totalVideos,
    channels: channelList,
    codecs: CODEC_ORDER.map((codec) => codecs.get(codec))
      .filter((seg): seg is SizeSegment => Boolean(seg && seg.bytes > 0))
      .map((seg) => ({ ...seg, label: CODEC_LABELS[seg.codec] })),
  };
}

/** Headline numbers for the library page: videos, channels, watched and total size. */
export function libraryStats(viewer: Viewer): {
  videos: number;
  channels: number;
  watched: number;
  totalBytes: number;
} {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM videos v WHERE ${channelScope(viewer)}) AS videos,
              (SELECT COUNT(*) FROM channels c WHERE ${channelScope(viewer, 'c.id')}) AS channels,
              (SELECT COUNT(*) FROM progress WHERE user_id = @viewerId AND watched = 1) AS watched,
              (SELECT COALESCE(SUM(size), 0) FROM videos v WHERE ${channelScope(viewer)}) AS total_bytes`,
    )
    .get({ viewerId: viewer.id }) as any;
  return {
    videos: Number(row.videos) || 0,
    channels: Number(row.channels) || 0,
    watched: Number(row.watched) || 0,
    totalBytes: Number(row.total_bytes) || 0,
  };
}
