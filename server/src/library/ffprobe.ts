/*
 * ffprobe.ts — reads technical details out of a video file.
 *
 * Runs the ffprobe tool (installed alongside ffmpeg in the image) on one
 * file and boils its JSON report down to what PinchTube needs: duration,
 * picture size, frame rate, codecs, bitrate and any chapters embedded in the
 * file. scanner.ts calls it for every new or changed video; the result is
 * stored in the videos table.
 */

import { execFile } from 'node:child_process';
import { config } from '../config.js';

/** What the scanner keeps from ffprobe's report. */
export interface MediaInfo {
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  container: string | null;
  bitrate: number | null;
  /** Raw `chapters` array from ffprobe; parsed by library/chapters.ts. */
  chapters: unknown[];
}

/** Runs ffprobe and resolves with its output, giving up after 30 seconds. */
function run(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.ffprobe,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** ffprobe gives frame rates as fractions such as "30000/1001"; this turns them into a number. */
function parseFps(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.includes('/')) return null;
  const [num, den] = raw.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : null;
}

/** Probes one file; null when ffprobe fails or the file is not a readable video. */
export async function probe(file: string): Promise<MediaInfo | null> {
  let stdout: string;
  try {
    stdout = await run([
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      file,
    ]);
  } catch {
    return null;
  }

  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }

  // The first real video stream (not embedded cover art) and the first audio stream.
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');

  const duration =
    Number(data?.format?.duration) ||
    Number(video?.duration) ||
    null;

  return {
    duration: Number.isFinite(duration) && (duration as number) > 0 ? Number(duration) : null,
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    fps: parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate),
    vcodec: video?.codec_name ?? null,
    acodec: audio?.codec_name ?? null,
    container: data?.format?.format_name ?? null,
    bitrate: Number(data?.format?.bit_rate) || null,
    chapters: Array.isArray(data?.chapters) ? data.chapters : [],
  };
}
