import type { FastifyInstance } from 'fastify';
import { settingsFor } from '../settings.js';
import {
  canSeeChannel,
  continueWatching,
  getChannel,
  getVideo,
  libraryStats,
  listChannels,
  mapVideo,
  queryVideos,
  recentlyAdded,
  rediscover,
  saveProgress,
  setWatched,
  sizeBreakdown,
  type SortKey,
} from '../lib/videos.js';
import { AUDIO_RENDITION, allowOriginal, renditionsFor } from '../media/renditions.js';

const SORTS: SortKey[] = ['date_desc', 'date_asc', 'title_asc', 'title_desc', 'added_desc', 'added_asc'];

function parseSort(raw: unknown, fallback: SortKey): SortKey {
  const value = String(raw ?? '');
  return (SORTS.includes(value as SortKey) ? value : fallback) as SortKey;
}

/**
 * Pinned channels come first, in the order they were pinned; everything else
 * follows in whatever order `channelOrder` produced. Channels with no saved
 * entry are simply unpinned and visible, so a newly scanned channel appears on
 * its own without needing to be configured.
 */
function orderChannelRows(
  channels: { id: string }[],
  saved: { id: string; enabled: boolean; pinned?: boolean }[],
  includeHidden = false,
): any[] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const settingFor = new Map(saved.map((entry) => [entry.id, entry]));

  const pinned: any[] = [];
  for (const entry of saved) {
    if (!entry.pinned) continue;
    const channel = byId.get(entry.id);
    if (!channel) continue;
    if (entry.enabled === false && !includeHidden) continue;
    pinned.push(channel);
  }

  const pinnedIds = new Set(pinned.map((channel) => channel.id));
  const rest = channels.filter((channel) => {
    if (pinnedIds.has(channel.id)) return false;
    const entry = settingFor.get(channel.id);
    if (entry && entry.enabled === false && !includeHidden) return false;
    return true;
  });

  return [...pinned, ...rest];
}

