/*
 * poster.ts — makes a thumbnail for a video that came without one.
 *
 * Takes a single frame from about a quarter of the way into the video with
 * ffmpeg and saves it in the image cache, so it is only ever made once per
 * version of the file. routes/images.ts uses it when a video has no
 * thumbnail file of its own; images.ts then resizes it like any other artwork.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, paths } from '../config.js';

/** One ffmpeg run per video, ever — the frame is cached alongside the thumbnails. */
const inflight = new Map<string, Promise<string | null>>();

/** Runs ffmpeg, giving up after 45 seconds. */
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
  // The file's modification time is in the name, so a replaced video gets a new frame.
  const target = path.join(paths.imageCache, `frame-${videoId}-${mtime ?? 0}.jpg`);

  // Already made?
  try {
    await fsp.access(target, fs.constants.R_OK);
    return target;
  } catch {
    /* needs generating */
  }

  // Being made right now for another request? Share that result.
  const pending = inflight.get(target);
  if (pending) return pending;

  const task = (async () => {
    // A quarter of the way in avoids intros and black opening frames.
    const seek =
      duration && duration > 40 ? Math.min(duration * 0.25, 300) : Math.max(1, (duration ?? 12) / 3);
    const tmp = `${target}.${process.pid}.tmp.jpg`;

    // Written to a temporary name and renamed, so a half-written file is never served.
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
