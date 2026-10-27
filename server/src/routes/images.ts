import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { canSeeChannelArt, canSeeVideo, channelArtwork } from '../lib/videos.js';
import { contentTypeFor, normaliseWidth, resizedImage } from '../media/images.js';
import { posterForVideo } from '../media/poster.js';

async function sendImage(
  request: FastifyRequest,
  reply: FastifyReply,
  source: string | null,
  widthRaw: unknown,
): Promise<FastifyReply> {
  if (!source) return reply.code(404).send({ error: 'No artwork' });

  let served: { file: string; contentType: string };
  try {
    served = await resizedImage(source, normaliseWidth(widthRaw));
  } catch {
    return reply.code(404).send({ error: 'Artwork file is missing' });
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(served.file);
  } catch {
    return reply.code(404).send({ error: 'Artwork file is missing' });
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (request.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }

  reply.header('Content-Type', served.contentType || contentTypeFor(served.file));
  reply.header('Content-Length', String(stat.size));
  reply.header('Cache-Control', 'private, max-age=604800');
  reply.header('ETag', etag);
  return reply.send(fs.createReadStream(served.file));
}

export function registerImageRoutes(app: FastifyInstance): void {
  app.get('/api/images/video/:id/thumb', async (request, reply) => {
    const { id } = request.params as any;
    const row = db
      .prepare('SELECT thumb, channel_id, path, duration, mtime FROM videos WHERE id = ?')
      .get(String(id)) as
      | {
          thumb: string | null;
          channel_id: string;
          path: string;
          duration: number | null;
          mtime: number | null;
        }
      | undefined;
    if (!row || !canSeeVideo(request.user!, String(id))) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    let source = row.thumb;
    if (!source) {
      source = await posterForVideo(String(id), row.path, row.duration, row.mtime);
    }
    // Last resort is the channel poster, so cards never render as empty boxes.
    if (!source) source = channelArtwork(row.channel_id, 'poster');

    return sendImage(request, reply, source, (request.query as any)?.w);
  });

  app.get('/api/images/channel/:id/:kind', async (request, reply) => {
    const { id, kind } = request.params as any;
    if (kind !== 'poster' && kind !== 'banner' && kind !== 'fanart') {
      return reply.code(400).send({ error: 'Unknown artwork type' });
    }
    if (!canSeeChannelArt(request.user!, String(id))) return reply.code(404).send({ error: 'No artwork' });
    const source = channelArtwork(String(id), kind);
    return sendImage(request, reply, source, (request.query as any)?.w);
  });
}
