/*
 * db.ts — the SQLite database: opening it and keeping its layout up to date.
 *
 * Everything PinchTube remembers lives in one SQLite file in the config
 * folder (config.ts says where): accounts and login sessions, settings, the
 * scanned library (channels and videos), watch progress, queues and
 * playlists. This file opens it and defines every table. The `user_version`
 * number stored in the file says which layout it has, so a later version of
 * PinchTube can tell when an existing database needs upgrading.
 *
 * Every other server file imports `db` from here to run its queries; the
 * library ones mostly live in lib/videos.ts, lib/playlists.ts and auth.ts.
 */

import Database from 'better-sqlite3';
import { ensureDirs, paths } from './config.js';

// This module opens the file as soon as it is imported, so the directories have
// to be in place before that happens.
ensureDirs();

export const db = new Database(paths.db);

// WAL lets reads carry on while a scan writes; foreign keys make deletes cascade.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

/**
 * The current table layout. Releases up to 7 November 2026 used 6.
 *
 * To change the layout later: update the tables below (so new databases get
 * the new layout straight away), add a step to migrate() that upgrades an
 * existing database, e.g. `if (current < 7) { ...ALTER TABLE... }`, and raise
 * this number.
 */
const SCHEMA_VERSION = 7;

/**
 * An administrator's changes to a channel (lib/channel-edits.ts). Not tied to
 * the channels table, so edits survive the folder briefly going missing.
 */
const CHANNEL_EDITS_TABLE = `
    CREATE TABLE IF NOT EXISTS channel_edits (
      channel_id  TEXT PRIMARY KEY,
      -- Null means "use what is in the channel's folder".
      title       TEXT,
      plot        TEXT,
      -- Changes whenever an uploaded image does, so browsers fetch the new one.
      art_version INTEGER NOT NULL DEFAULT 0
    );
`;

/** Every table and index, as a brand-new database gets them. */
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash  TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      is_admin       INTEGER NOT NULL DEFAULT 0,
      -- 1: every channel, including ones added later. 0: only user_channels.
      all_channels   INTEGER NOT NULL DEFAULT 1,
      -- Two-factor sign-in (TOTP). The secret is base32; recovery codes are a
      -- JSON list of sha256 hashes, each removed once used.
      totp_secret    TEXT,
      totp_enabled   INTEGER NOT NULL DEFAULT 0,
      totp_recovery  TEXT,
      totp_last_step INTEGER,
      -- This user's own copy of the personal settings sections, as JSON.
      settings       TEXT,
      -- When the account last did anything (ms), to the nearest minute or so.
      last_active    INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_channels (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id          TEXT PRIMARY KEY,
      folder      TEXT NOT NULL UNIQUE,
      path        TEXT NOT NULL,
      title       TEXT NOT NULL,
      plot        TEXT,
      poster      TEXT,
      banner      TEXT,
      fanart      TEXT,
      nfo_mtime   INTEGER,
      last_seen   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id           TEXT PRIMARY KEY,
      channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      path         TEXT NOT NULL UNIQUE,
      dir          TEXT NOT NULL,
      rel_path     TEXT NOT NULL,
      season       TEXT,
      title        TEXT NOT NULL,
      plot         TEXT,
      aired        INTEGER,
      duration     REAL,
      width        INTEGER,
      height       INTEGER,
      fps          REAL,
      vcodec       TEXT,
      acodec       TEXT,
      container    TEXT,
      bitrate      INTEGER,
      size         INTEGER,
      mtime        INTEGER,
      thumb        TEXT,
      subtitles    TEXT,
      youtube_id   TEXT,
      -- JSON list; NULL means "not yet looked for", '[]' means "looked, none".
      chapters     TEXT,
      added_at     INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_videos_aired    ON videos(aired DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_channel  ON videos(channel_id, aired DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_dir      ON videos(dir);
    CREATE INDEX IF NOT EXISTS idx_videos_added    ON videos(added_at DESC);

    -- Keyed by video id (a hash of the relative path) so that watch state
    -- survives a file being removed and later downloaded again.
    CREATE TABLE IF NOT EXISTS progress (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id   TEXT NOT NULL,
      position   REAL NOT NULL DEFAULT 0,
      duration   REAL NOT NULL DEFAULT 0,
      watched    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      -- When it was last marked watched (ms); null if unknown or not watched.
      watched_at INTEGER,
      PRIMARY KEY (user_id, video_id)
    );

    -- Play queue. Dropping a video from the library drops it from the queue.
    CREATE TABLE IF NOT EXISTS queue (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, video_id)
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      -- Visible, read-only, to every other user.
      shared     INTEGER NOT NULL DEFAULT 0,
      -- 1: viewers only see the videos from channels they have access to.
      -- 0: anyone who can see the playlist can play everything in it.
      strict     INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);

    CREATE TABLE IF NOT EXISTS playlist_items (
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, video_id)
    );

    -- Each viewer's own quality for a playlist (theirs or a shared one).
    CREATE TABLE IF NOT EXISTS playlist_prefs (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      quality     TEXT NOT NULL,
      PRIMARY KEY (user_id, playlist_id)
    );

    CREATE TABLE IF NOT EXISTS scan_dirs (
      path      TEXT PRIMARY KEY,
      mtime     INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

${CHANNEL_EDITS_TABLE}

    CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON progress(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_user_position ON queue(user_id, position);
    CREATE INDEX IF NOT EXISTS idx_playlist_items_position ON playlist_items(playlist_id, position);
`;

/** Creates the tables in a new database, or upgrades one made by an older version. */
export function migrate(): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current >= SCHEMA_VERSION) return;

  if (current === 0) {
    db.transaction(() => {
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    return;
  }

  // Layout 7 added channel edits and when each video was marked watched.
  if (current === 6) {
    db.transaction(() => {
      db.exec('ALTER TABLE progress ADD COLUMN watched_at INTEGER');
      db.exec(CHANNEL_EDITS_TABLE);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    return;
  }

  // Layouts 1 to 5 only ever existed before the first release.
  throw new Error(
    `The database in ${paths.db} was made by a pre-release version of PinchTube (layout ${current}) ` +
      'and cannot be upgraded. Move it out of the config folder to start afresh.',
  );
}

// Some modules build prepared statements at import time, which happens before
// anything in index.ts runs — so the schema has to be in place right here
// rather than later during startup.
migrate();
