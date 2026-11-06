/*
 * routes/downloads.ts — the API behind the Download button.
 *
 *   POST /api/videos/:id/downloads/:quality        start making a copy at that quality
 *                                                  (or report on the one already coming)
 *   GET  /api/videos/:id/downloads/:quality        how the copy is coming along
 *   GET  /api/videos/:id/downloads/:quality/file   the finished copy
 *                                                  (?attachment=1 saves it as a file)
 *   DELETE /api/videos/:id/downloads/:quality      the browser has it; remove the copy
 *   POST /api/downloads/plan                       for "Download all": what each of
 *                                                  several videos would be saved at
 * Qualities are the converted ones (1080p, 720p…) and "audio". "Original"
 * needs no preparing: it is the video file itself, sent by
 * GET /api/stream/:id/original (routes/stream.ts).
 *
 * The same rules as streaming apply: the user must be able to see the video,
 * and cannot get a quality above their "maximum quality" setting. The copies
 * are made by media/downloads.ts; the web side is
 * web/src/components/DownloadDialog.tsx and web/src/lib/offline.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { settingsFor } from '../settings.js';
import { getVideo, type VideoRow } from '../lib/videos.js';
import { downloadName, sendMediaFile } from '../lib/send-file.js';
import {
  AUDIO_RENDITION,
  QUALITY_CHOICES,
  allowOriginal,
  isAudioOnly,
  renditionsFor,
  shortSide,
  type Rendition,
} from '../media/renditions.js';
import {
  DownloadsBusyError,
  downloadContentType,
  downloadExtension,
  downloadStatus,
  readyCopy,
  releaseCopy,
  requestDownload,
} from '../media/downloads.js';
import type { TranscodeSource } from '../media/transcoder.js';

/**
 * The video and quality a request is about, if this user may have them;
 * otherwise sends the error reply and returns null.
 */
function lookUp(
  request: FastifyRequest,
  reply: FastifyReply,
): { row: VideoRow; rendition: Rendition; source: TranscodeSource } | null {
  const { id, quality } = request.params as any;
  const viewer = request.user!;
  const row = getVideo(viewer, String(id));
  if (!row) {
    reply.code(404).send({ error: 'Video not found' });
    return null;
  }
  if (!row.duration) {
    reply.code(409).send({ error: 'Video duration is unknown — run a full rescan' });
    return null;
  }

  const wanted = String(quality);
  const offered = renditionsFor(shortSide(row.width, row.height), settingsFor(viewer.id).playback.maxQuality);
  const rendition =
    wanted === AUDIO_RENDITION.id ? (row.acodec ? AUDIO_RENDITION : undefined) : offered.find((r) => r.id === wanted);
  if (!rendition) {
    reply.code(400).send({ error: 'That quality is not available for this video' });
    return null;
  }

  const source = { id: row.id, path: row.path, duration: row.duration, width: row.width, height: row.height };
  return { row, rendition, source };
}

/** Kilobits per second of audio assumed when estimating a converted copy's size. */
const AUDIO_KBPS_ESTIMATE = 160;
/** The most videos one plan can cover; the same as the largest possible queue. */
const MAX_PLAN_VIDEOS = 5000;

/** What one video would be downloaded at. */
interface PlanItem {
  id: string;
  quality: string;
  label: string;
  /** Rough size in bytes (exact for Original), if it can be worked out. */
  bytes: number | null;
}

/**
 * The quality to download a video at when `wanted` is asked for: that one if
 * the video and this user's maximum quality allow it, otherwise the nearest.
 */
function planFor(row: VideoRow, wanted: string, maxQuality: string): PlanItem | null {
  const original = allowOriginal(maxQuality)
    ? { id: row.id, quality: 'original', label: 'Original', bytes: row.size }
    : null;
  // A conversion needs to know how long the video is.
  const duration = row.duration;
  if (!duration) return original;

  const converted = (rendition: Rendition): PlanItem => ({
    id: row.id,
    quality: rendition.id,
    label: rendition.label,
    bytes: (((isAudioOnly(rendition) ? 0 : rendition.bitrate) + AUDIO_KBPS_ESTIMATE) * 1000 * duration) / 8,
  });

  if (wanted === AUDIO_RENDITION.id && row.acodec) return converted(AUDIO_RENDITION);

  // Highest first, so Original falls back to the best this user may have.
  const offered = renditionsFor(shortSide(row.width, row.height), maxQuality);
  if (wanted === 'original') return original ?? converted(offered[0]);

  const target = parseInt(wanted, 10);
  if (!Number.isFinite(target)) return original ?? converted(offered[0]);
  let best = offered[0];
  for (const rendition of offered) {
    if (Math.abs(rendition.size - target) < Math.abs(best.size - target)) best = rendition;
  }
  return converted(best);
}

export function registerDownloadRoutes(app: FastifyInstance): void {
  // For "Download all": the quality and rough size of each video.
  app.post('/api/downloads/plan', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const quality = String(body.quality);
    if (!QUALITY_CHOICES.includes(quality)) return reply.code(400).send({ error: 'Unknown quality' });
    if (!Array.isArray(body.ids) || body.ids.length > MAX_PLAN_VIDEOS) {
      return reply.code(400).send({ error: 'Too many videos' });
    }

    const viewer = request.user!;
    const { maxQuality } = settingsFor(viewer.id).playback;
    const items: PlanItem[] = [];
    for (const id of body.ids) {
      const row = getVideo(viewer, String(id));
      const item = row ? planFor(row, quality, maxQuality) : null;
      if (item) items.push(item);
    }
    return { items };
  });

  // Start (or check on) a copy.
  app.post('/api/videos/:id/downloads/:quality', async (request, reply) => {
    const found = lookUp(request, reply);
    if (!found) return reply;
    try {
      return await requestDownload(found.source, found.rendition);
    } catch (err) {
      if (err instanceof DownloadsBusyError) return reply.code(429).send({ error: err.message });
      throw err;
    }
  });

  // How it is coming along; 404 when nobody has asked for it.
  app.get('/api/videos/:id/downloads/:quality', async (request, reply) => {
    const found = lookUp(request, reply);
    if (!found) return reply;
    const status = await downloadStatus(found.source, found.rendition);
    if (!status) return reply.code(404).send({ error: 'This download has not been started' });
    reply.header('Cache-Control', 'no-store');
    return status;
  });

  // The browser has saved it, so the copy can go.
  app.delete('/api/videos/:id/downloads/:quality', async (request, reply) => {
    const found = lookUp(request, reply);
    if (!found) return reply;
    await releaseCopy(found.source, found.rendition);
    return { ok: true };
  });

  // The finished copy.
  app.get('/api/videos/:id/downloads/:quality/file', async (request, reply) => {
    const found = lookUp(request, reply);
    if (!found) return reply;
    const ready = await readyCopy(found.source, found.rendition);
    if (!ready) return reply.code(404).send({ error: 'This download is not ready' });

    const { row, rendition } = found;
    const saveAs =
      (request.query as any)?.attachment === '1'
        ? downloadName(row.title, downloadExtension(rendition), ` (${rendition.label})`)
        : undefined;
    return sendMediaFile(request, reply, ready.file, downloadContentType(rendition), saveAs);
  });
}
