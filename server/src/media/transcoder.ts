import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config, paths } from '../config.js';
import { getSettings } from '../settings.js';
import { chosenAccel, type Accel } from './hwaccel.js';
import { clearTranscodeCache, evictCache, touchCacheDir } from './cache.js';
import type { Rendition } from './renditions.js';
import { isAudioOnly, outputSize } from './renditions.js';

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
  /** What does the encoding: a hardware kind such as 'vaapi', or 'software'. */
  encoder: string;
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
/**
 * Short side encodes that make a few segments ahead of time, keyed like jobs.
 * Kept apart from `jobs` so preparing segments never stops the encode that is
 * feeding what someone is watching right now.
 */
const warmers = new Map<string, ChildProcess>();
const MAX_WARMERS = 2;
/** How many segments a warm-up makes: enough to play on while the main job catches up. */
const WARM_SEGMENTS = 3;
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

type JobPlan = Omit<Job, 'proc' | 'exited' | 'exitCode' | 'killed' | 'stderr' | 'lastAccess' | 'startedAt'>;

/** `seconds` limits the output (a warm-up); without it the job runs to the end. */
function buildArgs(job: JobPlan, accel: Accel | null, seconds?: number): string[] {
  const { source, rendition, segmentSeconds, startSegment, dir } = job;
  // A warm-up writes its own playlist file, so it never clashes with the main job's.
  const muxer = [
    ...(seconds ? ['-t', String(seconds)] : []),
    ...hlsMuxerArgs(segmentSeconds, startSegment, dir, seconds ? 'warm.m3u8' : 'ffmpeg.m3u8'),
  ];
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
    args.push(...muxer);
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

  const frame = outputSize(source.width, source.height, rendition.size);
  const size = (w: string, h: string) => `${w}=${frame.width ?? -2}:${h}=${frame.height}`;
  const scaleTo = `${frame.width ?? -2}:${frame.height}`;
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
        : `scale=${scaleTo}:flags=bicubic,format=yuv420p`,
    );
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', ...rate, '-profile:v', 'high', '-forced-idr', '1');
  } else {
    args.push('-vf', `scale=${scaleTo}:flags=bicubic`);
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

  args.push(...muxer);

  return args;
}

function hlsMuxerArgs(segmentSeconds: number, startSegment: number, dir: string, playlist: string): string[] {
  return [
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(startSegment),
    '-hls_segment_filename', path.join(dir, 'seg-%05d.ts'),
    path.join(dir, playlist),
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
  // Remove any half-written segment so nothing partial is ever served — unless
  // a warm-up is writing into the same folder, whose files would go too.
  if (warmers.has(job.key)) return;
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
    encoder: accel ? accel.kind : 'software',
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

function stopWarmers(): void {
  for (const proc of warmers.values()) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  warmers.clear();
}

/**
 * Makes the few segments starting at `index` ahead of time, so a jump there —
 * skipping a sponsor segment — plays at once instead of waiting for ffmpeg to
 * start over. Does nothing when they exist already, or when the running job
 * will reach them shortly anyway. Returns without waiting for the encode.
 */
export async function warmSegments(source: TranscodeSource, rendition: Rendition, index: number): Promise<void> {
  const segmentSeconds = getSettings().transcode.segmentSeconds;
  const total = segmentCount(source.duration, segmentSeconds);
  if (index < 0 || index >= total) return;
  const last = Math.min(total - 1, index + WARM_SEGMENTS - 1);
  const key = `${source.id}/${rendition.id}`;
  const dir = renditionDir(source.id, rendition.id);

  await oneAtATime(async () => {
    let missing = false;
    for (let i = index; i <= last; i++) if (!segmentReady(dir, i)) missing = true;
    if (!missing || warmers.has(key) || warmers.size >= MAX_WARMERS) return;

    const live = jobs.get(key);
    if (live && !live.exited) {
      const head = currentHead(dir, live.startSegment);
      if (index >= live.startSegment && index <= head + LOOKAHEAD_SEGMENTS + 1) return;
    }

    await fsp.mkdir(dir, { recursive: true });
    const accel = isAudioOnly(rendition) || hwBlocklist.has(source.id) ? null : chosenAccel();
    const plan: JobPlan = {
      key,
      videoId: source.id,
      renditionId: rendition.id,
      dir,
      startSegment: index,
      usedHw: accel !== null,
      encoder: accel ? accel.kind : 'software',
      source,
      rendition,
      segmentSeconds,
    };
    const proc = spawn(config.ffmpeg, buildArgs(plan, accel, (last - index + 1) * segmentSeconds), {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    warmers.set(key, proc);
    const done = () => {
      if (warmers.get(key) === proc) warmers.delete(key);
    };
    proc.on('error', done);
    proc.on('close', done);
    log.debug(`transcode: warming ${key} segments ${index}-${last}`);
  });
}

export async function shutdownTranscoder(): Promise<void> {
  if (reaper) clearInterval(reaper);
  reaper = null;
  stopWarmers();
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
 * What the encoder for one video and quality is doing, for the player's stats
 * panel. `speed` is how many seconds of video it makes per second (2 means
 * twice as fast as playback); null until it has been running long enough to tell.
 */
export function encodeStatus(
  videoId: string,
  renditionId: string,
): { running: boolean; encoder: string | null; speed: number | null } {
  const job = jobs.get(`${videoId}/${renditionId}`);
  if (!job || job.exited) return { running: false, encoder: null, speed: null };
  const made = currentHead(job.dir, job.startSegment) - job.startSegment + 1;
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const speed = elapsed >= 2 && made > 0 ? (made * job.segmentSeconds) / elapsed : null;
  return { running: true, encoder: job.encoder, speed };
}

/**
 * Stops every job and empties the transcode cache — for "Clear transcode
 * cache", and when the segment length changes, since segments cut to the old
 * length no longer line up with the playlists.
 */
export async function resetTranscodes(): Promise<void> {
  await oneAtATime(async () => {
    stopWarmers();
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
