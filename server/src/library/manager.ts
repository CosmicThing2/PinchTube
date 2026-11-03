/*
 * manager.ts — decides when the library gets scanned.
 *
 * scanner.ts does the actual scanning; this file decides when to run it:
 *   - at startup (called from index.ts)
 *   - on a timer, every "scan interval" minutes from the library settings
 *   - when the media folder changes: a filesystem watcher (chokidar) spots
 *     new or deleted videos and metadata, and after things have been quiet
 *     for 20 seconds a scan runs, so a burst of downloads becomes one scan
 *   - when someone presses "Scan now" (routes/settings.ts)
 * It also makes sure two scans never run at the same time, and restarts the
 * timer and watcher whenever the library settings change.
 */

import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { getSettings } from '../settings.js';
import { runScan, scanState } from './scanner.js';

/** How long the folder must be quiet before a scan starts. */
const WATCH_DEBOUNCE_MS = 20_000;
/** File types whose arrival or removal is worth a scan. */
const RELEVANT_EXT = new Set([
  '.mp4', '.mkv', '.webm', '.m4v', '.mov', '.avi', '.ts', '.flv',
  '.nfo', '.jpg', '.jpeg', '.png', '.webp', '.srt', '.vtt',
]);

let watcher: FSWatcher | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let currentKey = '';
/** A full scan asked for while another scan was running, still owed. */
let fullOwed = false;
let log: { info: (msg: string) => void; warn: (msg: string) => void } = {
  info: () => {},
  warn: () => {},
};

/** index.ts hands over the server's logger. */
export function setLibraryLogger(logger: typeof log): void {
  log = logger;
}

/** Queue an incremental scan, coalescing bursts of file events from the downloader. */
function queueScan(reason: string, full = false): void {
  if (full) fullOwed = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const owed = fullOwed;
    fullOwed = false;
    void triggerScan(reason, owed);
  }, WATCH_DEBOUNCE_MS);
}

/**
 * Runs a scan now, or once the current one finishes. `full` re-reads every
 * file rather than only folders that changed.
 */
export async function triggerScan(reason: string, full = false): Promise<void> {
  if (scanState.running) {
    // A scan is already in flight; make sure we run once more afterwards.
    queueScan(reason, full);
    return;
  }
  log.info(`Library scan started (${reason}${full ? ', full' : ''})`);
  const state = await runScan({ full });
  if (state.error) {
    log.warn(`Library scan failed: ${state.error}`);
  } else {
    log.info(
      `Library scan finished: ${state.channelsSeen} channels, ` +
        `+${state.videosAdded} new, ~${state.videosUpdated} updated, -${state.videosRemoved} removed`,
    );
  }
}

/** (Re)configures the periodic timer and the filesystem watcher from settings. */
export function applyLibrarySettings(): void {
  const s = getSettings().library;
  const key = JSON.stringify([s.mediaPath, s.scanIntervalMinutes, s.watcherEnabled, s.watcherUsePolling]);
  if (key === currentKey) return;
  currentKey = key;

  // The regular scan timer.
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  intervalTimer = setInterval(
    () => void triggerScan('scheduled'),
    Math.max(1, s.scanIntervalMinutes) * 60_000,
  );

  // The filesystem watcher, replaced with one for the current settings.
  void stopWatcher().then(() => {
    if (!s.watcherEnabled) return;
    try {
      watcher = watch(s.mediaPath, {
        ignoreInitial: true,
        depth: 5,
        followSymlinks: false,
        usePolling: s.watcherUsePolling === true,
        interval: 30_000,
        binaryInterval: 60_000,
        // Downloaders write large files; wait until they stop growing.
        awaitWriteFinish: { stabilityThreshold: 8_000, pollInterval: 1_000 },
        ignored: (target: string) => path.basename(target).startsWith('.'),
      });

      const onChange = (target: string) => {
        if (!RELEVANT_EXT.has(path.extname(target).toLowerCase())) return;
        queueScan('watcher');
      };

      watcher.on('add', onChange);
      watcher.on('unlink', onChange);
      watcher.on('addDir', () => queueScan('watcher'));
      watcher.on('unlinkDir', () => queueScan('watcher'));
      watcher.on('error', (err: unknown) => log.warn(`Watcher error: ${String(err)}`));

      log.info(`Watching ${s.mediaPath} for new downloads`);
    } catch (err) {
      log.warn(`Could not start filesystem watcher: ${String(err)}`);
    }
  });
}

/** Stops watching the media folder. */
export async function stopWatcher(): Promise<void> {
  if (!watcher) return;
  const w = watcher;
  watcher = null;
  try {
    await w.close();
  } catch {
    /* already gone */
  }
}

/** Stops the timer and watcher when the server shuts down. */
export async function shutdownLibrary(): Promise<void> {
  if (intervalTimer) clearInterval(intervalTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  intervalTimer = null;
  debounceTimer = null;
  currentKey = '';
  await stopWatcher();
}
