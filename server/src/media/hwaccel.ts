import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { getSettings } from '../settings.js';

/**
 * Hardware video encoding. Three routes are supported:
 *
 *  - vaapi: AMD and Intel GPUs through the kernel's /dev/dri render node.
 *  - qsv:   Intel Quick Sync, decoding through VAAPI and encoding with QSV.
 *  - nvenc: NVIDIA, through the NVIDIA Container Toolkit.
 *
 * Seeing an encoder in `ffmpeg -encoders` only proves it was compiled in, not
 * that this machine can use it, so at start-up each one is tried for real with
 * a fraction of a second of test pattern. Only the ones that worked are used.
 */

export type AccelKind = 'vaapi' | 'qsv' | 'nvenc';

/** Preference when the setting is "auto". */
const AUTO_ORDER: AccelKind[] = ['nvenc', 'vaapi', 'qsv'];

export const ACCEL_LABELS: Record<AccelKind, string> = {
  vaapi: 'VAAPI (AMD / Intel)',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
};

export interface Accel {
  kind: AccelKind;
  /** The render node for vaapi and qsv. */
  device: string | null;
  /** nvenc only: whether scaling can stay on the GPU (scale_cuda). */
  gpuScale: boolean;
}

export interface HwCapabilities {
  ffmpegVersion: string | null;
  vaapiDevice: string | null;
  /** Compiled into this ffmpeg build. */
  encoders: Record<AccelKind, boolean>;
  /** Passed the start-up test encode. */
  available: Record<AccelKind, boolean>;
  /** What the start-up test found, per route, in plain words for the settings page. */
  tested: Record<AccelKind, string>;
  /** ffmpeg's own error from a failed test encode, for anyone debugging. */
  details: Record<AccelKind, string | null>;
  nvencGpuScale: boolean;
  detectedAt: number;
  error: string | null;
}

const VAAPI_DEVICE_CANDIDATES = ['/dev/dri/renderD128', '/dev/dri/renderD129', '/dev/dri/card0'];

const none = (): Record<AccelKind, boolean> => ({ vaapi: false, qsv: false, nvenc: false });

let caps: HwCapabilities = {
  ffmpegVersion: null,
  vaapiDevice: null,
  encoders: none(),
  available: none(),
  tested: { vaapi: 'Not tested yet', qsv: 'Not tested yet', nvenc: 'Not tested yet' },
  details: { vaapi: null, qsv: null, nvenc: null },
  nvencGpuScale: false,
  detectedAt: 0,
  error: null,
};

function run(args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(config.ffmpeg, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(err);
      else resolve((stdout || '') + (stderr || ''));
    });
  });
}

/** Runs a short test encode; resolves to null on success, or the last error line. */
function tryEncode(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      config.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-frames:v', '10', '-f', 'null', '-'],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve(null);
        const lines = String(stderr || err.message).trim().split('\n').filter(Boolean);
        resolve(lines.pop()?.slice(0, 300) ?? 'failed');
      },
    );
  });
}

const TEST_INPUT = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'];

const WORKING = 'Working';
const NO_DEVICE = 'No GPU is passed through to the container (/dev/dri)';

/**
 * ffmpeg's errors from a failed test encode are accurate but cryptic — "Error
 * parsing global options" is how Quick Sync says "this is not an Intel GPU".
 * This turns them into a sentence; the original stays available as detail.
 */
function explain(kind: AccelKind, raw: string): string {
  if (kind === 'nvenc') {
    if (/driver does not support the required nvenc api version|minimum required nvidia driver/i.test(raw)) {
      return 'The NVIDIA driver on the host is too old for this ffmpeg';
    }
    if (/out of memory|incompatible client key|OpenEncodeSessionEx failed/i.test(raw)) {
      return 'The NVIDIA GPU is busy or refused the encoder';
    }
    return 'No NVIDIA GPU is available to the container';
  }
  if (kind === 'qsv') return 'No Intel GPU with Quick Sync was found';
  if (/permission denied/i.test(raw)) return 'The container is not allowed to use the GPU (check RENDER_GID)';
  if (/failed to initialise vaapi|no va display|vaInitialize failed|cannot open/i.test(raw)) {
    return 'The GPU could not be opened';
  }
  return 'The GPU did not accept a test encode';
}

