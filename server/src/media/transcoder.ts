import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config, paths } from '../config.js';
import { getSettings } from '../settings.js';
import { chosenAccel, type Accel } from './hwaccel.js';
import { clearTranscodeCache, evictCache, touchCacheDir } from './cache.js';
import type { Rendition } from './renditions.js';
import { isAudioOnly, scaledWidth } from './renditions.js';

/** How far ahead of the encoder a request may be before we restart at that point. */
const LOOKAHEAD_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 90_000;
const POLL_MS = 120;
const IDLE_JOB_MS = 90_000;

export interface TranscodeSource {
  id: string;
  path: string;
  duration: number;
  width: number | null;
  height: number | null;
}

interface Job {
  key: string;
  videoId: string;
  renditionId: string;
  dir: string;
  startSegment: number;
  proc: ChildProcess;
  usedHw: boolean;
  lastAccess: number;
  exited: boolean;
  exitCode: number | null;
  killed: boolean;
  stderr: string;
  startedAt: number;
  source: TranscodeSource;
  rendition: Rendition;
  segmentSeconds: number;
}

const jobs = new Map<string, Job>();
/** Videos whose hardware pipeline failed — these stay on software for this run. */
const hwBlocklist = new Set<string>();

let reaper: NodeJS.Timeout | null = null;
let log: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void } = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

export function setTranscodeLogger(logger: typeof log): void {
  log = logger;
}

export function renditionDir(videoId: string, renditionId: string): string {
  return path.join(paths.transcodeCache, videoId, renditionId);
}

export function segmentName(index: number): string {
  return 'seg-' + String(index).padStart(5, '0') + '.ts';
}

function segmentPath(dir: string, index: number): string {
  return path.join(dir, segmentName(index));
}

