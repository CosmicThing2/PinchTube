import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, paths } from '../config.js';

/** One ffmpeg run per video, ever — the frame is cached alongside the thumbnails. */
const inflight = new Map<string, Promise<string | null>>();

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(config.ffmpeg, args, { timeout: 45_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Grabs a single frame to stand in for a missing thumbnail. Seeking before the
 * input means ffmpeg jumps straight to the keyframe instead of decoding from the
 * start, so this costs a few hundred milliseconds even on a long video.
 */
export async function posterForVideo(
  videoId: string,
  videoPath: string,
  duration: number | null,
  mtime: number | null,
): Promise<string | null> {
  const target = path.join(paths.imageCache, `frame-${videoId}-${mtime ?? 0}.jpg`);

  try {
    await fsp.access(target, fs.constants.R_OK);
    return target;
  } catch {
    /* needs generating */
  }

  const pending = inflight.get(target);
  if (pending) return pending;

  const task = (async () => {
    // A quarter of the way in avoids intros and black opening frames.
    const seek =
      duration && duration > 40 ? Math.min(duration * 0.25, 300) : Math.max(1, (duration ?? 12) / 3);
    const tmp = `${target}.${process.pid}.tmp.jpg`;

    try {
      await run([
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-ss', String(Math.round(seek)),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', "scale='min(960,iw)':-2",
        '-q:v', '4',
        '-y', tmp,
      ]);
      await fsp.rename(tmp, target);
      return target;
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return null;
    } finally {
      inflight.delete(target);
    }
  })();

  inflight.set(target, task);
  return task;
}
