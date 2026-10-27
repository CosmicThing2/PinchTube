import { db } from '../db.js';
import { QUALITY_CHOICES } from '../media/renditions.js';
import { channelScope, mapVideo, mergeOrder, ownerSees, type VideoDto, type VideoRow, type Viewer } from './videos.js';

export const PLAYLIST_NAME_MAX = 100;
const PLAYLIST_ITEMS_MAX = 5000;

export interface PlaylistDto {
  id: number;
  name: string;
  shared: boolean;
  /** Off: everyone who can see the playlist can play all of it, whatever their channel access. */
  strict: boolean;
  /** The viewer's own quality for this playlist: 'auto', or a quality id. */
  quality: string;
  owner: string;
  /** Whether the viewer owns it — only the owner can change it. */
  mine: boolean;
  /** Videos in it the viewer can actually see. */
  count: number;
  duration: number;
  /** The first visible video, whose thumbnail stands in for the playlist. */
  coverVideoId: string | null;
  updatedAt: number;
}

interface PlaylistRow {
  id: number;
  user_id: number;
  name: string;
  shared: number;
  strict: number;
  quality: string;
  updated_at: number;
  owner: string;
  count: number;
  duration: number | null;
  cover: string | null;
}

/**
 * Which of a playlist's videos the viewer gets: the ones from their own
 * channels, plus — in someone else's non-strict playlist — whatever its owner
 * can see. The same rule as videoScope() in videos.ts, so a playlist never
 * lists anything the viewer could not then play. Expects the playlist as `pl`,
 * its owner as `u` and the video as `v`.
 */
function itemScope(viewer: Viewer): string {
  return `(${channelScope(viewer)} OR (pl.strict = 0 AND pl.user_id <> @viewerId AND ${ownerSees('pl', 'u', 'v')}))`;
}

/**
 * Counting and the cover image only consider videos the viewer may see, so a
 * strict shared playlist never reveals anything from a channel they have no
 * access to.
 */
function playlistSelect(viewer: Viewer): string {
  const scope = itemScope(viewer);
  return `
    SELECT pl.id, pl.user_id, pl.name, pl.shared, pl.strict, pl.updated_at,
           COALESCE((SELECT pp.quality FROM playlist_prefs pp
                      WHERE pp.playlist_id = pl.id AND pp.user_id = @viewerId), 'auto') AS quality,
           u.username AS owner,
           (SELECT COUNT(*) FROM playlist_items i JOIN videos v ON v.id = i.video_id
             WHERE i.playlist_id = pl.id AND ${scope}) AS count,
           (SELECT SUM(v.duration) FROM playlist_items i JOIN videos v ON v.id = i.video_id
             WHERE i.playlist_id = pl.id AND ${scope}) AS duration,
           (SELECT v.id FROM playlist_items i JOIN videos v ON v.id = i.video_id
             WHERE i.playlist_id = pl.id AND ${scope}
             ORDER BY i.position ASC LIMIT 1) AS cover
      FROM playlists pl
      JOIN users u ON u.id = pl.user_id`;
}

function mapPlaylist(row: PlaylistRow, viewer: Viewer): PlaylistDto {
  return {
    id: row.id,
    name: row.name,
    shared: row.shared === 1,
    strict: row.strict !== 0,
    quality: row.quality,
    owner: row.owner,
    mine: row.user_id === viewer.id,
    count: Number(row.count) || 0,
    duration: Number(row.duration) || 0,
    coverVideoId: row.cover,
    updatedAt: row.updated_at,
  };
}

/** The viewer's own playlists, then everyone else's shared ones. */
export function listPlaylists(viewer: Viewer): PlaylistDto[] {
  const rows = db
    .prepare(
      `${playlistSelect(viewer)}
        WHERE pl.user_id = @viewerId OR pl.shared = 1
        ORDER BY (pl.user_id = @viewerId) DESC, pl.updated_at DESC`,
    )
    .all({ viewerId: viewer.id }) as PlaylistRow[];
  return rows.map((row) => mapPlaylist(row, viewer));
}

/** A playlist the viewer may open (their own, or shared), else undefined. */
export function getPlaylist(viewer: Viewer, id: number): PlaylistDto | undefined {
  const row = db
    .prepare(`${playlistSelect(viewer)} WHERE pl.id = @id AND (pl.user_id = @viewerId OR pl.shared = 1)`)
    .get({ id, viewerId: viewer.id }) as PlaylistRow | undefined;
  return row ? mapPlaylist(row, viewer) : undefined;
}

