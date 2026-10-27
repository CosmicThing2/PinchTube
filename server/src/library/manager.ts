import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { getSettings } from '../settings.js';
import { runScan, scanState } from './scanner.js';

const WATCH_DEBOUNCE_MS = 20_000;
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

  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  intervalTimer = setInterval(
    () => void triggerScan('scheduled'),
    Math.max(1, s.scanIntervalMinutes) * 60_000,
  );

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

export async function shutdownLibrary(): Promise<void> {
  if (intervalTimer) clearInterval(intervalTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  intervalTimer = null;
  debounceTimer = null;
  currentKey = '';
  await stopWatcher();
}
