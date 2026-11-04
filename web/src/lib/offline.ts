/*
 * offline.ts — videos saved to the browser cache, and the downloads in progress.
 *
 * A web page cannot save a file somewhere and read it back later, but it can
 * keep data in the browser's own storage for the site (IndexedDB). "Save to
 * browser cache" downloads a video into that storage in pieces of a few MB,
 * so a big video never has to sit in memory all at once, then joins the
 * pieces into one stored file; the watch page plays it from there instead of
 * streaming (see offlineSource()). The joining matters: Firefox cannot jump
 * around in a video made of several stored pieces, only within what it has
 * read so far. "Save to device" just hands the browser a normal download.
 *
 * For any quality other than Original, the server first converts the whole
 * video (server/src/routes/downloads.ts); the progress of that "preparing"
 * step is followed here too. Downloads carry on while moving around the app,
 * and anything can follow them with useDownloadTask() / useOfflineVersion().
 *
 * Each stored video is tagged with the account that saved it, and only that
 * account sees or plays it, so a shared device does not leak one person's
 * downloads to another. Its channel and publish date are kept too, for the
 * Downloads page's sorting and channel grid. Used by
 * components/DownloadDialog.tsx, pages/Downloads.tsx and pages/Watch.tsx.
 */

import { useEffect, useState } from 'react';
import { api, urls, type DownloadStatus } from './api';

// ---- what is stored ---------------------------------------------------------

/** One video in the browser cache. Its bytes are stored separately, in 'files'. */
export interface OfflineVideo {
  /** "<user id>:<video id>". */
  key: string;
  userId: number;
  videoId: string;
  title: string;
  channelTitle: string;
  /** Missing on copies saved before it was recorded, until completeDetails() fills it in. */
  channelId?: string;
  /** When the video was published (ms), for sorting by date. */
  aired?: number | null;
  /** 'original', '720p', 'audio'… and how to show it. */
  quality: string;
  qualityLabel: string;
  mime: string;
  size: number;
  /** How many pieces it was downloaded in. */
  pieces: number;
  /**
   * Joined into one file in 'files'. Copies saved before joining was added
   * are still pieces until they are first played (see offlineSource()).
   */
  whole?: boolean;
  savedAt: number;
}

/** A download being prepared on the server or fetched, or one that failed. */
export interface DownloadTask {
  videoId: string;
  title: string;
  mode: 'device' | 'file';
  /** 'saving' is joining the downloaded pieces into one stored file. */
  phase: 'preparing' | 'downloading' | 'saving' | 'failed';
  /** 0 to 1 within the current phase. */
  progress: number;
  error: string | null;
}

/** What a download needs to know about the video. */
export interface DownloadRequest {
  userId: number;
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  aired: number | null;
  quality: string;
  qualityLabel: string;
  mode: 'device' | 'file';
}

const DB_NAME = 'pinchtube-offline';
/** Bytes gathered before each piece is written to storage. */
const PIECE_BYTES = 8 * 1024 * 1024;
/** How often to ask the server how a conversion is going. */
const POLL_MS = 2000;

const keyOf = (userId: number, videoId: string) => `${userId}:${videoId}`;

// ---- the browser database -----------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Opens (and on first use creates) the database: video details, the pieces
 * a download arrives in, and the finished files. Version 2 added 'files'.
 */
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot store videos'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const has = (name: string) => db.objectStoreNames.contains(name);
      if (!has('videos')) db.createObjectStore('videos', { keyPath: 'key' });
      if (!has('pieces')) db.createObjectStore('pieces', { keyPath: ['key', 'index'] });
      if (!has('files')) db.createObjectStore('files', { keyPath: 'key' });
    };
    // Another tab still running an older version of the app holds the
    // database open, so the upgrade has to wait for it. Fail now rather than
    // leave pages waiting; it is retried on the next call.
    request.onblocked = () => reject(new Error('Close any other PinchTube tabs to use downloads'));
    request.onsuccess = () => {
      const db = request.result;
      // And the other way round: let a newer version in another tab upgrade.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open storage'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Runs one request in a transaction and resolves with its result once committed. */
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const request = work(tx);
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? new Error('Storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage failed'));
  });
}

/** Every piece key of one video. */
const piecesOf = (key: string) => IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);

/** The account's downloaded videos, newest first. */
export async function listOffline(userId: number): Promise<OfflineVideo[]> {
  const all = (await run<OfflineVideo[]>(['videos'], 'readonly', (tx) => tx.objectStore('videos').getAll())) ?? [];
  return all.filter((video) => video.userId === userId).sort((a, b) => b.savedAt - a.savedAt);
}