export async function detectHardware(): Promise<HwCapabilities> {
  const next: HwCapabilities = {
    ffmpegVersion: null,
    vaapiDevice: null,
    encoders: none(),
    available: none(),
    tested: { vaapi: 'Not tested yet', qsv: 'Not tested yet', nvenc: 'Not tested yet' },
    details: { vaapi: null, qsv: null, nvenc: null },
    nvencGpuScale: false,
    detectedAt: Date.now(),
    error: null,
  };

  try {
    const version = await run(['-hide_banner', '-version']);
    const match = version.match(/ffmpeg version (\S+)/i);
    next.ffmpegVersion = match ? match[1] : version.split('\n')[0]?.trim() || null;
  } catch (err: any) {
    next.error = `ffmpeg is not usable: ${err?.message ?? err}`;
    caps = next;
    return caps;
  }

  let filters = '';
  try {
    const encoders = await run(['-hide_banner', '-encoders']);
    next.encoders = {
      vaapi: /\bh264_vaapi\b/.test(encoders),
      qsv: /\bh264_qsv\b/.test(encoders),
      nvenc: /\bh264_nvenc\b/.test(encoders),
    };
    filters = await run(['-hide_banner', '-filters']);
  } catch {
    /* leave everything off */
  }

  for (const device of VAAPI_DEVICE_CANDIDATES) {
    try {
      fs.accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
      next.vaapiDevice = device;
      break;
    } catch {
      /* not this one */
    }
  }

  const device = next.vaapiDevice;

  // VAAPI — AMD and Intel.
  if (!next.encoders.vaapi) next.tested.vaapi = 'Not included in this ffmpeg build';
  else if (!device) next.tested.vaapi = NO_DEVICE;
  else {
    const error = await tryEncode([
      '-vaapi_device', device, ...TEST_INPUT,
      '-vf', 'format=nv12,hwupload,scale_vaapi=w=320:h=180:format=nv12',
      '-c:v', 'h264_vaapi', '-rc_mode', 'VBR', '-b:v', '1M',
    ]);
    next.available.vaapi = error === null;
    next.tested.vaapi = error === null ? WORKING : explain('vaapi', error);
    next.details.vaapi = error;
  }

  // Quick Sync — Intel only, initialised on top of the same render node.
  if (!next.encoders.qsv) next.tested.qsv = 'Not included in this ffmpeg build';
  else if (!device) next.tested.qsv = NO_DEVICE;
  else {
    const error = await tryEncode([
      '-init_hw_device', `vaapi=va:${device}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs',
      ...TEST_INPUT,
      '-vf', 'format=nv12,hwupload=extra_hw_frames=64,format=qsv',
      '-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '1M', '-forced_idr', '1',
    ]);
    next.available.qsv = error === null;
    next.tested.qsv = error === null ? WORKING : explain('qsv', error);
    next.details.qsv = error;
  }

  // NVENC — first with scaling on the GPU, then with scaling on the CPU,
  // since not every ffmpeg build includes the CUDA filters.
  if (!next.encoders.nvenc) next.tested.nvenc = 'Not included in this ffmpeg build';
  else {
    const nvencArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', '1M', '-forced-idr', '1'];
    let error: string | null = 'scale_cuda filter not available';
    if (/\bscale_cuda\b/.test(filters)) {
      error = await tryEncode([
        '-init_hw_device', 'cuda=cu', '-filter_hw_device', 'cu', ...TEST_INPUT,
        '-vf', 'format=nv12,hwupload,scale_cuda=w=320:h=180:format=nv12',
        ...nvencArgs,
      ]);
    }
    if (error === null) {
      next.nvencGpuScale = true;
    } else {
      error = await tryEncode([...TEST_INPUT, '-vf', 'scale=320:180,format=yuv420p', ...nvencArgs]);
    }
    next.available.nvenc = error === null;
    next.tested.nvenc = error === null ? (next.nvencGpuScale ? WORKING : 'Working (scaling on the CPU)') : explain('nvenc', error);
    next.details.nvenc = error;
  }

  caps = next;
  return caps;
}

export function hardwareCapabilities(): HwCapabilities {
  return caps;
}

/** The hardware route to use for new transcodes, or null for software. */
export function chosenAccel(): Accel | null {
  const mode = getSettings().transcode.hwaccel;
  if (mode === 'none') return null;
  const kind = mode === 'auto' ? AUTO_ORDER.find((k) => caps.available[k]) : caps.available[mode] ? mode : undefined;
  if (!kind) return null;
  return { kind, device: kind === 'nvenc' ? null : caps.vaapiDevice, gpuScale: kind === 'nvenc' && caps.nvencGpuScale };
}

export function hardwareStatus(): string {
  const mode = getSettings().transcode.hwaccel;
  if (mode === 'none') return 'Software (libx264) — hardware disabled in settings';
  const accel = chosenAccel();
  if (accel) {
    const where = accel.device ? ` on ${accel.device}` : '';
    return `${ACCEL_LABELS[accel.kind]} hardware encoding${where}`;
  }
  if (mode !== 'auto') return `Software (libx264) — ${ACCEL_LABELS[mode]} is not available: ${caps.tested[mode].toLowerCase()}`;
  return 'Software (libx264) — no working hardware encoder found';
}
