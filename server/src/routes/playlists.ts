import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getVideo } from '../lib/videos.js';
import {
  addToPlaylist,
  cleanName,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  playlistVideos,
  playlistsContaining,
  removeFromPlaylist,
  reorderPlaylist,
  setPlaylistQuality,
  updatePlaylist,
  validQuality,
} from '../lib/playlists.js';

const PLAYLISTS_PER_USER_MAX = 500;

function playlistId(request: FastifyRequest): number {
  const raw = (request.params as any).id;
  const id = Number.parseInt(String(raw), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** The full playlist as the viewer sees it, or a 404 when they may not see it. */
function sendPlaylist(request: FastifyRequest, reply: FastifyReply, id: number) {
  const viewer = request.user!;
  const playlist = getPlaylist(viewer, id);
  if (!playlist) return reply.code(404).send({ error: 'Playlist not found' });
  return { playlist, items: playlistVideos(viewer, id) };
}

export function registerPlaylistRoutes(app: FastifyInstance): void {
  app.get('/api/playlists', async (request) => {
    const q = (request.query ?? {}) as any;
    const viewer = request.user!;
    return {
      items: listPlaylists(viewer),
      // Lets the "Save to playlist" menu tick the lists a video is already in.
      containing: q.video ? playlistsContaining(viewer.id, String(q.video)) : [],
    };
  });

  app.post('/api/playlists', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const viewer = request.user!;
    const name = cleanName(body.name);
    if (!name) return reply.code(400).send({ error: 'Give the playlist a name' });
    const quality = body.quality === undefined ? 'auto' : validQuality(body.quality);
    if (!quality) return reply.code(400).send({ error: 'Unknown quality' });
    const mine = listPlaylists(viewer).filter((p) => p.mine).length;
    if (mine >= PLAYLISTS_PER_USER_MAX) return reply.code(400).send({ error: 'That is a lot of playlists' });

    const id = createPlaylist(viewer.id, name, body.shared === true, quality);
    if (typeof body.videoId === 'string' && getVideo(viewer, body.videoId)) {
      addToPlaylist(viewer.id, id, body.videoId);
    }
    return sendPlaylist(request, reply, id);
  });

  app.get('/api/playlists/:id', async (request, reply) => sendPlaylist(request, reply, playlistId(request)));

  app.patch('/api/playlists/:id', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const viewer = request.user!;
    const id = playlistId(request);
    if (!getPlaylist(viewer, id)) return reply.code(404).send({ error: 'Playlist not found' });

    // Quality is the viewer's own preference, so anyone who can open the
    // playlist may set it. Everything else belongs to the owner.
    if (body.quality !== undefined) {
      const quality = validQuality(body.quality);
      if (!quality) return reply.code(400).send({ error: 'Unknown quality' });
      setPlaylistQuality(viewer.id, id, quality);
    }

    const patch: { name?: string; shared?: boolean; strict?: boolean } = {};
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) return reply.code(400).send({ error: 'Give the playlist a name' });
      patch.name = name;
    }
    if (body.shared !== undefined) patch.shared = body.shared === true;
    if (body.strict !== undefined) patch.strict = body.strict !== false;
    if (Object.keys(patch).length && !updatePlaylist(viewer.id, id, patch)) {
      return reply.code(403).send({ error: 'Only the owner can change this playlist' });
    }
    return sendPlaylist(request, reply, id);
  });

  app.delete('/api/playlists/:id', async (request, reply) => {
    if (!deletePlaylist(request.user!.id, playlistId(request))) {
      return reply.code(404).send({ error: 'Playlist not found' });
    }
    return { ok: true };
  });

  app.post('/api/playlists/:id/items', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const id = playlistId(request);
    const videoId = String(body.videoId ?? '');
    if (!getVideo(request.user!, videoId)) return reply.code(404).send({ error: 'Video not found' });
    const result = addToPlaylist(request.user!.id, id, videoId);
    if (result === 'forbidden') return reply.code(404).send({ error: 'Playlist not found' });
    if (result === 'full') return reply.code(400).send({ error: 'This playlist is full' });
    return sendPlaylist(request, reply, id);
  });

  app.delete('/api/playlists/:id/items/:videoId', async (request, reply) => {
    const id = playlistId(request);
    const { videoId } = request.params as any;
    if (!removeFromPlaylist(request.user!.id, id, String(videoId))) {
      return reply.code(404).send({ error: 'Playlist not found' });
    }
    return sendPlaylist(request, reply, id);
  });

  app.post('/api/playlists/:id/order', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const id = playlistId(request);
    if (!Array.isArray(body.ids)) return reply.code(400).send({ error: 'ids must be a list' });
    if (!reorderPlaylist(request.user!.id, id, body.ids.slice(0, 10000).map(String))) {
      return reply.code(404).send({ error: 'Playlist not found' });
    }
    return sendPlaylist(request, reply, id);
  });
}
