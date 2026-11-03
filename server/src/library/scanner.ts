/*
 * scanner.ts — walks the media folder and keeps the library tables up to date.
 *
 * The media folder is expected to look the way Pinchflat lays it out: one
 * folder per channel (with a tvshow.nfo and artwork), and inside it video
 * files, each with an .nfo, a thumbnail and maybe subtitles sharing its name,
 * possibly in season sub-folders.
 *
 * A scan:
 *   1. lists the channel folders and records each channel (name and
 *      description from tvshow.nfo via nfo.ts, plus poster/banner/fanart)
 *   2. walks each channel's folders, grouping files by name into videos,
 *      reading .nfo metadata, running ffprobe (ffprobe.ts) on new or changed
 *      files, and working out chapters (chapters.ts)
 *   3. deletes every channel and video that was not seen this time, because
 *      it no longer exists on disk
 * To stay fast on big libraries, a folder whose modification time has not
 * changed since last time is skipped (its videos are just marked as seen),
 * unless a "full" scan was asked for.
 *
 * manager.ts decides when scans run; lib/videos.ts reads what they store.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { readChannelNfo, readVideoNfo } from './nfo.js';
import { probe } from './ffprobe.js';
import { chaptersFromDescription, chaptersFromProbe, isYoutubeId, youtubeIdFromName } from './chapters.js';

// What counts as a video, a subtitle or artwork; how deep to look; how many ffprobes at once.
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.mov', '.avi', '.ts', '.flv']);
const SUBTITLE_EXT = new Set(['.srt', '.vtt']);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_DEPTH = 4;
const PROBE_CONCURRENCY = 4;

/**
 * Bumped whenever the scanner's own rules change (what counts as a video, how a
 * title is derived). A mismatch forces one full rescan so existing rows are
 * rebuilt rather than being kept alive by the directory-mtime fast path.
 */
// 4: titles and descriptions have leftover HTML codes (&#39;) decoded.
const SCAN_LOGIC_VERSION = 4;

/** Half-written downloads, which are unplayable and must never enter the library. */
const PARTIAL_MARKERS = ['.temp', '.part', '.tmp', '.download', '.crdownload', '.ytdl'];

/** Whether a filename looks like a download still in progress. */
function isPartialDownload(name: string): boolean {
  const lower = name.toLowerCase();
  // "video.mp4.part"
  if (PARTIAL_MARKERS.some((marker) => lower.endsWith(marker))) return true;
  // "video.temp.mp4"
  const ext = path.extname(lower);
  const stem = lower.slice(0, lower.length - ext.length);
  return PARTIAL_MARKERS.some((marker) => stem.endsWith(marker));
}

/** Progress of the current or last scan, shown under Settings → Library. */
export interface ScanState {
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

export const scanState: ScanState = {
  running: false,
  full: false,
  startedAt: null,
  finishedAt: null,
  phase: 'idle',
  currentPath: null,
  channelsSeen: 0,
  videosAdded: 0,
  videosUpdated: 0,
  videosRemoved: 0,
  error: null,
};

/**
 * A stable id from a channel folder name or a video's path within the media
 * folder, so the same file keeps the same id (and its watch history) across scans.
 */
export function idFor(kind: string, key: string): string {
  return crypto.createHash('sha1').update(kind + ':' + key).digest('hex').slice(0, 20);
}

/** Forward slashes, so ids are the same whatever the operating system. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Only used when a video has no .nfo to take a title from. Some downloaders fall back
 * to a Kodi-style "s2026e052398 - " prefix in that case, which is noise here.
 */
function prettifyName(base: string): string {
  return base
    .replace(/^s\d{2,4}e\d+\s*-\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when the stored rules version differs, so index.ts asks for one full rescan. */
export function needsFullRescan(): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('scan_logic_version') as
    | { value: string }
    | undefined;
  return !row || Number(row.value) !== SCAN_LOGIC_VERSION;
}

/** Records that a full scan has been done with the current rules. */
function markScanLogicVersion(): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('scan_logic_version', String(SCAN_LOGIC_VERSION));
}

/** The first of e.g. poster.jpg / poster.png / folder.jpg that exists in a folder. */
async function findImage(dir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    for (const ext of IMAGE_EXT) {
      const candidate = path.join(dir, name + ext);
      try {
        // lstat, so a symbolic link is never followed out of the media folder;
        // video files, subtitles and thumbnails are already limited the same way.
        const st = await fsp.lstat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Runs `worker` over the items with at most `limit` running at once. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try {
        await worker(item);
      } catch {
        /* one bad file must not abort the whole scan */
      }
    }
  });
  await Promise.all(runners);
}

