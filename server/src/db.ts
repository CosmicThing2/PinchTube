import Database from 'better-sqlite3';
import { ensureDirs, paths } from './config.js';

// This module opens the file as soon as it is imported, so the directories have
// to be in place before that happens.
ensureDirs();

export const db = new Database(paths.db);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

const SCHEMA_VERSION = 6;

/** Adds a column if it is missing — the migration path for an existing database. */
function ensureColumn(table: string, column: string, definition: string): void {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((c) => c.name === column);
}

export function migrate(): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current >= SCHEMA_VERSION) return;

  db.exec(`
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
  `);

  // v3: the CREATE above only helps a fresh database; existing ones get the
  // columns bolted on.
  ensureColumn('videos', 'youtube_id', 'TEXT');
  ensureColumn('videos', 'chapters', 'TEXT');

  // v4: multiple users. Everything that existed belonged to the one account,
  // which becomes the first administrator and keeps its watch history, queue
  // and settings.
  db.transaction(() => {
    ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'all_channels', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('users', 'totp_secret', 'TEXT');
    ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'totp_recovery', 'TEXT');
    ensureColumn('users', 'totp_last_step', 'INTEGER');
    ensureColumn('users', 'settings', 'TEXT');

    db.exec(`UPDATE users SET is_admin = 1
              WHERE id = (SELECT MIN(id) FROM users)
                AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`);
    const owner = (db.prepare('SELECT MIN(id) AS id FROM users').get() as { id: number | null }).id;

    if (!hasColumn('progress', 'user_id')) {
      db.exec(`
        CREATE TABLE progress_v4 (
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          video_id   TEXT NOT NULL,
          position   REAL NOT NULL DEFAULT 0,
          duration   REAL NOT NULL DEFAULT 0,
          watched    INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, video_id)
        );
      `);
      if (owner !== null) {
        db.prepare(
          `INSERT INTO progress_v4 (user_id, video_id, position, duration, watched, updated_at)
           SELECT ?, video_id, position, duration, watched, updated_at FROM progress`,
        ).run(owner);
      }
      db.exec('DROP TABLE progress; ALTER TABLE progress_v4 RENAME TO progress;');
    }

    if (!hasColumn('queue', 'user_id')) {
      db.exec(`
        CREATE TABLE queue_v4 (
          user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, video_id)
        );
      `);
      if (owner !== null) {
        db.prepare(
          `INSERT INTO queue_v4 (user_id, video_id, position, added_at)
           SELECT ?, video_id, position, added_at FROM queue`,
        ).run(owner);
      }
      db.exec('DROP TABLE queue; ALTER TABLE queue_v4 RENAME TO queue;');
    }

    // The personal sections of the old single settings record move onto the
    // owner's account; the library and transcoding sections stay global.
    if (owner !== null) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
        | { value: string }
        | undefined;
      const mine = db.prepare('SELECT settings FROM users WHERE id = ?').get(owner) as {
        settings: string | null;
      };
      if (row && !mine.settings) {
        try {
          const old = JSON.parse(row.value);
          const personal = { appearance: old.appearance, home: old.home, playback: old.playback, ui: old.ui };
          db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(personal), owner);
        } catch {
          /* unreadable — the owner simply starts from the defaults */
        }
      }
    }
  })();

  // v5: a playlist's quality used to be one setting on the playlist itself,
  // forced on everyone who played it. It is now each viewer's own, so the
  // owner's existing choice carries over as the owner's preference. The old
  // column is left in place, unused.
  ensureColumn('playlists', 'strict', 'INTEGER NOT NULL DEFAULT 1');
  if (hasColumn('playlists', 'quality')) {
    db.exec(`INSERT OR IGNORE INTO playlist_prefs (user_id, playlist_id, quality)
             SELECT user_id, id, quality FROM playlists WHERE quality <> 'auto'`);
  }

  // v6: "last active" used to be worked out from the newest session, so it
  // read "never" once someone signed out or their sessions were cleared. It is
  // now kept on the account; existing accounts start from the latest trace of
  // activity there is.
  ensureColumn('users', 'last_active', 'INTEGER');
  db.exec(`UPDATE users SET last_active = (
             SELECT MAX(t) FROM (
               SELECT MAX(created_at) AS t FROM sessions WHERE user_id = users.id
               UNION ALL SELECT MAX(updated_at) FROM progress WHERE user_id = users.id
               UNION ALL SELECT MAX(added_at) FROM queue WHERE user_id = users.id
               UNION ALL SELECT MAX(updated_at) FROM playlists WHERE user_id = users.id
             )
           )
           WHERE last_active IS NULL`);

  db.exec(`
    DROP INDEX IF EXISTS idx_progress_updated;
    DROP INDEX IF EXISTS idx_queue_position;
    CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON progress(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_user_position ON queue(user_id, position);
    CREATE INDEX IF NOT EXISTS idx_playlist_items_position ON playlist_items(playlist_id, position);
  `);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// Some modules build prepared statements at import time, which happens before
// anything in index.ts runs — so the schema has to be in place right here
// rather than later during startup. migrate() is idempotent.
migrate();
