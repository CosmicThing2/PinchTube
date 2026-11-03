/*
 * config.ts — startup configuration that comes from environment variables.
 *
 * Everything set in the compose file's `environment:` section (port, folder
 * locations, cookie and proxy behaviour, ffmpeg paths, log level) is read
 * here once, with a sensible default for each. It also defines where files
 * live inside the config and cache folders, creates those folders, and
 * creates/loads the secret key used to sign login cookies.
 *
 * Settings changed from the web app are a different thing: those live in the
 * database and are handled by settings.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Reads one environment variable, treating blank as unset. */
function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

/** Values from the environment, each with its default. */
export const config = {
  port: parseInt(env('PORT', '8080'), 10),
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR', '/config'),
  cacheDir: env('CACHE_DIR', '/cache'),
  defaultMediaDir: env('MEDIA_DIR', '/media'),
  publicDir: env('PUBLIC_DIR', path.join(__dirname, '..', 'public')),
  /** 'auto' marks the cookie Secure whenever the request came in over HTTPS. */
  secureCookies: (['true', 'false'].includes(env('SECURE_COOKIES', 'auto').toLowerCase())
    ? env('SECURE_COOKIES', 'auto').toLowerCase()
    : 'auto') as 'true' | 'false' | 'auto',
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
  ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
  ffprobe: env('FFPROBE_PATH', 'ffprobe'),
  logLevel: env('LOG_LEVEL', 'info'),
};

/** Where PinchTube keeps its own files inside the config and cache folders. */
export const paths = {
  db: path.join(config.dataDir, 'ytmedia.db'),
  sessionKey: path.join(config.dataDir, 'session.key'),
  transcodeCache: path.join(config.cacheDir, 'transcode'),
  imageCache: path.join(config.cacheDir, 'images'),
};

/** Creates the config and cache folders on first start. */
export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.cacheDir, paths.transcodeCache, paths.imageCache]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** A stable secret used to sign session cookies. Generated once, then persisted. */
export function loadSessionSecret(): string {
  try {
    const existing = fs.readFileSync(paths.sessionKey, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not created yet */
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(paths.sessionKey, secret, { mode: 0o600 });
  return secret;
}
