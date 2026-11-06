/*
 * routes/channels.ts — the API behind a channel's Edit button.
 *
 *   GET    /api/channels/:id/edits       which parts have been edited
 *   PUT    /api/channels/:id             change the title and/or description
 *                                        (null puts one back to the original)
 *   PUT    /api/channels/:id/art/:kind   upload a poster, banner or fanart
 *                                        (the request body is the image itself)
 *   DELETE /api/channels/:id/art/:kind   go back to the original image
 *
 * Channels are shared by everyone, so all of these are for administrators
 * only. Each one answers with the updated channel. Edits are stored by
 * lib/channel-edits.ts; nothing here writes to the media folder. Uploads are
 * decoded and re-encoded (media/images.ts), so only a plain JPEG made by the
 * server is ever kept or served. The web side is
 * web/src/components/ChannelEditDialog.tsx.
 */

import type { FastifyInstance } from 'fastify';
import { getChannel } from '../lib/videos.js';
import {
  CHANNEL_ART_KINDS,
  artTarget,
  editSummary,
  removeChannelArt,
  saveChannelText,
  touchChannelArt,
  type ChannelArtKind,
  type ChannelEdit,
} from '../lib/channel-edits.js';
import { refreshChannel } from '../library/scanner.js';
import { BadImageError, saveChannelImage } from '../media/images.js';

const MAX_TITLE_LENGTH = 200;
const MAX_PLOT_LENGTH = 20_000;
/** The largest image that can be uploaded. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** The longest side an uploaded image is kept at, by kind. */
const MAX_SIDE: Record<ChannelArtKind, number> = { poster: 1024, banner: 2560, fanart: 2560 };

export function registerChannelRoutes(app: FastifyInstance): void {
  // Image uploads arrive as the raw file rather than JSON.
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  // Which parts have been edited, so the dialog knows what can be reset.
  app.get('/api/channels/:id/edits', { config: { admin: true } }, async (request, reply) => {
    const channel = getChannel(request.user!, String((request.params as any).id));
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    return editSummary(channel.id);
  });

  // The title and description.
  app.put('/api/channels/:id', { config: { admin: true } }, async (request, reply) => {
    const channel = getChannel(request.user!, String((request.params as any).id));
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const changes: Partial<ChannelEdit> = {};

    if (body.title === null) {
      changes.title = null;
    } else if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > MAX_TITLE_LENGTH) {
        return reply.code(400).send({ error: `The name must be 1 to ${MAX_TITLE_LENGTH} characters` });
      }
      changes.title = title;
    }

    if (body.plot === null) {
      changes.plot = null;
    } else if (body.plot !== undefined) {
      if (typeof body.plot !== 'string' || body.plot.length > MAX_PLOT_LENGTH) {
        return reply.code(400).send({ error: `The description can be at most ${MAX_PLOT_LENGTH} characters` });
      }
      changes.plot = body.plot.trim();
    }

    saveChannelText(channel.id, changes);
    await refreshChannel(channel.id);
    return { channel: getChannel(request.user!, channel.id) };
  });

  // A new poster, banner or fanart.
  app.put(
    '/api/channels/:id/art/:kind',
    { config: { admin: true }, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const { id, kind } = request.params as any;
      if (!CHANNEL_ART_KINDS.includes(kind)) return reply.code(400).send({ error: 'Unknown artwork type' });
      const channel = getChannel(request.user!, String(id));
      if (!channel) return reply.code(404).send({ error: 'Channel not found' });
      if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: 'Use a JPEG, PNG or WebP image' });

      try {
        await saveChannelImage(request.body, artTarget(channel.id, kind), MAX_SIDE[kind as ChannelArtKind]);
      } catch (err) {
        if (err instanceof BadImageError) return reply.code(400).send({ error: err.message });
        throw err;
      }

      touchChannelArt(channel.id);
      await refreshChannel(channel.id);
      return { channel: getChannel(request.user!, channel.id) };
    },
  );

  // Back to the image in the channel's folder.
  app.delete('/api/channels/:id/art/:kind', { config: { admin: true } }, async (request, reply) => {
    const { id, kind } = request.params as any;
    if (!CHANNEL_ART_KINDS.includes(kind)) return reply.code(400).send({ error: 'Unknown artwork type' });
    const channel = getChannel(request.user!, String(id));
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    removeChannelArt(channel.id, kind);
    await refreshChannel(channel.id);
    return { channel: getChannel(request.user!, channel.id) };
  });
}