/** One downloaded video's details, or null. */
export async function getOffline(userId: number, videoId: string): Promise<OfflineVideo | null> {
  const found = await run<OfflineVideo>(['videos'], 'readonly', (tx) =>
    tx.objectStore('videos').get(keyOf(userId, videoId)),
  );
  return found ?? null;
}

/** Deletes a downloaded video, its file and any pieces. */
export async function removeOffline(userId: number, videoId: string): Promise<void> {
  const key = keyOf(userId, videoId);
  await run(['videos', 'pieces', 'files'], 'readwrite', (tx) => {
    tx.objectStore('videos').delete(key);
    tx.objectStore('pieces').delete(piecesOf(key));
    tx.objectStore('files').delete(key);
  });
  changed();
}

/** Deletes every video this account has downloaded; other accounts' are kept. */
export async function removeAllOffline(userId: number): Promise<void> {
  const keys = (await listOffline(userId)).map((video) => video.key);
  if (!keys.length) return;
  await run(['videos', 'pieces', 'files'], 'readwrite', (tx) => {
    for (const key of keys) {
      tx.objectStore('videos').delete(key);
      tx.objectStore('pieces').delete(piecesOf(key));
      tx.objectStore('files').delete(key);
    }
  });
  changed();
}

/** The ways the Downloads page can be sorted, in menu order. */
export const OFFLINE_SORTS = [
  { value: 'date_desc', label: 'Newest first' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'saved_desc', label: 'Recently downloaded' },
  { value: 'title_asc', label: 'Title A–Z' },
  { value: 'title_desc', label: 'Title Z–A' },
];

/** A sorted copy of a list; videos with no known date go last either way. */
export function sortOffline(videos: OfflineVideo[], sort: string): OfflineVideo[] {
  const byTitle = (a: OfflineVideo, b: OfflineVideo) =>
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  const byDate = (direction: 1 | -1) => (a: OfflineVideo, b: OfflineVideo) => {
    if (a.aired == null || b.aired == null) return (a.aired == null ? 1 : 0) - (b.aired == null ? 1 : 0);
    return (a.aired - b.aired) * direction;
  };
  const compare =
    sort === 'date_desc'
      ? byDate(-1)
      : sort === 'date_asc'
        ? byDate(1)
        : sort === 'title_asc'
          ? byTitle
          : sort === 'title_desc'
            ? (a: OfflineVideo, b: OfflineVideo) => byTitle(b, a)
            : (a: OfflineVideo, b: OfflineVideo) => b.savedAt - a.savedAt;
  return [...videos].sort(compare);
}

/**
 * Copies saved before the channel and publish date were recorded are missing
 * them; this asks the server for them and stores them, so grouping by channel
 * and sorting by date work for those too. Videos the server no longer has are
 * left as they are.
 */
export async function completeDetails(videos: OfflineVideo[]): Promise<OfflineVideo[]> {
  const missing = videos.filter((video) => !video.channelId);
  if (!missing.length) return videos;
  const filled = new Map<string, OfflineVideo>();
  await Promise.all(
    missing.map(async (video) => {
      try {
        const data = await api.get<{ video: { channelId: string; channelTitle: string; aired: number | null } }>(
          `/api/videos/${encodeURIComponent(video.videoId)}`,
        );
        filled.set(video.key, {
          ...video,
          channelId: data.video.channelId,
          channelTitle: data.video.channelTitle,
          aired: data.video.aired,
        });
      } catch {
        // Gone from the library, or the server is unreachable: try again next time.
      }
    }),
  );
  if (!filled.size) return videos;
  await run(['videos'], 'readwrite', (tx) => {
    for (const video of filled.values()) tx.objectStore('videos').put(video);
  }).catch(() => {});
  return videos.map((video) => filled.get(video.key) ?? video);
}

/** A video's downloaded pieces joined back together in order, or null if any are missing. */
async function joinPieces(key: string, count: number, mime: string): Promise<Blob | null> {
  const pieces =
    (await run<{ index: number; blob: Blob }[]>(['pieces'], 'readonly', (tx) =>
      tx.objectStore('pieces').getAll(piecesOf(key)),
    )) ?? [];
  if (pieces.length !== count) return null;
  pieces.sort((a, b) => a.index - b.index);
  return new Blob(
    pieces.map((piece) => piece.blob),
    { type: mime },
  );
}

