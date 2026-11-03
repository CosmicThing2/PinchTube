/*
 * downloads.ts — makes a whole-file copy of a video at a chosen quality, for
 * the Download button.
 *
 * Streaming makes a video a few seconds at a time (transcoder.ts), but a
 * download needs one complete file. When someone asks for a video at, say,
 * 720p, ffmpeg converts the whole thing into a single MP4 (or an M4A for
 * audio only) in the cache folder, using the same graphics-card encoder
 * settings as streaming. The web app polls for progress, then fetches the
 * finished file. "Original" needs none of this: it is the file itself.
 *
 * Copies are made one at a time, kept for a day after they were made (so a
 * second device or a retry does not convert again), and remade if the video
 * file has changed since. routes/downloads.ts is the API on top of this.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config, paths } from '../config.js';
import type { Rendition } from './renditions.js';
import { isAudioOnly } from './renditions.js';
import { accelFor, hwDecodeArgs, markHardwareFailed, videoEncodeArgs, type TranscodeSource } from './transcoder.js';

/** How long a finished copy is kept after it was made. */
const KEEP_MS = 24 * 60 * 60 * 1000;
/** Conversions running at once; each is a full-length encode. */
const MAX_RUNNING = 1;
/** Conversions allowed to wait their turn before new ones are refused. */
const MAX_WAITING = 20;
/** How often old copies and failed conversions are cleared away. */
const SWEEP_MS = 60 * 60 * 1000;
/** Audio-only downloads get a better bitrate than the audio-only stream. */
const AUDIO_DOWNLOAD_KBPS = 160;

export type DownloadState = 'waiting' | 'working' | 'ready' | 'failed';

/** What the web app is told about a copy. `progress` runs from 0 to 1. */
export interface DownloadStatus {
  state: DownloadState;
  progress: number;
  size: number | null;
  error: string | null;
}

/** One conversion, waiting, running or failed (finished ones are just files). */
interface Task {
  key: string;
  source: TranscodeSource;
  rendition: Rendition;
  file: string;
  tmp: string;
  state: DownloadState;
  progress: number;
  error: string | null;
  proc: ChildProcess | null;
  /** Set after the graphics card failed on this video, for the retry. */
  software: boolean;
  updatedAt: number;
}

/** Thrown when too many conversions are already waiting. */
export class DownloadsBusyError extends Error {}

const tasks = new Map<string, Task>();
let sweeper: NodeJS.Timeout | null = null;
let log: { info: (m: string) => void; warn: (m: string) => void } = { info: () => {}, warn: () => {} };

/** index.ts hands over the server's logger. */
export function setDownloadLogger(logger: typeof log): void {
  log = logger;
}

/** The file type a copy is saved as. */
export function downloadExtension(rendition: Rendition): 'mp4' | 'm4a' {
  return isAudioOnly(rendition) ? 'm4a' : 'mp4';
}

export function downloadContentType(rendition: Rendition): string {
  return isAudioOnly(rendition) ? 'audio/mp4' : 'video/mp4';
}

/** Where a finished copy lives; ids are hex and quality names fixed, so this stays in the folder. */
function fileFor(videoId: string, rendition: Rendition): string {
  return path.join(paths.downloadCache, `${videoId}-${rendition.id}.${downloadExtension(rendition)}`);
}

/** A finished copy that is still current (not older than the video file), or null. */
export async function readyCopy(
  source: TranscodeSource,
  rendition: Rendition,
): Promise<{ file: string; size: number } | null> {
  const file = fileFor(source.id, rendition);
  try {
    const [copy, original] = await Promise.all([fsp.stat(file), fsp.stat(source.path)]);
    if (copy.mtimeMs < original.mtimeMs) return null;
    return { file, size: copy.size };
  } catch {
    return null;
  }
}

function statusOf(task: Task): DownloadStatus {
  return { state: task.state, progress: task.progress, size: null, error: task.error };
}

/**
 * Starts making a copy, unless one is ready or already on its way. Returns
 * where it stands either way.
 */
export async function requestDownload(source: TranscodeSource, rendition: Rendition): Promise<DownloadStatus> {
  const key = `${source.id}/${rendition.id}`;
  const existing = tasks.get(key);
  if (existing && existing.state !== 'failed') return statusOf(existing);

  const ready = await readyCopy(source, rendition);
  if (ready) return { state: 'ready', progress: 1, size: ready.size, error: null };

  // Another request may have started it while the files were being checked.
  const raced = tasks.get(key);
  if (raced && raced.state !== 'failed') return statusOf(raced);

  const waiting = Array.from(tasks.values()).filter((task) => task.state === 'waiting').length;
  if (waiting >= MAX_WAITING) throw new DownloadsBusyError('Too many downloads are being prepared. Try again later.');

  const file = fileFor(source.id, rendition);
  const task: Task = {
    key,
    source,
    rendition,
    file,
    tmp: `${file}.part`,
    state: 'waiting',
    progress: 0,
    error: null,
    proc: null,
    software: false,
    updatedAt: Date.now(),
  };
  tasks.set(key, task);
  pump();
  return statusOf(task);
}

