import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getSettings, settingsFor } from '../settings.js';
import { getVideo, parseSubtitles } from '../lib/videos.js';
import { allowOriginal, findRendition, renditionsFor } from '../media/renditions.js';
import { masterPlaylist, segmentCountFor, variantPlaylist } from '../media/hls.js';
import { ensureSegment, type TranscodeSource } from '../media/transcoder.js';

const CONTAINER_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
};

function srtToVtt(input: string): string {
  const body = input
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 00:00:01,234 --> 00:00:03,456   (SRT uses a comma, WebVTT a full stop)
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.trim()}\n`;
}

export function registerStreamRoutes(app: FastifyInstance): void {
  // ---- direct play of the untouched file, with byte-range support ----------
  app.get('/api/stream/:id/original', async (request, reply) => {
    const { id } = request.params as any;
    const row = getVideo(request.user!, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });
    if (!allowOriginal(settingsFor(request.user!.id).playback.maxQuality)) {
      return reply.code(403).send({ error: 'Original quality is disabled in settings' });
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(row.path);
    } catch {
      return reply.code(404).send({ error: 'File is missing from disk' });
    }

    const contentType = CONTAINER_TYPES[path.extname(row.path).toLowerCase()] ?? 'application/octet-stream';
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'private, max-age=3600');

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const hasStart = match[1] !== '';
        const hasEnd = match[2] !== '';
        let start = hasStart ? parseInt(match[1], 10) : 0;
        let end = hasEnd ? parseInt(match[2], 10) : stat.size - 1;

        if (!hasStart && hasEnd) {
          // "bytes=-500" means the final 500 bytes.
          start = Math.max(0, stat.size - parseInt(match[2], 10));
          end = stat.size - 1;
        }

        if (start >= stat.size || start > end) {
          reply.header('Content-Range', `bytes */${stat.size}`);
          return reply.code(416).send();
        }
        end = Math.min(end, stat.size - 1);

        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        reply.header('Content-Length', String(end - start + 1));
        return reply.send(fs.createReadStream(row.path, { start, end }));
      }
    }

    reply.header('Content-Length', String(stat.size));
    return reply.send(fs.createReadStream(row.path));
  });

  // ---- HLS ----------------------------------------------------------------
  app.get('/api/stream/:id/master.m3u8', async (request, reply) => {
    const { id } = request.params as any;
    const row = getVideo(request.user!, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });
    if (!row.duration) return reply.code(409).send({ error: 'Video duration is unknown — run a full rescan' });

    const renditions = renditionsFor(row.height, settingsFor(request.user!.id).playback.maxQuality);
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(masterPlaylist({ width: row.width, height: row.height }, renditions));
  });

  app.get('/api/stream/:id/:rendition/index.m3u8', async (request, reply) => {
    const { id, rendition } = request.params as any;
    const row = getVideo(request.user!, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });
    if (!row.duration) return reply.code(409).send({ error: 'Video duration is unknown — run a full rescan' });
    if (!findRendition(String(rendition))) return reply.code(404).send({ error: 'Unknown quality' });

    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(variantPlaylist(row.duration, getSettings().transcode.segmentSeconds));
  });

  app.get('/api/stream/:id/:rendition/:segment', async (request, reply) => {
    const { id, rendition, segment } = request.params as any;
    const match = /^seg-(\d{5})\.ts$/.exec(String(segment));
    if (!match) return reply.code(404).send({ error: 'Not a segment' });

    const row = getVideo(request.user!, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });
    if (!row.duration) return reply.code(409).send({ error: 'Video duration is unknown' });

    const rend = findRendition(String(rendition));
    if (!rend) return reply.code(404).send({ error: 'Unknown quality' });

    const settings = getSettings();
    const index = parseInt(match[1], 10);
    const total = segmentCountFor(row.duration, settings.transcode.segmentSeconds);
    if (index < 0 || index >= total) return reply.code(404).send({ error: 'Segment out of range' });

    const source: TranscodeSource = {
      id: row.id,
      path: row.path,
      duration: row.duration,
      width: row.width,
      height: row.height,
    };

    try {
      const file = await ensureSegment(source, rend, index);
      const stat = await fsp.stat(file);
      reply.header('Content-Type', 'video/mp2t');
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(fs.createReadStream(file));
    } catch (err: any) {
      request.log.warn(`segment ${index} of ${row.id}/${rend.id} failed: ${err?.message ?? err}`);
      return reply.code(503).send({ error: 'Could not produce that segment' });
    }
  });

  // ---- sidecar subtitles, always served as WebVTT --------------------------
  app.get('/api/stream/:id/subtitles/:file', async (request, reply) => {
    const params = request.params as any;
    const row = getVideo(request.user!, String(params.id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });

    const tracks = parseSubtitles(row.subtitles);
    const index = parseInt(String(params.file).replace(/\.vtt$/i, ''), 10);
    const track = tracks[index];
    if (!track) return reply.code(404).send({ error: 'No such subtitle track' });

    let text: string;
    try {
      text = await fsp.readFile(track.file, 'utf8');
    } catch {
      return reply.code(404).send({ error: 'Subtitle file is missing' });
    }

    reply.header('Content-Type', 'text/vtt; charset=utf-8');
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(track.ext === 'vtt' ? text : srtToVtt(text));
  });
}
