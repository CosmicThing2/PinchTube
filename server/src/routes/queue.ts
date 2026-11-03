/*
 * routes/queue.ts — the API for each user's play queue.
 *
 *   GET    /api/queue              the queue, in order
 *   POST   /api/queue              add a video to the end
 *   DELETE /api/queue/:videoId     remove one video
 *   POST   /api/queue/clear        empty it
 *   POST   /api/queue/move         nudge a video up or down one place
 *   POST   /api/queue/order        put it in a given order (not used by the
 *                                  web app at the moment, which uses /move)
 * Every change replies with the whole queue so the web app can redraw it.
 * The database work is in lib/videos.ts; the web side is
 * web/src/lib/queue-context.tsx and pages/Queue.tsx.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  addToQueue,
  clearQueue,
  getVideo,
  listQueue,
  moveInQueue,
  removeFromQueue,
  reorderQueue,
} from '../lib/videos.js';

/** The signed-in user's queue, as every route here replies. */
function queueOf(request: FastifyRequest) {
  const items = listQueue(request.user!);
  return { items, count: items.length };
}

export function registerQueueRoutes(app: FastifyInstance): void {
  app.get('/api/queue', async (request) => queueOf(request));

  app.post('/api/queue', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const videoId = String(body.videoId ?? '');
    if (!getVideo(request.user!, videoId)) return reply.code(404).send({ error: 'Video not found' });

    if (!addToQueue(request.user!.id, videoId)) return reply.code(400).send({ error: 'The queue is full' });
    return queueOf(request);
  });

  app.delete('/api/queue/:videoId', async (request) => {
    const { videoId } = request.params as any;
    removeFromQueue(request.user!.id, String(videoId));
    return queueOf(request);
  });

  app.post('/api/queue/clear', async (request) => {
    clearQueue(request.user!.id);
    return { items: [], count: 0 };
  });

  app.post('/api/queue/move', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const videoId = String(body.videoId ?? '');
    const direction = Number(body.direction) < 0 ? -1 : 1;
    if (!videoId) return reply.code(400).send({ error: 'videoId is required' });

    moveInQueue(request.user!.id, videoId, direction);
    return queueOf(request);
  });

  app.post('/api/queue/order', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (!Array.isArray(body.ids)) return reply.code(400).send({ error: 'ids must be a list' });
    reorderQueue(request.user!.id, body.ids.slice(0, 10000).map(String));
    return queueOf(request);
  });
}