export function registerLibraryRoutes(app: FastifyInstance): void {
  app.get('/api/home', async (request) => {
    const viewer = request.user!;
    const settings = settingsFor(viewer.id);
    const rows: any[] = [];

    for (const row of settings.home.rows) {
      if (!row.enabled) continue;

      if (row.id === 'continue') {
        const items = continueWatching(viewer, row.limit);
        if (items.length) rows.push({ id: 'continue', kind: 'videos', title: row.title, items });
      } else if (row.id === 'recent') {
        const items = recentlyAdded(viewer, row.limit, settings.ui.hideWatched);
        if (items.length) rows.push({ id: 'recent', kind: 'videos', title: row.title, items, link: '/videos?sort=added_desc' });
      } else if (row.id === 'random') {
        const items = rediscover(viewer, row.limit);
        if (items.length) rows.push({ id: 'random', kind: 'videos', title: row.title, items });
      } else if (row.id === 'channels') {
        const channels = orderChannelRows(
          listChannels(viewer, settings.home.channelOrder),
          settings.home.channelRows,
        ).slice(0, row.limit);
        const perChannel = row.videosPerChannel ?? 15;
        for (const channel of channels) {
          const { items } = queryVideos(viewer, {
            channelId: channel.id,
            sort: 'date_desc',
            limit: perChannel,
            watched: settings.ui.hideWatched ? 'unwatched' : 'all',
          });
          if (!items.length) continue;
          rows.push({
            id: `channel:${channel.id}`,
            kind: 'videos',
            title: channel.title,
            channel,
            items,
            link: `/channel/${channel.id}`,
          });
        }
      }
    }

    return { rows };
  });

  // The saved list controls order and visibility; anything not in it (a channel
  // added since the settings were last saved) follows on, visible by default.
  app.get('/api/home/channels', async (request) => {
    const viewer = request.user!;
    const settings = settingsFor(viewer.id);
    const all = listChannels(viewer, settings.home.channelOrder);
    const configured = new Map(settings.home.channelRows.map((row) => [row.id, row]));
    return {
      items: orderChannelRows(all, settings.home.channelRows, true).map((channel) => ({
        id: channel.id,
        title: channel.title,
        videoCount: channel.videoCount,
        enabled: configured.get(channel.id)?.enabled !== false,
        pinned: configured.get(channel.id)?.pinned === true,
      })),
    };
  });

  app.get('/api/videos', async (request) => {
    const q = (request.query ?? {}) as any;
    const viewer = request.user!;
    const settings = settingsFor(viewer.id);
    const limit = Math.min(200, Math.max(1, parseInt(String(q.limit ?? settings.ui.pageSize), 10) || settings.ui.pageSize));
    const page = Math.min(100000, Math.max(1, parseInt(String(q.page ?? 1), 10) || 1));
    const watchedFilter =
      q.watched === 'watched' || q.watched === 'unwatched'
        ? q.watched
        : settings.ui.hideWatched
          ? 'unwatched'
          : 'all';

    const result = queryVideos(viewer, {
      channelId: q.channel ? String(q.channel) : undefined,
      search: q.q ? String(q.q).slice(0, 200) : undefined,
      sort: parseSort(q.sort, settings.ui.defaultSort),
      watched: watchedFilter,
      limit,
      offset: (page - 1) * limit,
    });

    return { ...result, page, pageSize: limit };
  });

  app.get('/api/videos/:id', async (request, reply) => {
    const { id } = request.params as any;
    const viewer = request.user!;
    const row = getVideo(viewer, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });

    const settings = settingsFor(viewer.id);
    const video = mapVideo(row, viewer);
    const renditions = renditionsFor(row.height, settings.playback.maxQuality).map((r) => ({
      id: r.id,
      label: r.label,
      height: r.height,
      bitrate: r.bitrate,
    }));

    // What comes next in this channel, used for autoplay and the "up next" list.
    const upNext = queryVideos(viewer, { channelId: row.channel_id, sort: 'date_desc', limit: 25 }).items.filter(
      (v) => v.id !== video.id,
    );

    return {
      video,
      // False when the video was reached through a playlist that lets the
      // viewer play it without access to its channel, so the page does not
      // link to a channel page they cannot open.
      channelAccessible: canSeeChannel(viewer, row.channel_id),
      playback: {
        renditions,
        original: allowOriginal(settings.playback.maxQuality)
          ? {
              available: true,
              container: row.container,
              vcodec: row.vcodec,
              acodec: row.acodec,
              height: row.height,
              width: row.width,
              size: row.size,
            }
          : { available: false },
        defaults: {
          wifi: settings.playback.defaultQualityWifi,
          cellular: settings.playback.defaultQualityCellular,
        },
        audioOnly: { id: AUDIO_RENDITION.id, label: AUDIO_RENDITION.label, available: Boolean(row.acodec) },
        subtitlesDefault: settings.playback.subtitlesDefault,
        subtitleFontScale: settings.playback.subtitleFontScale,
        autoplayNext: settings.playback.autoplayNext,
        autoplayOnOpen: settings.playback.autoplayOnOpen,
        centerPlayButton: settings.playback.centerPlayButton,
        fadeOutSeconds: settings.playback.fadeOutSeconds,
        sponsorSkipPrompt: settings.playback.sponsorSkipPrompt,
        sponsorAutoSkip: settings.playback.sponsorAutoSkip,
        gestureVolume: settings.playback.gestureVolume,
        gestureBrightness: settings.playback.gestureBrightness,
        queueQuality: settings.playback.queueQuality,
        seekStep: settings.playback.seekStep,
        resumeThresholdSeconds: settings.playback.resumeThresholdSeconds,
      },
      upNext,
    };
  });

  app.post('/api/videos/:id/progress', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body ?? {}) as any;
    const row = getVideo(request.user!, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });

    const finite = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const position = Math.max(0, finite(body.position));
    const duration = Math.max(0, finite(body.duration) || row.duration || 0);
    saveProgress(request.user!.id, row.id, position, duration);
    return { ok: true };
  });

  app.post('/api/videos/:id/watched', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body ?? {}) as any;
    const row = getVideo(request.user!, String(id));
    if (!row) return reply.code(404).send({ error: 'Video not found' });

    setWatched(request.user!.id, row.id, body.watched !== false, row.duration);
    return { ok: true };
  });

  app.get('/api/channels', async (request) => {
    const q = (request.query ?? {}) as any;
    const order = q.order === 'recent' ? 'recent' : 'name';
    return { items: listChannels(request.user!, order) };
  });

  app.get('/api/channels/:id', async (request, reply) => {
    const { id } = request.params as any;
    const channel = getChannel(request.user!, String(id));
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    return { channel };
  });

  app.get('/api/stats', async (request) => libraryStats(request.user!));

  // Part of the System section, which is for administrators only.
  app.get('/api/stats/sizes', { config: { admin: true } }, async () => sizeBreakdown());
}
