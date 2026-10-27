import { execFile } from 'node:child_process';
import { config } from '../config.js';

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

function parseFps(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.includes('/')) return null;
  const [num, den] = raw.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : null;
}

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