/** Where a copy stands, or null if nobody has asked for it. */
export async function downloadStatus(source: TranscodeSource, rendition: Rendition): Promise<DownloadStatus | null> {
  const task = tasks.get(`${source.id}/${rendition.id}`);
  if (task) return statusOf(task);
  const ready = await readyCopy(source, rendition);
  return ready ? { state: 'ready', progress: 1, size: ready.size, error: null } : null;
}

/** Starts waiting conversions while there is room. */
function pump(): void {
  let running = Array.from(tasks.values()).filter((task) => task.state === 'working').length;
  for (const task of tasks.values()) {
    if (running >= MAX_RUNNING) break;
    if (task.state !== 'waiting') continue;
    start(task);
    running += 1;
  }
  if (!sweeper) {
    sweeper = setInterval(() => void sweep(), SWEEP_MS);
    sweeper.unref?.();
  }
}

/** The ffmpeg command for a whole-file copy. */
function argsFor(task: Task, accel: ReturnType<typeof accelFor>): string[] {
  const { source, rendition } = task;
  // -progress writes "out_time_us=…" lines to stdout, which give the percentage.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-progress', 'pipe:1'];
  if (isAudioOnly(rendition)) {
    args.push('-i', source.path, '-map', '0:a:0', '-vn', '-sn', '-dn');
    args.push('-c:a', 'aac', '-b:a', `${AUDIO_DOWNLOAD_KBPS}k`, '-ac', '2', '-ar', '48000');
  } else {
    args.push(...hwDecodeArgs(accel), '-i', source.path, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
    args.push(...videoEncodeArgs(source, rendition, accel));
    args.push('-c:a', 'aac', '-b:a', `${rendition.audioBitrate}k`, '-ac', '2', '-ar', '48000');
  }
  // The index goes at the start of the file, so a player can start before it has all arrived.
  args.push('-movflags', '+faststart', '-f', 'mp4', '-y', task.tmp);
  return args;
}

/** Runs one conversion, following its progress. */
function start(task: Task): void {
  const accel = task.software ? null : accelFor(task.source.id, task.rendition);
  task.state = 'working';
  task.progress = 0;
  task.error = null;
  task.updatedAt = Date.now();
  log.info(`download: making ${task.key} (${accel ? accel.kind : 'software'})`);

  let stderr = '';
  let pending = '';
  const proc = spawn(config.ffmpeg, argsFor(task, accel), { stdio: ['ignore', 'pipe', 'pipe'] });
  task.proc = proc;

  proc.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (match && task.source.duration > 0) {
        // Both report microseconds; 99% until the file is actually in place.
        task.progress = Math.min(0.99, Number(match[1]) / 1e6 / task.source.duration);
        task.updatedAt = Date.now();
      }
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  proc.on('error', (err) => {
    stderr += String(err);
  });

  proc.on('close', async (code) => {
    task.proc = null;
    // Stopped on purpose (cache cleared or shutting down).
    if (task.state !== 'working') return;

    if (code === 0) {
      try {
        await fsp.rename(task.tmp, task.file);
        tasks.delete(task.key);
        log.info(`download: ${task.key} is ready`);
      } catch (err) {
        fail(task, String(err));
      }
    } else if (accel && task.progress === 0) {
      // The graphics card could not handle this file: try again in software.
      log.warn(`download: hardware encoding failed for ${task.key}, retrying in software`);
      markHardwareFailed(task.source.id);
      task.software = true;
      task.state = 'waiting';
    } else {
      fail(task, stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`);
    }
    await fsp.rm(task.tmp, { force: true }).catch(() => {});
    pump();
  });
}

function fail(task: Task, reason: string): void {
  task.state = 'failed';
  task.error = 'The server could not convert this video.';
  task.updatedAt = Date.now();
  log.warn(`download: ${task.key} failed: ${reason}`);
}

/** Deletes copies past their day, half-written files nobody is writing, and old failures. */
async function sweep(): Promise<void> {
  const now = Date.now();
  for (const task of Array.from(tasks.values())) {
    if (task.state === 'failed' && now - task.updatedAt > SWEEP_MS) tasks.delete(task.key);
  }
  const writing = new Set(Array.from(tasks.values(), (task) => (task.state === 'working' ? task.tmp : '')));
  let names: string[];
  try {
    names = await fsp.readdir(paths.downloadCache);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(paths.downloadCache, name);
    if (writing.has(file)) continue;
    try {
      const stat = await fsp.stat(file);
      if (name.endsWith('.part') || now - stat.mtimeMs > KEEP_MS) await fsp.rm(file, { force: true });
    } catch {
      /* removed meanwhile */
    }
  }
}

/** Stops every conversion. */
function stopAll(): void {
  for (const task of tasks.values()) {
    task.state = 'failed';
    try {
      task.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  tasks.clear();
}

/** "Clear cache" in Settings: stops conversions and deletes every copy. */
export async function clearDownloads(): Promise<void> {
  stopAll();
  await fsp.rm(paths.downloadCache, { recursive: true, force: true });
  await fsp.mkdir(paths.downloadCache, { recursive: true });
}

/** Stops conversions when the server shuts down. */
export function shutdownDownloads(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  stopAll();
}