export function playlistVideos(viewer: Viewer, id: number): VideoDto[] {
  const rows = db
    .prepare(
      `SELECT v.*, c.title AS channel_title,
              p.position AS p_position, p.watched AS p_watched
         FROM playlist_items i
         JOIN playlists pl ON pl.id = i.playlist_id
         JOIN users u ON u.id = pl.user_id
         JOIN videos v ON v.id = i.video_id
         JOIN channels c ON c.id = v.channel_id
         LEFT JOIN progress p ON p.video_id = v.id AND p.user_id = @viewerId
        WHERE i.playlist_id = @id AND ${itemScope(viewer)}
        ORDER BY i.position ASC`,
    )
    .all({ id, viewerId: viewer.id }) as VideoRow[];
  return rows.map((row) => mapVideo(row, viewer));
}

function owned(userId: number, id: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM playlists WHERE id = ? AND user_id = ?').get(id, userId));
}

function touch(id: number): void {
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, PLAYLIST_NAME_MAX);
  return name || null;
}

export function validQuality(raw: unknown): string | null {
  if (raw === 'auto') return 'auto';
  return typeof raw === 'string' && QUALITY_CHOICES.includes(raw) ? raw : null;
}

export function createPlaylist(userId: number, name: string, shared: boolean, quality: string): number {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO playlists (user_id, name, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, name, shared ? 1 : 0, now, now);
  const id = Number(info.lastInsertRowid);
  setPlaylistQuality(userId, id, quality);
  return id;
}

/** Returns false when the playlist is not the user's to change. */
export function updatePlaylist(
  userId: number,
  id: number,
  patch: { name?: string; shared?: boolean; strict?: boolean },
): boolean {
  if (!owned(userId, id)) return false;
  if (patch.name !== undefined) db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(patch.name, id);
  if (patch.shared !== undefined) {
    db.prepare('UPDATE playlists SET shared = ? WHERE id = ?').run(patch.shared ? 1 : 0, id);
  }
  if (patch.strict !== undefined) {
    db.prepare('UPDATE playlists SET strict = ? WHERE id = ?').run(patch.strict ? 1 : 0, id);
  }
  touch(id);
  return true;
}

/**
 * The quality one viewer plays a playlist at. Anyone who can open the
 * playlist may set their own; it never affects anybody else's.
 */
export function setPlaylistQuality(userId: number, id: number, quality: string): void {
  if (quality === 'auto') {
    db.prepare('DELETE FROM playlist_prefs WHERE user_id = ? AND playlist_id = ?').run(userId, id);
    return;
  }
  db.prepare(
    `INSERT INTO playlist_prefs (user_id, playlist_id, quality) VALUES (?, ?, ?)
     ON CONFLICT(user_id, playlist_id) DO UPDATE SET quality = excluded.quality`,
  ).run(userId, id, quality);
}

export function deletePlaylist(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** 'ok', or why not: the list is not theirs, or it is full. */
export function addToPlaylist(userId: number, id: number, videoId: string): 'ok' | 'forbidden' | 'full' {
  if (!owned(userId, id)) return 'forbidden';
  const stats = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM playlist_items WHERE playlist_id = ?')
    .get(id) as { n: number; last: number };
  if (stats.n >= PLAYLIST_ITEMS_MAX) return 'full';
  const info = db
    .prepare(
      `INSERT INTO playlist_items (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(playlist_id, video_id) DO NOTHING`,
    )
    .run(id, videoId, stats.last + 1, Date.now());
  if (info.changes) touch(id);
  return 'ok';
}

export function removeFromPlaylist(userId: number, id: number, videoId: string): boolean {
  if (!owned(userId, id)) return false;
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?').run(id, videoId);
  touch(id);
  return true;
}

export function reorderPlaylist(userId: number, id: number, ids: unknown): boolean {
  if (!owned(userId, id)) return false;
  const existing = (
    db.prepare('SELECT video_id FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC').all(id) as {
      video_id: string;
    }[]
  ).map((row) => row.video_id);
  const order = mergeOrder(existing, ids);
  const update = db.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?');
  db.transaction(() => order.forEach((videoId, index) => update.run(index + 1, id, videoId)))();
  touch(id);
  return true;
}

/** Which of the user's own playlists already hold a video, for the "Save to" menu. */
export function playlistsContaining(userId: number, videoId: string): number[] {
  return (
    db
      .prepare(
        `SELECT pl.id FROM playlists pl JOIN playlist_items i ON i.playlist_id = pl.id
          WHERE pl.user_id = ? AND i.video_id = ?`,
      )
      .all(userId, videoId) as { id: number }[]
  ).map((row) => row.id);
}
