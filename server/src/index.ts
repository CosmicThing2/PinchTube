/*
 * index.ts — the server's entry point: starts PinchTube.
 *
 * Builds the Fastify web server and wires everything together:
 *   - a request hook that works out who is signed in (auth.ts) and blocks
 *     API calls from people who are not allowed to make them
 *   - security headers on every response
 *   - every group of API routes, one file each under routes/
 *   - the built web app (the React front end) served as static files, with
 *     any unknown non-API address handed to it so its own router can take over
 * Then it detects graphics-card encoding (media/hwaccel.ts), starts the
 * transcoder's clean-up timer (media/transcoder.ts), starts scanning the
 * media library (library/manager.ts), prints the first-run setup code if no
 * accounts exist yet, and shuts everything down cleanly when Docker stops it.
 */

import path from 'node:path';
import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

import { config, loadSessionSecret } from './config.js';
import { db } from './db.js';
import { currentSetupCode, pruneSessions, readSessionToken, sessionUser, setupRequired } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerPlaylistRoutes } from './routes/playlists.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerImageRoutes } from './routes/images.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerDownloadRoutes } from './routes/downloads.js';
import { applyLibrarySettings, setLibraryLogger, shutdownLibrary, triggerScan } from './library/manager.js';
import { needsFullRescan } from './library/scanner.js';
import { detectHardware, hardwareStatus } from './media/hwaccel.js';
import { setTranscodeLogger, shutdownTranscoder, startReaper } from './media/transcoder.js';
import { checkCacheFormat } from './media/cache.js';
import { setDownloadLogger, shutdownDownloads } from './media/downloads.js';

/**
 * Applied to every response. The content security policy only lets the page
 * load scripts, styles, media and connections from this server — so even if
 * some text from a video description slipped through as markup, it could not
 * pull in or run anything from elsewhere.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** Methods that only read; anything else counts as a change and needs the CSRF header. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function main(): Promise<void> {
  // Directories and schema are prepared when ./db.js is imported.
  pruneSessions();

  // ---- the web server itself ----------------------------------------------
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // No line per request: the player fetches a segment every few seconds.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // The library scanner and transcoder log through Fastify's logger.
  setLibraryLogger({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });
  setTranscodeLogger({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
    debug: (msg) => app.log.debug(msg),
  });
  setDownloadLogger({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });

  // Signed cookies carry the login session (see auth.ts).
  await app.register(cookie, { secret: loadSessionSecret() });

  app.decorateRequest('user', null);

  // Resolve the signed-in user once per request, then gate the API on it. The
  // decision uses the route Fastify actually matched rather than the raw URL,
  // so an oddly encoded path cannot be read one way here and another way by
  // the router. Every /api/ route is private unless marked public.
  app.addHook('onRequest', async (request, reply) => {
    request.user = sessionUser(readSessionToken(request));

    const route = request.routeOptions.url;
    const isApi = request.url.startsWith('/api/') || Boolean(route?.startsWith('/api/'));
    if (!isApi) return;

    // Requests that change anything must carry a header a plain HTML form or
    // a cross-site <img> cannot add, which shuts out cross-site request forgery
    // even from a sibling subdomain that SameSite cookies would let through.
    if (!SAFE_METHODS.has(request.method) && !request.headers['x-requested-with']) {
      return reply.code(403).send({ error: 'Missing X-Requested-With header' });
    }

    // Unmatched /api/ paths fall to the not-found handler, which only ever 404s.
    if (!route) return;
    const routeConfig = request.routeOptions.config ?? {};
    if (routeConfig.public) return;
    if (!request.user) {
      return reply.code(401).send({
        error: 'Authentication required',
        setupRequired: setupRequired(),
      });
    }
    if (routeConfig.admin && !request.user.isAdmin) {
      return reply.code(403).send({ error: 'Only an administrator can do that' });
    }
  });

  // Security headers on every response, and no caching of private API data.
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    // Personal API data must never sit in a shared or on-disk cache.
    if (request.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // ---- API routes ----------------------------------------------------------
  // A health check for Docker or monitoring tools, then each group of routes.
  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }));

  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerPlaylistRoutes(app);
  registerLibraryRoutes(app);
  registerImageRoutes(app);
  registerStreamRoutes(app);
  registerSettingsRoutes(app);
  registerQueueRoutes(app);
  registerDownloadRoutes(app);

  // ---- the web app ---------------------------------------------------------
  // The built React app (web/dist, copied to ./public in the image).
  await app.register(fastifyStatic, {
    root: path.resolve(config.publicDir),
    prefix: '/',
    index: ['index.html'],
    // Hashed asset filenames may be cached hard; index.html must not be.
    // @fastify/static 10 hands over the Fastify reply (`.header`); older
    // versions passed the raw Node response (`.setHeader`).
    setHeaders(res: any, filePath: string) {
      const set = (value: string) =>
        typeof res.header === 'function' ? res.header('Cache-Control', value) : res.setHeader('Cache-Control', value);
      if (filePath.endsWith('index.html')) {
        set('no-cache');
      } else if (/[.-][0-9a-f]{8,}\.(js|css|woff2?)$/i.test(filePath)) {
        set('public, max-age=31536000, immutable');
      }
    },
  });

  // Anything that is not an API call falls through to the single-page app.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  // ---- background services -------------------------------------------------
  // Find out which graphics-card encoders work in this container.
  const caps = await detectHardware();
  if (caps.error) app.log.warn(caps.error);
  app.log.info(`Transcoding: ${hardwareStatus()}`);

  // Transcode cache housekeeping, then start watching the media folder.
  if (await checkCacheFormat()) app.log.info('Cleared transcodes made by an older version');
  startReaper();
  applyLibrarySettings();

  // Scan the library at startup; a full rescan when the scanner's rules changed.
  const forceFull = needsFullRescan();
  if (forceFull) {
    app.log.info('Scanner rules changed since the last run — doing one full rescan');
  }
  void triggerScan('startup', forceFull);

  // Expired login sessions are deleted once a day.
  const dailyPrune = setInterval(() => pruneSessions(), 24 * 60 * 60 * 1000);
  dailyPrune.unref?.();

  // Start accepting connections. config.host is the address inside the
  // container; which machines can reach it is decided by the compose ports.
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`PinchTube listening on http://${config.host}:${config.port}`);

  // First run: print the one-time code needed to create the admin account.
  const setupCode = currentSetupCode();
  if (setupCode) {
    app.log.warn(`No accounts exist yet. Setup code: ${setupCode}`);
    // Also as plain text: the structured log line above is easy to miss.
    console.log(
      [
        '',
        '============================================================',
        ' No accounts exist yet. Open PinchTube in a browser and enter',
        ` this setup code to create the administrator:   ${setupCode}`,
        ' (A new code is printed each time the server starts.)',
        '============================================================',
      ].join('\n'),
    );
  }

  // ---- shutdown --------------------------------------------------------------
  // Docker sends SIGTERM on stop: finish requests, stop ffmpeg and close the database.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`Received ${signal}, shutting down`);
    clearInterval(dailyPrune);
    try {
      await app.close();
      await shutdownLibrary();
      await shutdownTranscoder();
      shutdownDownloads();
      db.close();
    } catch (err) {
      app.log.warn(`Error during shutdown: ${String(err)}`);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// A startup failure (e.g. the port is taken) ends the process so Docker shows it.
main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