/** The files that belong to one video: they share its name. */
interface Grouped {
  video?: string;
  nfo?: string;
  thumb?: string;
  subtitles: { file: string; lang: string; ext: string }[];
}

// ---- prepared database statements -------------------------------------------

/** Adds a channel or updates the one with the same id. */
const upsertChannel = db.prepare(`
  INSERT INTO channels (id, folder, path, title, plot, poster, banner, fanart, nfo_mtime, last_seen)
  VALUES (@id, @folder, @path, @title, @plot, @poster, @banner, @fanart, @nfo_mtime, @last_seen)
  ON CONFLICT(id) DO UPDATE SET
    folder    = excluded.folder,
    path      = excluded.path,
    title     = excluded.title,
    plot      = excluded.plot,
    poster    = excluded.poster,
    banner    = excluded.banner,
    fanart    = excluded.fanart,
    nfo_mtime = excluded.nfo_mtime,
    last_seen = excluded.last_seen
`);

const selectVideo = db.prepare('SELECT id, mtime, size, duration, chapters FROM videos WHERE id = ?');

/**
 * Adds a video or updates it. COALESCE keeps the stored technical details
 * when this pass did not run ffprobe (and so passes null for them).
 */
const insertVideo = db.prepare(`
  INSERT INTO videos (
    id, channel_id, path, dir, rel_path, season, title, plot, aired,
    duration, width, height, fps, vcodec, acodec, container, bitrate,
    size, mtime, thumb, subtitles, youtube_id, chapters, added_at, last_seen
  ) VALUES (
    @id, @channel_id, @path, @dir, @rel_path, @season, @title, @plot, @aired,
    @duration, @width, @height, @fps, @vcodec, @acodec, @container, @bitrate,
    @size, @mtime, @thumb, @subtitles, @youtube_id, @chapters, @added_at, @last_seen
  )
  ON CONFLICT(id) DO UPDATE SET
    channel_id = excluded.channel_id,
    path       = excluded.path,
    dir        = excluded.dir,
    rel_path   = excluded.rel_path,
    season     = excluded.season,
    title      = excluded.title,
    plot       = excluded.plot,
    aired      = excluded.aired,
    duration   = COALESCE(excluded.duration, videos.duration),
    width      = COALESCE(excluded.width, videos.width),
    height     = COALESCE(excluded.height, videos.height),
    fps        = COALESCE(excluded.fps, videos.fps),
    vcodec     = COALESCE(excluded.vcodec, videos.vcodec),
    acodec     = COALESCE(excluded.acodec, videos.acodec),
    container  = COALESCE(excluded.container, videos.container),
    bitrate    = COALESCE(excluded.bitrate, videos.bitrate),
    size       = excluded.size,
    mtime      = excluded.mtime,
    thumb      = excluded.thumb,
    subtitles  = excluded.subtitles,
    youtube_id = COALESCE(excluded.youtube_id, videos.youtube_id),
    chapters   = COALESCE(excluded.chapters, videos.chapters),
    last_seen  = excluded.last_seen
`);

// The fast path: remembering each folder's modification time between scans.
const touchVideosInDir = db.prepare('UPDATE videos SET last_seen = ? WHERE dir = ?');
const upsertScanDir = db.prepare(`
  INSERT INTO scan_dirs (path, mtime, last_seen) VALUES (?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, last_seen = excluded.last_seen
`);
const selectScanDir = db.prepare('SELECT mtime FROM scan_dirs WHERE path = ?');

// ---- the scan ---------------------------------------------------------------