export function segmentCount(duration: number, segmentSeconds: number): number {
  return Math.max(1, Math.ceil(duration / segmentSeconds));
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * ffmpeg writes each segment as <name>.tmp and renames it when finished, so a
 * visible segment file is always complete.
 */
function segmentReady(dir: string, index: number): boolean {
  return exists(segmentPath(dir, index));
}

function currentHead(dir: string, startSegment: number): number {
  let head = startSegment - 1;
  for (let i = startSegment; i < startSegment + 5000; i++) {
    if (!segmentReady(dir, i)) break;
    head = i;
  }
  return head;
}

function buildArgs(job: Omit<Job, 'proc' | 'exited' | 'exitCode' | 'killed' | 'stderr' | 'lastAccess' | 'startedAt'>, accel: Accel | null): string[] {
  const { source, rendition, segmentSeconds, startSegment, dir } = job;
  const start = startSegment * segmentSeconds;
  const gop = Math.max(1, Math.round(segmentSeconds * 30));
  const settings = getSettings();

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  if (isAudioOnly(rendition)) {
    // No decoding of video at all, which is what makes this so cheap.
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', source.path);
    args.push('-map', '0:a:0', '-vn', '-sn', '-dn');
    args.push('-c:a', 'aac', '-b:a', `${rendition.audioBitrate}k`, '-ac', '2', '-ar', '48000');
    if (start > 0) args.push('-output_ts_offset', String(start));
    args.push('-muxdelay', '0', '-muxpreload', '0');
    args.push(...hlsMuxerArgs(segmentSeconds, startSegment, dir));
    return args;
  }

  // Decoding happens on the GPU too where possible, so frames never have to
  // make the round trip through system memory.
  if (accel?.kind === 'vaapi' && accel.device) {
    args.push('-hwaccel', 'vaapi', '-hwaccel_device', accel.device, '-hwaccel_output_format', 'vaapi');
  } else if (accel?.kind === 'qsv' && accel.device) {
    args.push('-init_hw_device', `vaapi=va:${accel.device}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs');
    args.push('-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi');
  } else if (accel?.kind === 'nvenc') {
    args.push('-hwaccel', 'cuda');
    if (accel.gpuScale) args.push('-hwaccel_output_format', 'cuda');
  }

  if (start > 0) args.push('-ss', String(start));
  args.push('-i', source.path);

  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  const width = scaledWidth(source.width, source.height, rendition.height);
  const size = (w: string, h: string) => (width ? `${w}=${width}:${h}=${rendition.height}` : `${w}=-2:${h}=${rendition.height}`);
  const rate = ['-b:v', `${rendition.bitrate}k`, '-maxrate', `${rendition.maxrate}k`, '-bufsize', `${rendition.bufsize}k`];

  if (accel?.kind === 'vaapi') {
    args.push('-vf', `scale_vaapi=${size('w', 'h')}:format=nv12`);
    args.push('-c:v', 'h264_vaapi', '-rc_mode', 'VBR', ...rate, '-profile:v', 'high');
  } else if (accel?.kind === 'qsv') {
    args.push('-vf', `scale_vaapi=${size('w', 'h')}:format=nv12,hwmap=derive_device=qsv,format=qsv`);
    args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', ...rate, '-profile:v', 'high', '-forced_idr', '1');
  } else if (accel?.kind === 'nvenc') {
    args.push(
      '-vf',
      accel.gpuScale
        ? `scale_cuda=${size('w', 'h')}:format=nv12`
        : `scale=${width ? `${width}:${rendition.height}` : `-2:${rendition.height}`}:flags=bicubic,format=yuv420p`,
    );
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', ...rate, '-profile:v', 'high', '-forced-idr', '1');
  } else {
    const scale = width
      ? `scale=${width}:${rendition.height}:flags=bicubic`
      : `scale=-2:${rendition.height}:flags=bicubic`;
    args.push('-vf', scale);
    args.push('-c:v', 'libx264');
    args.push('-preset', settings.transcode.preset || 'veryfast');
    args.push('-profile:v', 'high');
    args.push('-pix_fmt', 'yuv420p');
    args.push('-b:v', `${rendition.bitrate}k`);
    args.push('-maxrate', `${rendition.maxrate}k`);
    args.push('-bufsize', `${rendition.bufsize}k`);
    args.push('-sc_threshold', '0');
  }

  // Keyframes exactly on segment boundaries keep every segment independently
  // decodable, which is what makes seeking and quality switching work.
  args.push('-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`);
  args.push('-g', String(gop));
  args.push('-keyint_min', String(gop));

  args.push('-c:a', 'aac', '-b:a', `${rendition.audioBitrate}k`, '-ac', '2', '-ar', '48000');

  // The encoder always sees a timeline starting at zero, but the segments must
  // carry their real position in the video: without this, a job started after a
  // seek would emit timestamps from 0 again and the player would lose its place.
  if (start > 0) args.push('-output_ts_offset', String(start));
  args.push('-muxdelay', '0', '-muxpreload', '0');

  args.push(...hlsMuxerArgs(segmentSeconds, startSegment, dir));

  return args;
}

function hlsMuxerArgs(segmentSeconds: number, startSegment: number, dir: string): string[] {
  return [
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(startSegment),
    '-hls_segment_filename', path.join(dir, 'seg-%05d.ts'),
    path.join(dir, 'ffmpeg.m3u8'),
  ];
}

async function stopJob(job: Job, reason: string): Promise<void> {
  if (jobs.get(job.key) === job) jobs.delete(job.key);
  job.killed = true;
  if (!job.exited) {
    try {
      job.proc.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
  log.debug(`transcode: stopped ${job.key} (${reason})`);
  // Remove any half-written segment so nothing partial is ever served.
  try {
    const names = await fsp.readdir(job.dir);
    await Promise.all(
      names
        .filter((n) => n.endsWith('.tmp'))
        .map((n) => fsp.rm(path.join(job.dir, n), { force: true })),
    );
  } catch {
    /* folder may already be gone */
  }
}

async function enforceJobLimit(): Promise<void> {
  const limit = getSettings().transcode.maxConcurrentJobs;
  while (jobs.size >= limit) {
    let oldest: Job | null = null;
    for (const job of jobs.values()) {
      if (!oldest || job.lastAccess < oldest.lastAccess) oldest = job;
    }
    if (!oldest) return;
    await stopJob(oldest, 'concurrency limit');
  }
}

async function startJob(
  source: TranscodeSource,
  rendition: Rendition,
  startSegment: number,
  segmentSeconds: number,
): Promise<Job> {
  const key = `${source.id}/${rendition.id}`;
  const dir = renditionDir(source.id, rendition.id);
  await fsp.mkdir(dir, { recursive: true });
  await enforceJobLimit();

  const accel = isAudioOnly(rendition) || hwBlocklist.has(source.id) ? null : chosenAccel();

  const base = {
    key,
    videoId: source.id,
    renditionId: rendition.id,
    dir,
    startSegment,
    usedHw: accel !== null,
    source,
    rendition,
    segmentSeconds,
  };

  const args = buildArgs(base as any, accel);
  log.debug(`transcode: ${key} from segment ${startSegment} (${accel ? accel.kind : 'software'})`);

  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  const job: Job = {
    ...base,
    proc,
    lastAccess: Date.now(),
    exited: false,
    exitCode: null,
    killed: false,
    stderr: '',
    startedAt: Date.now(),
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    job.stderr = (job.stderr + chunk.toString()).slice(-4000);
  });

  proc.on('error', (err) => {
    job.exited = true;
    job.exitCode = -1;
    job.stderr += String(err);
    log.warn(`transcode: failed to spawn ffmpeg for ${key}: ${err}`);
  });

  proc.on('close', (code) => {
    job.exited = true;
    job.exitCode = code;
    if (jobs.get(key) === job) jobs.delete(key);

    const producedNothing = currentHead(dir, startSegment) < startSegment;

    if (!job.killed && code !== 0) {
      log.warn(`transcode: ${key} exited with code ${code}: ${job.stderr.trim().split('\n').pop() ?? ''}`);
      if (job.usedHw && producedNothing) {
        // The GPU pipeline could not handle this file (odd codec, 10-bit, ...).
        log.warn(`transcode: disabling hardware encoding for video ${source.id}, retrying in software`);
        hwBlocklist.add(source.id);
        void oneAtATime(() => startJob(source, rendition, startSegment, segmentSeconds)).catch(() => {});
        return;
      }
    }

    void evictCache(protectedDirs());
  });

  jobs.set(key, job);
  return job;
}

function protectedDirs(): Set<string> {
  return new Set(Array.from(jobs.values(), (j) => j.dir));
}

/**
 * Deciding whether to start, restart or reuse a job awaits the filesystem, so
 * two requests arriving together could each decide to start one — leaving an
 * ffmpeg nobody tracks, running to the end of the video. Those decisions
 * therefore run one at a time; waiting for segments does not.
 */
let startLock: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = startLock.then(task, task);
  startLock = run.catch(() => {});
  return run;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the path to a ready-to-serve segment, starting or repositioning an
 * ffmpeg job if that segment has not been produced yet.
 */
export async function ensureSegment(
  source: TranscodeSource,
  rendition: Rendition,
  index: number,
): Promise<string> {
  const segmentSeconds = getSettings().transcode.segmentSeconds;
  const key = `${source.id}/${rendition.id}`;
  const dir = renditionDir(source.id, rendition.id);
  const file = segmentPath(dir, index);

  if (segmentReady(dir, index)) {
    void touchCacheDir(dir);
    const live = jobs.get(key);
    if (live) live.lastAccess = Date.now();
    return file;
  }

  const job = await oneAtATime(async () => {
    // Another request may have produced it, or started a job, while this one waited.
    if (segmentReady(dir, index)) return null;
    let current = jobs.get(key);
    if (current && !current.exited) {
      const head = currentHead(dir, current.startSegment);
      const reachable = index >= current.startSegment && index <= head + LOOKAHEAD_SEGMENTS + 1;
      if (!reachable) {
        // The viewer seeked somewhere this job will not reach soon.
        await stopJob(current, 'seek');
        current = undefined;
      }
    } else {
      current = undefined;
    }
    return current ?? (await startJob(source, rendition, index, segmentSeconds));
  });
  if (job) job.lastAccess = Date.now();

  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (segmentReady(dir, index)) {
      void touchCacheDir(dir);
      const live = jobs.get(key);
      if (live) live.lastAccess = Date.now();
      return file;
    }

    const live = jobs.get(key);
    if (!live) {
      // The job finished or was replaced; give a rename a moment to land.
      await delay(400);
      if (segmentReady(dir, index)) return file;
      throw new Error(`Transcode for segment ${index} of ${key} ended before producing it`);
    }
    live.lastAccess = Date.now();
    await delay(POLL_MS);
  }

  throw new Error(`Timed out waiting for segment ${index} of ${key}`);
}

export function startReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const job of Array.from(jobs.values())) {
      if (now - job.lastAccess > IDLE_JOB_MS) void stopJob(job, 'idle');
    }
    void evictCache(protectedDirs());
  }, 15_000);
  reaper.unref?.();
}

