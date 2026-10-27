import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';
import { getSettings } from '../settings.js';

export interface CacheEntry {
  dir: string;
  bytes: number;
  lastAccess: number;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) total += st.size;
      else if (st.isDirectory()) total += await dirSize(path.join(dir, name));
    } catch {
      /* file vanished mid-walk */
    }
  }
  return total;
}

/** Every <videoId>/<rendition> folder currently in the transcode cache. */
export async function listCacheEntries(): Promise<CacheEntry[]> {
  const out: CacheEntry[] = [];
  let videoDirs: string[];
  try {
    videoDirs = await fsp.readdir(paths.transcodeCache);
  } catch {
    return out;
  }

  for (const videoId of videoDirs) {
    const videoDir = path.join(paths.transcodeCache, videoId);
    let rends: string[];
    try {
      const st = await fsp.stat(videoDir);
      if (!st.isDirectory()) continue;
      rends = await fsp.readdir(videoDir);
    } catch {
      continue;
    }
    for (const rendition of rends) {
      const dir = path.join(videoDir, rendition);
      try {
        const st = await fsp.stat(dir);
        if (!st.isDirectory()) continue;
        out.push({ dir, bytes: await dirSize(dir), lastAccess: st.mtimeMs });
      } catch {
        /* removed while listing */
      }
    }
  }
  return out;
}

export async function cacheSizeBytes(): Promise<number> {
  const entries = await listCacheEntries();
  return entries.reduce((sum, e) => sum + e.bytes, 0);
}

/** Bumps a rendition folder's timestamp so LRU eviction keeps what is in use. */
export async function touchCacheDir(dir: string): Promise<void> {
  const now = new Date();
  try {
    await fsp.utimes(dir, now, now);
  } catch {
    /* folder may not exist yet */
  }
}

/**
 * Deletes the least recently used rendition folders until the cache fits the
 * configured budget. `protect` holds folders belonging to live transcode jobs.
 */
export async function evictCache(protect: Set<string> = new Set()): Promise<number> {
  const limitBytes = getSettings().transcode.cacheSizeGb * 1024 * 1024 * 1024;
  const entries = await listCacheEntries();
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= limitBytes) return 0;

  entries.sort((a, b) => a.lastAccess - b.lastAccess);

  let freed = 0;
  for (const entry of entries) {
    if (total <= limitBytes) break;
    if (protect.has(entry.dir)) continue;
    try {
      await fsp.rm(entry.dir, { recursive: true, force: true });
      total -= entry.bytes;
      freed += entry.bytes;
      // Drop the parent video folder too once its last rendition is gone.
      const parent = path.dirname(entry.dir);
      const rest = await fsp.readdir(parent).catch(() => ['keep']);
      if (rest.length === 0) await fsp.rm(parent, { recursive: true, force: true });
    } catch {
      /* nothing we can do about a locked folder */
    }
  }
  return freed;
}

export async function clearTranscodeCache(): Promise<void> {
  await fsp.rm(paths.transcodeCache, { recursive: true, force: true });
  await fsp.mkdir(paths.transcodeCache, { recursive: true });
}

export async function clearImageCache(): Promise<void> {
  await fsp.rm(paths.imageCache, { recursive: true, force: true });
  await fsp.mkdir(paths.imageCache, { recursive: true });
}