/** Runs a library scan. `full` re-reads every file instead of trusting directory mtimes. */
export async function runScan(options: { full?: boolean } = {}): Promise<ScanState> {
  if (scanState.running) return scanState;

  const full = options.full === true;
  const settings = getSettings();
  const root = settings.library.mediaPath;
  const startedAt = Date.now();

  // Reset the progress counters shown in Settings.
  Object.assign(scanState, {
    running: true,
    full,
    startedAt,
    finishedAt: null,
    phase: 'starting',
    currentPath: null,
    channelsSeen: 0,
    videosAdded: 0,
    videosUpdated: 0,
    videosRemoved: 0,
    error: null,
  });

  try {
    const rootStat = await fsp.stat(root).catch(() => null);
    if (!rootStat || !rootStat.isDirectory()) {
      throw new Error('Media folder "' + root + '" does not exist or is not a directory');
    }

    // Every visible top-level folder is a channel.
    scanState.phase = 'reading channels';
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const channelDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    // An empty media folder is far more likely to be a drive or network share
    // that is not mounted than a library someone emptied on purpose. Carrying
    // on would delete every video, and with them every playlist and queue.
    if (channelDirs.length === 0) {
      const known = db.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number };
      if (known.n > 0) {
        throw new Error(
          'The media folder "' + root + '" is empty, so nothing was removed. Check the drive or share is mounted.',
        );
      }
    }

    for (const folder of channelDirs) {
      scanState.currentPath = folder;
      scanState.phase = 'scanning ' + folder;
      await scanChannel(root, folder, startedAt, full);
      scanState.channelsSeen += 1;
    }

    // Anything not touched during this pass no longer exists on disk.
    scanState.phase = 'removing stale entries';
    const removed = db.prepare('DELETE FROM videos WHERE last_seen < ?').run(startedAt);
    scanState.videosRemoved = removed.changes;
    db.prepare('DELETE FROM channels WHERE last_seen < ?').run(startedAt);
    db.prepare('DELETE FROM scan_dirs WHERE last_seen < ?').run(startedAt);

    if (full) markScanLogicVersion();

    scanState.phase = 'idle';
  } catch (err: any) {
    scanState.error = err && err.message ? String(err.message) : String(err);
    scanState.phase = 'failed';
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    scanState.currentPath = null;
  }

  return scanState;
}

/** Records one channel folder, then scans the videos inside it. */
async function scanChannel(root: string, folder: string, startedAt: number, full: boolean): Promise<void> {
  const channelPath = path.join(root, folder);
  const channelId = idFor('channel', folder);

  const nfoPath = path.join(channelPath, 'tvshow.nfo');
  let nfoMtime: number | null = null;
  let nfo = null as ReturnType<typeof readChannelNfo>;
  try {
    const st = await fsp.stat(nfoPath);
    nfoMtime = Math.floor(st.mtimeMs);
    nfo = readChannelNfo(nfoPath);
  } catch {
    /* channel has no tvshow.nfo — fall back to the folder name */
  }

  // Channel artwork, under the names Kodi/Jellyfin use.
  const [poster, banner, fanart] = await Promise.all([
    findImage(channelPath, ['poster', 'folder', 'cover']),
    findImage(channelPath, ['banner']),
    findImage(channelPath, ['fanart', 'backdrop']),
  ]);

  upsertChannel.run({
    id: channelId,
    folder,
    path: channelPath,
    title: (nfo && nfo.title) || prettifyName(folder),
    plot: (nfo && nfo.plot) || null,
    poster,
    banner,
    fanart,
    nfo_mtime: nfoMtime,
    last_seen: startedAt,
  });

  await scanDirectory(root, channelPath, channelId, startedAt, full, 0);
}

/**
 * Scans one folder and its sub-folders. A folder holding videos is only read
 * in full when it changed since last time (or on a full scan).
 */
async function scanDirectory(
  root: string,
  dir: string,
  channelId: string,
  startedAt: number,
  full: boolean,
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(dir);
  } catch {
    return;
  }
  const dirMtime = Math.floor(stat.mtimeMs);

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.'));
  const hasVideos = files.some(
    (f) => VIDEO_EXT.has(path.extname(f.name).toLowerCase()) && !isPartialDownload(f.name),
  );

  if (hasVideos) {
    const known = selectScanDir.get(dir) as { mtime: number } | undefined;
    const unchanged = !full && known !== undefined && known.mtime === dirMtime;

    if (unchanged) {
      // Nothing was added or removed here, so keep the existing rows alive cheaply.
      touchVideosInDir.run(startedAt, dir);
      upsertScanDir.run(dir, dirMtime, startedAt);
    } else {
      await scanVideoDirectory(root, dir, channelId, startedAt, files);
      upsertScanDir.run(dir, dirMtime, startedAt);
    }
  }

  // Then each sub-folder, e.g. one per season.
  for (const sub of subdirs) {
    await scanDirectory(root, path.join(dir, sub.name), channelId, startedAt, full, depth + 1);
  }
}