export async function shutdownTranscoder(): Promise<void> {
  if (reaper) clearInterval(reaper);
  reaper = null;
  await Promise.all(Array.from(jobs.values(), (job) => stopJob(job, 'shutdown')));
}

export function activeJobs(): { video: string; rendition: string; startSegment: number; hardware: boolean }[] {
  return Array.from(jobs.values(), (job) => ({
    video: job.videoId,
    rendition: job.renditionId,
    startSegment: job.startSegment,
    hardware: job.usedHw,
  }));
}

/**
 * Stops every job and empties the transcode cache — for "Clear transcode
 * cache", and when the segment length changes, since segments cut to the old
 * length no longer line up with the playlists.
 */
export async function resetTranscodes(): Promise<void> {
  await oneAtATime(async () => {
    await Promise.all(Array.from(jobs.values(), (job) => stopJob(job, 'cache cleared')));
    await clearTranscodeCache();
  });
}

/** Drops cached segments for a video, e.g. after its file changed on disk. */
export async function invalidateVideo(videoId: string): Promise<void> {
  for (const job of Array.from(jobs.values())) {
    if (job.videoId === videoId) await stopJob(job, 'invalidated');
  }
  await fsp.rm(path.join(paths.transcodeCache, videoId), { recursive: true, force: true });
}
