import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type VideoDto } from './api';
import { useApp } from './app-context';

interface QueueValue {
  /** Server order — what the queue page shows and reorders. */
  items: VideoDto[];
  /** The order videos actually play in: `items`, or a shuffle of them. */
  playOrder: VideoDto[];
  shuffle: boolean;
  loop: boolean;
  /** Shuffling keeps the video being watched first, as YouTube does. */
  toggleShuffle: (currentId?: string) => void;
  toggleLoop: () => void;
  count: number;
  /** While on, tapping a video card adds it to the queue instead of playing it. */
  queueMode: boolean;
  setQueueMode: (value: boolean) => void;
  toggleQueueMode: () => void;
  contains: (videoId: string) => boolean;
  add: (videoId: string) => Promise<void>;
  remove: (videoId: string) => Promise<void>;
  clear: () => Promise<void>;
  move: (videoId: string, direction: -1 | 1) => Promise<void>;
  /** Shows a new order straight away, then saves it. */
  reorder: (ids: string[]) => Promise<void>;
  refresh: () => Promise<void>;
}

const QueueContext = createContext<QueueValue | null>(null);

const SHUFFLE_KEY = 'ytm-queue-shuffle';
const ORDER_KEY = 'ytm-queue-order';
const LOOP_KEY = 'ytm-queue-loop';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing */
  }
}

function readOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function useQueue(): QueueValue {
  const value = useContext(QueueContext);
  if (!value) throw new Error('useQueue must be used inside <QueueProvider>');
  return value;
}

interface QueueResponse {
  items: VideoDto[];
  count: number;
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const { user } = useApp();
  const [items, setItems] = useState<VideoDto[]>([]);
  const [queueMode, setQueueMode] = useState(false);
  const [shuffle, setShuffle] = useState(() => readFlag(SHUFFLE_KEY));
  const [loop, setLoop] = useState(() => readFlag(LOOP_KEY));
  const [shuffleOrder, setShuffleOrder] = useState<string[]>(() => readOrder());

  // The shuffled order is a list of ids layered over the real queue: removed
  // videos drop out, and anything queued since shuffling goes on the end.
  const playOrder = useMemo(() => {
    if (!shuffle) return items;
    const byId = new Map(items.map((video) => [video.id, video]));
    const out: VideoDto[] = [];
    const seen = new Set<string>();
    for (const id of shuffleOrder) {
      const video = byId.get(id);
      if (video && !seen.has(id)) {
        out.push(video);
        seen.add(id);
      }
    }
    for (const video of items) if (!seen.has(video.id)) out.push(video);
    return out;
  }, [items, shuffle, shuffleOrder]);

  const toggleShuffle = useCallback(
    (currentId?: string) => {
      const next = !shuffle;
      setShuffle(next);
      writeValue(SHUFFLE_KEY, next ? '1' : '0');
      if (!next) return;

      // Fisher–Yates over everything except the video playing now.
      const ids = items.map((video) => video.id).filter((id) => id !== currentId);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      const order = currentId && items.some((video) => video.id === currentId) ? [currentId, ...ids] : ids;
      setShuffleOrder(order);
      writeValue(ORDER_KEY, JSON.stringify(order));
    },
    [items, shuffle],
  );

  const toggleLoop = useCallback(() => {
    const next = !loop;
    setLoop(next);
    writeValue(LOOP_KEY, next ? '1' : '0');
  }, [loop]);

  const apply = useCallback((data: QueueResponse) => {
    setItems(data.items ?? []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api.get<QueueResponse>('/api/queue'));
    } catch {
      /* not signed in yet, or the server is still starting */
    }
  }, [apply]);

  // Each account has its own queue, so it is fetched afresh whenever someone
  // different signs in — and emptied the moment they sign out.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (userId === null) setItems([]);
    else void refresh();
  }, [refresh, userId]);

  const add = useCallback(
    async (videoId: string) => {
      apply(await api.post<QueueResponse>('/api/queue', { videoId }));
    },
    [apply],
  );

  const remove = useCallback(
    async (videoId: string) => {
      apply(await api.del<QueueResponse>(`/api/queue/${encodeURIComponent(videoId)}`));
    },
    [apply],
  );

  const clear = useCallback(async () => {
    apply(await api.post<QueueResponse>('/api/queue/clear'));
  }, [apply]);

  const move = useCallback(
    async (videoId: string, direction: -1 | 1) => {
      apply(await api.post<QueueResponse>('/api/queue/move', { videoId, direction }));
    },
    [apply],
  );

  const reorder = useCallback(
    async (ids: string[]) => {
      setItems((current) => {
        const byId = new Map(current.map((video) => [video.id, video]));
        const ordered = ids.map((id) => byId.get(id)).filter((video): video is VideoDto => Boolean(video));
        return ordered.length === current.length ? ordered : current;
      });
      apply(await api.post<QueueResponse>('/api/queue/order', { ids }));
    },
    [apply],
  );

  const contains = useCallback((videoId: string) => items.some((v) => v.id === videoId), [items]);

  const value = useMemo<QueueValue>(
    () => ({
      items,
      playOrder,
      shuffle,
      loop,
      toggleShuffle,
      toggleLoop,
      count: items.length,
      queueMode,
      setQueueMode,
      toggleQueueMode: () => setQueueMode((on) => !on),
      contains,
      add,
      remove,
      clear,
      move,
      reorder,
      refresh,
    }),
    [
      items,
      playOrder,
      shuffle,
      loop,
      toggleShuffle,
      toggleLoop,
      queueMode,
      contains,
      add,
      remove,
      clear,
      move,
      reorder,
      refresh,
    ],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