/** Reads every video in one folder, along with its .nfo, thumbnail and subtitles. */
async function scanVideoDirectory(
  root: string,
  dir: string,
  channelId: string,
  startedAt: number,
  files: fs.Dirent[],
): Promise<void> {
  const groups = new Map<string, Grouped>();

  const groupFor = (base: string): Grouped => {
    let g = groups.get(base);
    if (!g) {
      g = { subtitles: [] };
      groups.set(base, g);
    }
    return g;
  };

  // Sort the folder's files into groups, one per video, by shared file name.
  for (const entry of files) {
    const name = entry.name;
    if (isPartialDownload(name)) continue;
    const ext = path.extname(name).toLowerCase();
    const stem = name.slice(0, name.length - ext.length);
    const abs = path.join(dir, name);

    if (VIDEO_EXT.has(ext)) {
      groupFor(stem).video = abs;
    } else if (ext === '.nfo') {
      groupFor(stem).nfo = abs;
    } else if (IMAGE_EXT.indexOf(ext) !== -1) {
      if (stem.endsWith('-thumb')) {
        groupFor(stem.slice(0, stem.length - 6)).thumb = abs;
      } else {
        const g = groupFor(stem);
        if (!g.thumb) g.thumb = abs;
      }
    } else if (SUBTITLE_EXT.has(ext)) {
      // "video.en.srt" -> base "video", lang "en";  "video.srt" -> lang "und"
      const dot = stem.lastIndexOf('.');
      const hasLang = dot > 0 && stem.length - dot <= 8;
      const base = hasLang ? stem.slice(0, dot) : stem;
      const lang = hasLang ? stem.slice(dot + 1) : 'und';
      groupFor(base).subtitles.push({ file: abs, lang, ext: ext.slice(1) });
    }
  }

  // Only groups that actually contain a video become library entries.
  const season = path.basename(dir);
  const pending: { base: string; group: Grouped }[] = [];
  groups.forEach((group, base) => {
    if (group.video) pending.push({ base, group });
  });

  // Then record each video, a few at a time.
  await pool(pending, PROBE_CONCURRENCY, async ({ base, group }) => {
    const file = group.video as string;
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return;
    }

    const relPath = toPosix(path.relative(root, file));
    const id = idFor('video', relPath);
    const mtime = Math.floor(st.mtimeMs);
    const existing = selectVideo.get(id) as
      | { id: string; mtime: number; size: number; duration: number | null; chapters: string | null }
      | undefined;

    const contentChanged = !existing || existing.mtime !== mtime || existing.size !== st.size;
    // ffprobe is the expensive part, so only run it when the file itself changed,
    // or when an earlier pass never worked out the duration or the chapters.
    const needsProbe = contentChanged || existing.duration == null || existing.chapters == null;
    const info = needsProbe ? await probe(file) : null;

    const nfo = group.nfo ? readVideoNfo(group.nfo) : null;
    const plot = (nfo && nfo.plot) || null;

    // Embedded chapters first; failing that, the timestamps YouTube itself
    // would turn into chapters. Left null when not probing so the stored value
    // survives (see the COALESCE in the upsert).
    let chapters: string | null = null;
    if (info) {
      const duration = info.duration ?? null;
      const embedded = chaptersFromProbe(info.chapters, duration);
      chapters = JSON.stringify(embedded.length ? embedded : chaptersFromDescription(plot, duration));
    }

    // The YouTube id (used for links back to YouTube) from the .nfo, else the filename.
    const nfoId = nfo ? nfo.youtubeId : null;
    const youtubeId = isYoutubeId(nfoId) ? nfoId : youtubeIdFromName(base);

    insertVideo.run({
      id,
      channel_id: channelId,
      path: file,
      dir,
      rel_path: relPath,
      season,
      title: (nfo && nfo.title) || prettifyName(base),
      plot,
      aired: (nfo && nfo.aired) || mtime,
      duration: info ? info.duration : null,
      width: info ? info.width : null,
      height: info ? info.height : null,
      fps: info ? info.fps : null,
      vcodec: info ? info.vcodec : null,
      acodec: info ? info.acodec : null,
      container: info ? info.container : null,
      bitrate: info ? info.bitrate : null,
      size: st.size,
      mtime,
      thumb: group.thumb || null,
      subtitles: group.subtitles.length ? JSON.stringify(group.subtitles) : null,
      youtube_id: youtubeId,
      chapters,
      // The downloader writes the file when it downloads it, so mtime is a good
      // stand-in for "added to the library".
      added_at: mtime,
      last_seen: startedAt,
    });

    if (existing) scanState.videosUpdated += 1;
    else scanState.videosAdded += 1;
  });
}
