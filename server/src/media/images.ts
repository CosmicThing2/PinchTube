import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';

let sharpModule: any = null;
let sharpChecked = false;

function loadSharp(): any {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    // Resolved lazily so a broken native build degrades to serving originals.
    sharpModule = require('sharp');
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

export const ALLOWED_WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1920];

export function normaliseWidth(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return null;
  // Snap to the nearest allowed size so the cache cannot be flooded.
  let best = ALLOWED_WIDTHS[0];
  for (const w of ALLOWED_WIDTHS) {
    if (Math.abs(w - n) < Math.abs(best - n)) best = w;
  }
  return best;
}

export interface ServedImage {
  file: string;
  contentType: string;
}

const inflight = new Map<string, Promise<ServedImage>>();

/**
 * Returns a WebP-encoded, width-limited copy of an artwork file, cached on disk.
 * Falls back to the original file if sharp is unavailable or the source is odd.
 */
export async function resizedImage(source: string, width: number | null): Promise<ServedImage> {
  const original: ServedImage = { file: source, contentType: contentTypeFor(source) };

  const sharp = loadSharp();
  if (!sharp || !width) return original;

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(source);
  } catch {
    throw new Error('Artwork file is missing');
  }

  const key = crypto
    .createHash('sha1')
    .update(`${source}|${Math.floor(stat.mtimeMs)}|${stat.size}|${width}`)
    .digest('hex');
  const target = path.join(paths.imageCache, `${key}.webp`);

  try {
    await fsp.access(target, fs.constants.R_OK);
    return { file: target, contentType: 'image/webp' };
  } catch {
    /* needs generating */
  }

  const pending = inflight.get(target);
  if (pending) return pending;

  const task = (async () => {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await sharp(source)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toFile(tmp);
      await fsp.rename(tmp, target);
      return { file: target, contentType: 'image/webp' };
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return original;
    } finally {
      inflight.delete(target);
    }
  })();

  inflight.set(target, task);
  return task;
}

export function contentTypeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}
