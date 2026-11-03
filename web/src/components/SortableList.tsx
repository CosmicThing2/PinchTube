/*
 * SortableList.tsx — a list whose rows can be dragged into a new order.
 *
 * A general-purpose component: the caller supplies the items and how to draw
 * each row, and is told as rows move and when the drag ends (to save the new
 * order). Works with mouse and touch, scrolls the page when dragging near
 * the top or bottom, and only starts a drag from each row's handle. Used for
 * reordering playlists (pages/Playlist.tsx) and the home page rows and
 * channels in Settings (pages/Settings.tsx).
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { IconMenu } from './Icons';

/** What the caller passes in. */
interface SortableListProps<T> {
  items: T[];
  keyOf: (item: T) => string;
  /** Whether an item can be picked up at all. Items that cannot get no handle. */
  canDrag?: (item: T, index: number) => boolean;
  /** Whether the item at `from` may land at `to`; lets a caller fence off a block. */
  canMove?: (from: number, to: number) => boolean;
  /** Called as the placeholder moves, so the list re-sorts under the ghost. */
  onMove: (from: number, to: number) => void;
  /** Called once when a drag ends, so the caller can save the final order. */
  onDrop?: () => void;
  renderItem: (item: T, index: number, state: { handle: ReactNode; dragging: boolean }) => ReactNode;
  className?: string;
}

/** The row being dragged: its size, and where on it the pointer took hold. */
interface DragState {
  key: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

/** How close to the window's edge auto-scrolling starts. */
const EDGE_PX = 72;
/** How long the dropped row takes to slide into place. */
const SETTLE_MS = 170;

/**
 * Pick-up-and-drag reordering. The row you grab lifts out of the list into a
 * ghost that follows the pointer anywhere on screen; a grey placeholder keeps
 * its slot and slides through the list to show where it will land; releasing
 * snaps the ghost into that slot. Pointer events rather than HTML drag-and-drop,
 * which has patchy touch support, and dragging is from a handle so the inputs
 * inside a row cannot hijack the gesture.
 */
export function SortableList<T>({
  items,
  keyOf,
  canDrag,
  canMove,
  onMove,
  onDrop,
  renderItem,
  className,
}: SortableListProps<T>) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const ghostRef = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const settlingRef = useRef(false);

  const [drag, setDrag] = useState<DragState | null>(null);

  // Latest props/state for the window listeners, which live across renders.
  const latest = useRef({ items, keyOf, canMove, onMove, onDrop, drag });
  latest.current = { items, keyOf, canMove, onMove, onDrop, drag };

  /** Moves the floating copy of the row to follow the pointer. */
  const positionGhost = () => {
    const d = latest.current.drag;
    const ghost = ghostRef.current;
    if (!d || !ghost || settlingRef.current) return;
    ghost.style.transform = `translate(${pointer.current.x - d.offsetX}px, ${pointer.current.y - d.offsetY}px)`;
  };

  // Re-applied after every render, since a re-render would otherwise reset the
  // inline transform to whatever it was when the ghost mounted.
  useLayoutEffect(() => {
    positionGhost();
  });

  /** Works out which slot the pointer is over and moves the row there. */
  const retarget = () => {
    const { items: list, keyOf: key, canMove: allowed, onMove: move, drag: d } = latest.current;
    if (!d || settlingRef.current) return;

    const from = list.findIndex((item) => key(item) === d.key);
    if (from < 0) return;

    // The slot the pointer is over: how many *other* rows have their midpoint
    // above it. That is exactly the index to splice back in at.
    let target = 0;
    list.forEach((item, index) => {
      if (index === from) return;
      const element = rowRefs.current.get(key(item));
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (pointer.current.y > rect.top + rect.height / 2) target += 1;
    });

    if (target === from) return;
    if (allowed && !allowed(from, target)) return;
    move(from, target);
  };

  // While dragging: follow the pointer, auto-scroll, and finish on release.
  useEffect(() => {
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      positionGhost();
      retarget();
    };

    const finish = () => {
      if (settlingRef.current) return;
      const d = latest.current.drag;
      const ghost = ghostRef.current;
      const slot = d ? rowRefs.current.get(d.key) : null;
      if (d) latest.current.onDrop?.();

      // Snap into the placeholder rather than vanishing from under the pointer.
      if (d && ghost && slot) {
        settlingRef.current = true;
        const rect = slot.getBoundingClientRect();
        ghost.style.transition = `transform ${SETTLE_MS}ms ease`;
        ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        window.setTimeout(() => {
          settlingRef.current = false;
          setDrag(null);
        }, SETTLE_MS);
      } else {
        setDrag(null);
      }
    };

    // Dragging near the top or bottom of the window scrolls the page, so a long
    // list can be reordered end to end without dropping the row first.
    const autoScroll = window.setInterval(() => {
      if (settlingRef.current) return;
      const y = pointer.current.y;
      const height = window.innerHeight;
      let delta = 0;
      if (y < EDGE_PX) delta = -Math.ceil((EDGE_PX - y) / 4);
      else if (y > height - EDGE_PX) delta = Math.ceil((y - (height - EDGE_PX)) / 4);
      if (delta !== 0) {
        window.scrollBy(0, delta);
        retarget();
      }
    }, 16);

    document.body.classList.add('is-dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);

    return () => {
      document.body.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.clearInterval(autoScroll);
    };
    // Listeners read everything through `latest`, so only the drag's start/end matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  /** Starts dragging a row when its handle is pressed. */
  const begin = (key: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = rowRefs.current.get(key);
    if (!row) return;
    event.preventDefault();

    const rect = row.getBoundingClientRect();
    pointer.current = { x: event.clientX, y: event.clientY };
    setDrag({
      key,
      width: rect.width,
      height: rect.height,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    });
  };

  const draggedItem = drag ? items.find((item) => keyOf(item) === drag.key) : undefined;
  const draggedIndex = drag ? items.findIndex((item) => keyOf(item) === drag.key) : -1;

  // The rows (the dragged one shown as an empty placeholder), plus the floating copy.
  return (
    <>
      <div className={className}>
        {items.map((item, index) => {
          const key = keyOf(item);
          const draggable = canDrag ? canDrag(item, index) : true;
          const isPlaceholder = drag?.key === key;

          const handle = draggable ? (
            <button
              type="button"
              className="drag-handle"
              aria-label="Drag to reorder"
              title="Drag to reorder"
              onPointerDown={begin(key)}
            >
              <IconMenu />
            </button>
          ) : null;

          return (
            <div
              key={key}
              ref={(element) => {
                if (element) rowRefs.current.set(key, element);
                else rowRefs.current.delete(key);
              }}
              className={isPlaceholder ? 'sortable-row placeholder' : 'sortable-row'}
              style={isPlaceholder ? { height: drag.height } : undefined}
              aria-hidden={isPlaceholder || undefined}
            >
              {isPlaceholder ? null : renderItem(item, index, { handle, dragging: false })}
            </div>
          );
        })}
      </div>

      {drag && draggedItem !== undefined
        ? createPortal(
            <div ref={ghostRef} className="sortable-ghost" style={{ width: drag.width }}>
              {renderItem(draggedItem, draggedIndex, {
                handle: (
                  <span className="drag-handle is-held" aria-hidden="true">
                    <IconMenu />
                  </span>
                ),
                dragging: true,
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