/**
 * Stores a video as one file and records it, then drops its pieces. The
 * browser copies the joined pieces into a single file on disk, which it can
 * then read from any point.
 */
async function storeWhole(video: OfflineVideo, blob: Blob): Promise<void> {
  await run(['files', 'videos'], 'readwrite', (tx) => {
    tx.objectStore('files').put({ key: video.key, blob });
    tx.objectStore('videos').put({ ...video, whole: true });
  });
  await run(['pieces'], 'readwrite', (tx) => {
    tx.objectStore('pieces').delete(piecesOf(video.key));
  });
}

/** A video's stored file. */
async function wholeFile(key: string): Promise<Blob | null> {
  const found = await run<{ key: string; blob: Blob }>(['files'], 'readonly', (tx) => tx.objectStore('files').get(key));
  return found?.blob ?? null;
}

/** Copies being joined into one file right now, so two callers share the work. */
const joining = new Map<string, Promise<Blob | null>>();

/**
 * Joins a copy saved before pieces were joined at download time into one
 * file, once. If there is no room to store it joined, the pieces are played
 * as they are, which works everywhere except for jumping ahead in Firefox.
 */
function joinOldCopy(video: OfflineVideo): Promise<Blob | null> {
  let work = joining.get(video.key);
  if (!work) {
    work = (async () => {
      const joined = await joinPieces(video.key, video.pieces, video.mime);
      if (!joined) return null;
      try {
        await storeWhole(video, joined);
        return await wholeFile(video.key);
      } catch {
        return joined;
      }
    })().finally(() => joining.delete(video.key));
    joining.set(video.key, work);
  }
  return work;
}

/**
 * A playable address for a downloaded video, from its stored file. The
 * caller must URL.revokeObjectURL() it when done.
 */
export async function offlineSource(
  userId: number,
  videoId: string,
): Promise<{ url: string; label: string } | null> {
  const video = await getOffline(userId, videoId).catch(() => null);
  if (!video) return null;
  const file = video.whole ? await wholeFile(video.key) : await joinOldCopy(video);
  if (!file) return null;
  return { url: URL.createObjectURL(file), label: video.qualityLabel };
}

// ---- telling the page about changes -------------------------------------------

// Two events: one when the stored videos change, one as downloads progress
// (which fires often, so it is kept apart from the first).
const STORED_EVENT = 'ytm-offline-stored';
const PROGRESS_EVENT = 'ytm-offline-progress';
const tasks = new Map<string, DownloadTask>();
const controllers = new Map<string, AbortController>();

function changed(): void {
  window.dispatchEvent(new CustomEvent(STORED_EVENT));
}

function setTask(videoId: string, task: DownloadTask | null): void {
  if (task) tasks.set(videoId, task);
  else tasks.delete(videoId);
  window.dispatchEvent(new CustomEvent(PROGRESS_EVENT));
}

/** A number that goes up each time the event fires. */
function useEventCount(event: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const bump = () => setCount((n) => n + 1);
    window.addEventListener(event, bump);
    return () => window.removeEventListener(event, bump);
  }, [event]);
  return count;
}

/** A number that goes up whenever a video is stored or removed; use it to reload lists. */
export function useOfflineVersion(): number {
  return useEventCount(STORED_EVENT);
}

/** The download in progress (or failed) for a video, if any. */
export function useDownloadTask(videoId: string): DownloadTask | null {
  useEventCount(PROGRESS_EVENT);
  return tasks.get(videoId) ?? null;
}

/** Every download in progress, for the Downloads page. */
export function useDownloadTasks(): DownloadTask[] {
  useEventCount(PROGRESS_EVENT);
  return Array.from(tasks.values());
}

// ---- downloading ------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Waits for the server to finish converting, reporting its progress. */
async function prepare(request: DownloadRequest, signal: AbortSignal): Promise<void> {
  const path = `/api/videos/${request.videoId}/downloads/${request.quality}`;
  let status = await api.post<DownloadStatus>(path);
  while (status.state !== 'ready') {
    if (status.state === 'failed') throw new Error(status.error ?? 'The server could not convert this video');
    setTask(request.videoId, {
      videoId: request.videoId,
      title: request.title,
      mode: request.mode,
      phase: 'preparing',
      progress: status.progress,
      error: null,
    });
    await sleep(POLL_MS);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    status = await api.get<DownloadStatus>(path);
  }
}

