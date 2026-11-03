/*
 * routes/settings.ts — the API behind the Settings page.
 *
 *   GET  /api/settings                  the user's settings, and the allowed choices
 *   PUT  /api/settings                  save changes (library/transcode: admins only)
 *   POST /api/settings/scan             start a library scan            (admin)
 *   GET  /api/settings/scan-status      how the scan is going           (admin)
 *   GET  /api/settings/validate-path    check a media folder path       (admin)
 *   POST /api/settings/cache/clear      empty the transcode/image cache (admin)
 *   GET  /api/system                    status for the System section   (admin)
 * Saving reacts to a few changes straight away: the library watcher and
 * timer are reset, a new media folder triggers a full rescan, and a new
 * segment length empties the transcode cache. The settings themselves are
 * defined and checked in settings.ts.
 */

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

  // The user's settings, plus the lists the page's drop-downs offer.
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

  // Save settings, then apply anything that needs acting on now.
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

  // "Scan now" / "Full rescan"; runs in the background.
  app.post('/api/settings/scan', adminOnly, async (request) => {
    const body = (request.body ?? {}) as any;
    const full = body.full === true;
    void triggerScan('manual', full);
    return { started: true, full };
  });

  app.get('/api/settings/scan-status', adminOnly, async () => ({ scan: scanState }));

  // Checks a media folder path before it is saved, listing a few channel folders found there.
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

  // Empty the transcode cache, the image cache, or both.
  app.post('/api/settings/cache/clear', adminOnly, async (request) => {
    const body = (request.body ?? {}) as any;
    const which = body.which === 'images' || body.which === 'transcode' ? body.which : 'all';
    if (which === 'transcode' || which === 'all') await resetTranscodes();
    if (which === 'images' || which === 'all') await clearImageCache();
    return { ok: true, cleared: which };
  });

  // Library numbers, scan state, encoder status, cache use, folders and version.
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
