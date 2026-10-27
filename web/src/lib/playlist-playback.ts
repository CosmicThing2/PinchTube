import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PlaylistDto, type VideoDto } from './api';

export interface PlaylistResponse {
  playlist: PlaylistDto;
  items: VideoDto[];
}

// Loop and shuffle are remembered per playlist, on this device only — the
// same as the queue's, and for the same reason: they describe how you happen
// to be listening here, not something about the list itself.
const key = (id: number, what: string) => `ytm-playlist-${id}-${what}`;

function readFlag(name: string): boolean {
  try {
    return localStorage.getItem(name) === '1';
  } catch {
    return false;
  }
}

function write(name: string, value: string): void {
  try {
    localStorage.setItem(name, value);
  } catch {
    /* private browsing */
  }
}

function readOrder(name: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(name) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Fisher–Yates over everything except `firstId`, which stays at the front. */
export function shuffledIds(items: VideoDto[], firstId?: string): string[] {
  const ids = items.map((video) => video.id).filter((id) => id !== firstId);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return firstId && items.some((video) => video.id === firstId) ? [firstId, ...ids] : ids;
}

/** Lays a saved shuffle over the real list: gone videos drop out, new ones go last. */
function applyOrder(items: VideoDto[], order: string[]): VideoDto[] {
  const byId = new Map(items.map((video) => [video.id, video]));
  const out: VideoDto[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const video = byId.get(id);
    if (video && !seen.has(id)) {
      out.push(video);
      seen.add(id);
    }
  }
  for (const video of items) if (!seen.has(video.id)) out.push(video);
  return out;
}

export function setPlaylistShuffle(id: number, items: VideoDto[], on: boolean, firstId?: string): void {
  write(key(id, 'shuffle'), on ? '1' : '0');
  if (on) write(key(id, 'order'), JSON.stringify(shuffledIds(items, firstId)));
}

/**
 * Everything the watch page needs to play through a playlist: the videos in
 * play order (shuffled or not) and the loop / shuffle switches. `listId` of
 * null means "not playing a playlist", and everything stays empty.
 */
export function usePlaylistPlayback(listId: number | null) {
  const [data, setData] = useState<PlaylistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [loop, setLoop] = useState(false);
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (listId === null) return;
    setShuffle(readFlag(key(listId, 'shuffle')));
    setLoop(readFlag(key(listId, 'loop')));
    setOrder(readOrder(key(listId, 'order')));

    let cancelled = false;
    api
      .get<PlaylistResponse>(`/api/playlists/${listId}`)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load the playlist');
      });
    return () => {
      cancelled = true;
    };
  }, [listId]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const playOrder = useMemo(() => (shuffle ? applyOrder(items, order) : items), [items, order, shuffle]);

  const toggleShuffle = useCallback(
    (currentId?: string) => {
      if (listId === null) return;
      const next = !shuffle;
      setShuffle(next);
      setPlaylistShuffle(listId, items, next, currentId);
      if (next) setOrder(readOrder(key(listId, 'order')));
    },
    [items, listId, shuffle],
  );

  const toggleLoop = useCallback(() => {
    if (listId === null) return;
    const next = !loop;
    setLoop(next);
    write(key(listId, 'loop'), next ? '1' : '0');
  }, [listId, loop]);

  return {
    playlist: data?.playlist ?? null,
    items,
    playOrder,
    shuffle,
    loop,
    toggleShuffle,
    toggleLoop,
    error,
  };
}

export type PlaylistPlayback = ReturnType<typeof usePlaylistPlayback>;
