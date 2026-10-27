import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  GLOBAL_SECTIONS,
  HWACCEL_MODES,
  getSettings,
  saveSettings,
  settingsFor,
  visibleSettings,
} from '../settings.js';
import { applyLibrarySettings, triggerScan } from '../library/manager.js';
import { scanState } from '../library/scanner.js';
import { hardwareCapabilities, hardwareStatus } from '../media/hwaccel.js';
import { APP_VERSION } from '../version.js';
import { activeJobs, resetTranscodes } from '../media/transcoder.js';
import { cacheSizeBytes, clearImageCache } from '../media/cache.js';
import { QUALITY_CHOICES } from '../media/renditions.js';
import { libraryStats } from '../lib/videos.js';

export function registerSettingsRoutes(app: FastifyInstance): void {
  const adminOnly = { config: { admin: true } };

  app.get('/api/settings', async (request) => {
    const user = request.user!;
    return {
      settings: visibleSettings(settingsFor(user.id), user.isAdmin),
      choices: {
        quality: QUALITY_CHOICES,
        sorts: ['date_desc', 'date_asc', 'title_asc', 'title_desc', 'added_desc', 'added_asc'],
        presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'],
        themes: ['system', 'dark', 'light'],
        hwaccel: HWACCEL_MODES,
      },
    };
  });

  app.put('/api/settings', async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as any;
    if (!user.isAdmin && GLOBAL_SECTIONS.some((section) => body && typeof body === 'object' && section in body)) {
      return reply.code(403).send({ error: 'Only an administrator can change library or transcoding settings' });
    }

    const previous = getSettings();
    const previousPath = previous.library.mediaPath;
    const previousSegment = previous.transcode.segmentSeconds;
    const next = saveSettings(user.id, body, user.isAdmin);

    if (user.isAdmin) {
      applyLibrarySettings();
      if (next.transcode.segmentSeconds !== previousSegment) await resetTranscodes();
      // Pointing at a different folder invalidates everything we knew.
      if (next.library.mediaPath !== previousPath) {
        void triggerScan('media path changed', true);
      }
    }

    return { settings: visibleSettings(next, user.isAdmin) };
  });

  app.post('/api/settings/scan', adminOnly, async (request) => {
    const body = (request.body ?? {}) as any;
    const full = body.full === true;
    void triggerScan('manual', full);
    return { started: true, full };
  });

  app.get('/api/settings/scan-status', adminOnly, async () => ({ scan: scanState }));

  app.get('/api/settings/validate-path', adminOnly, async (request) => {
    const q = (request.query ?? {}) as any;
    const target = typeof q.path === 'string' && q.path.trim() ? q.path.trim() : getSettings().library.mediaPath;

    try {
      const stat = await fsp.stat(target);
      if (!stat.isDirectory()) return { ok: false, error: 'That path is not a folder' };
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      return {
        ok: true,
        path: target,
        channelCount: folders.length,
        sample: folders.slice(0, 8).map((e) => e.name),
      };
    } catch (err: any) {
      return { ok: false, error: err?.code === 'ENOENT' ? 'That folder does not exist' : String(err?.message ?? err) };
    }
  });

  app.post('/api/settings/cache/clear', adminOnly, async (request) => {
    const body = (request.body ?? {}) as any;
    const which = body.which === 'images' || body.which === 'transcode' ? body.which : 'all';
    if (which === 'transcode' || which === 'all') await resetTranscodes();
    if (which === 'images' || which === 'all') await clearImageCache();
    return { ok: true, cleared: which };
  });

  app.get('/api/system', adminOnly, async (request) => {
    const caps = hardwareCapabilities();
    return {
      library: libraryStats(request.user!),
      scan: scanState,
      transcode: {
        status: hardwareStatus(),
        ffmpegVersion: caps.ffmpegVersion,
        vaapiDevice: caps.vaapiDevice,
        available: caps.available,
        tested: caps.tested,
        details: caps.details,
        error: caps.error,
        activeJobs: activeJobs(),
      },
      cache: {
        bytes: await cacheSizeBytes(),
        limitBytes: getSettings().transcode.cacheSizeGb * 1024 * 1024 * 1024,
      },
      paths: {
        media: getSettings().library.mediaPath,
        data: config.dataDir,
        cache: config.cacheDir,
      },
      version: APP_VERSION,
    };
  });
}
