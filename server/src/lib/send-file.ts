/*
 * send-file.ts — sends a large media file, in pieces when asked.
 *
 * Browsers fetch video in byte ranges ("bytes=1000000-") so they can seek
 * and load as they go, and download managers use the same to resume. This
 * answers those requests, and can mark a file as a download with a proper
 * file name. Used for "Original" playback (routes/stream.ts) and for
 * downloads (routes/downloads.ts).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A safe file name for a download: the video's title with characters that
 * file systems reject taken out, and kept to a sensible length.
 */
export function downloadName(title: string, extension: string, suffix = ''): string {
  const base =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'video';
  return `${base}${suffix}.${extension}`;
}

/** The Content-Disposition value that saves a file under `name`, with a plain-ASCII fallback. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Sends `file`, honouring a byte-range request. With `saveAs`, the browser
 * is told to save it under that name rather than show it.
 */
export async function sendMediaFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string,
  saveAs?: string,
): Promise<FastifyReply> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return reply.code(404).send({ error: 'File is missing from disk' });
  }

  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);
  reply.header('Cache-Control', 'private, max-age=3600');
  if (saveAs) reply.header('Content-Disposition', attachment(saveAs));

  // A range request ("bytes=1000-") gets just that part of the file.
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
      return reply.send(fs.createReadStream(file, { start, end }));
    }
  }

  // No range asked for: the whole file.
  reply.header('Content-Length', String(stat.size));
  return reply.send(fs.createReadStream(file));
}