/** Fetches the file into storage piece by piece, then records it. */
async function store(request: DownloadRequest, url: string, signal: AbortSignal): Promise<void> {
  const key = keyOf(request.userId, request.videoId);
  // Ask the browser not to clear this site's storage when space runs low
  // (only possible over HTTPS; elsewhere it quietly does nothing).
  void (navigator as any).storage?.persist?.().catch?.(() => {});

  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok || !response.body) throw new Error(`The server refused the download (${response.status})`);
  const total = Number(response.headers.get('Content-Length')) || 0;
  const mime = response.headers.get('Content-Type') || 'video/mp4';

  // Clear out any half-saved earlier attempt first.
  await run(['pieces'], 'readwrite', (tx) => {
    tx.objectStore('pieces').delete(piecesOf(key));
  });

  const reader = response.body.getReader();
  let gathered: Uint8Array[] = [];
  let gatheredBytes = 0;
  let received = 0;
  let index = 0;

  const flush = async () => {
    if (!gatheredBytes) return;
    const blob = new Blob(gathered as BlobPart[]);
    const piece = { key, index, blob };
    index += 1;
    gathered = [];
    gatheredBytes = 0;
    await run(['pieces'], 'readwrite', (tx) => {
      tx.objectStore('pieces').put(piece);
    });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gathered.push(value);
      gatheredBytes += value.byteLength;
      received += value.byteLength;
      if (gatheredBytes >= PIECE_BYTES) await flush();
      setTask(request.videoId, {
        videoId: request.videoId,
        title: request.title,
        mode: 'device',
        phase: 'downloading',
        progress: total ? received / total : 0,
        error: null,
      });
    }
    await flush();

    // Join the pieces into one stored file (this copies the whole video, so
    // a big one takes a little while).
    setTask(request.videoId, {
      videoId: request.videoId,
      title: request.title,
      mode: 'device',
      phase: 'saving',
      progress: 1,
      error: null,
    });
    const joined = await joinPieces(key, index, mime);
    if (!joined) throw new Error('The download could not be saved');

    const video: OfflineVideo = {
      key,
      userId: request.userId,
      videoId: request.videoId,
      title: request.title,
      channelTitle: request.channelTitle,
      channelId: request.channelId,
      aired: request.aired,
      quality: request.quality,
      qualityLabel: request.qualityLabel,
      mime,
      size: received,
      pieces: index,
      savedAt: Date.now(),
    };
    await storeWhole(video, joined);
    changed();
  } catch (err) {
    // Leave nothing half-saved behind.
    await run(['pieces'], 'readwrite', (tx) => {
      tx.objectStore('pieces').delete(piecesOf(key));
    }).catch(() => {});
    throw err;
  }
}

/** Where the finished file is fetched from. */
function fileUrl(request: DownloadRequest, saveAs: boolean): string {
  if (request.quality === 'original') return urls.original(request.videoId) + (saveAs ? '?download=1' : '');
  return `/api/videos/${request.videoId}/downloads/${request.quality}/file${saveAs ? '?attachment=1' : ''}`;
}

/** Hands a file to the browser's own download manager. */
function saveAsFile(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Starts a download. Keeps running while moving around the app; follow it
 * with useDownloadTask(). Only one per video at a time.
 */
export function startDownload(request: DownloadRequest): void {
  if (controllers.has(request.videoId)) return;
  const controller = new AbortController();
  controllers.set(request.videoId, controller);
  setTask(request.videoId, {
    videoId: request.videoId,
    title: request.title,
    mode: request.mode,
    phase: request.quality === 'original' ? 'downloading' : 'preparing',
    progress: 0,
    error: null,
  });

  void (async () => {
    try {
      if (request.quality !== 'original') await prepare(request, controller.signal);
      if (request.mode === 'file') {
        saveAsFile(fileUrl(request, true));
      } else {
        await store(request, fileUrl(request, false), controller.signal);
      }
      setTask(request.videoId, null);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setTask(request.videoId, null);
      } else {
        const full = err?.name === 'QuotaExceededError';
        setTask(request.videoId, {
          videoId: request.videoId,
          title: request.title,
          mode: request.mode,
          phase: 'failed',
          progress: 0,
          error: full ? 'There is not enough space on this device.' : (err?.message ?? 'The download failed'),
        });
      }
    } finally {
      controllers.delete(request.videoId);
    }
  })();
}

/** Stops a download, or clears a failed one from view. */
export function cancelDownload(videoId: string): void {
  const controller = controllers.get(videoId);
  if (controller) controller.abort();
  else setTask(videoId, null);
}
