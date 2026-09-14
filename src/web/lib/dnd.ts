/**
 * pragmatic-drag-and-drop wiring. Cards are draggables carrying `{ type: "card", id }`; the
 * drop targets are priority sections, lane cells / headers and column bodies carrying a
 * `DropTarget` (`lib/dnd-intent.ts`). One monitor per board turns a drop into `moveRows`.
 * A selected card drags the whole selection.
 */
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { moveRows } from "../state/actions.ts";
import { dragging, pending, selection } from "../state/selection.ts";
import type { DropTarget } from "./dnd-intent.ts";

export const CARD_TYPE = "card";

interface CardData extends Record<string | symbol, unknown> {
  type: typeof CARD_TYPE;
  id: string;
  ids: string[];
}

interface ZoneData extends Record<string | symbol, unknown> {
  type: "zone";
  target: DropTarget;
}

function isCard(data: Record<string | symbol, unknown>): data is CardData {
  return data.type === CARD_TYPE && typeof data.id === "string";
}

function draggedIds(id: string): string[] {
  const selected = selection.value;
  return selected.has(id) ? [...selected] : [id];
}

/** Make a card draggable. Returns whether it is currently the drag source. */
export function useDraggableCard(ref: RefObject<HTMLElement>, id: string, canDrag = true): boolean {
  const [isDragging, setDragging] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !canDrag) return;
    return draggable({
      element,
      canDrag: () => !pending.value.has(id),
      getInitialData: (): CardData => ({ type: CARD_TYPE, id, ids: draggedIds(id) }),
      onGenerateDragPreview({ nativeSetDragImage, source }) {
        const ids = (source.data as CardData).ids;
        if (ids.length < 2) return; // the browser snapshots the card itself
        setCustomNativeDragPreview({
          nativeSetDragImage,
          render({ container }) {
            container.className = "drag-preview";
            container.textContent = `${ids.length}`;
            return () => {};
          },
        });
      },
      onDragStart({ source }) {
        setDragging(true);
        dragging.value = new Set((source.data as CardData).ids);
      },
      onDrop() {
        setDragging(false);
        dragging.value = null;
      },
    });
  }, [ref, id, canDrag]);
  return isDragging;
}

/** Register an element as a drop zone for cards. Returns whether a card hovers over it. */
export function useDropZone(
  ref: RefObject<HTMLElement>,
  target: DropTarget,
  enabled = true,
): boolean {
  const [over, setOver] = useState(false);
  // `getData` runs at drop time and reads the latest target, so the zone is registered once.
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    return dropTargetForElements({
      element,
      getData: (): ZoneData => ({ type: "zone", target: latest.current }),
      canDrop: ({ source }) => isCard(source.data),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, [ref, enabled]);
  return over;
}

/** Board-wide monitor: the innermost zone under the pointer receives the drop. */
export function useBoardDnd(db: string): void {
  useEffect(() => {
    return combine(
      monitorForElements({
        canMonitor: ({ source }) => isCard(source.data),
        onDrop({ source, location }) {
          dragging.value = null;
          const zone = location.current.dropTargets[0];
          if (zone?.data.type !== "zone") return;
          const data = source.data as CardData;
          void moveRows(db, data.ids, (zone.data as ZoneData).target);
        },
      }),
    );
  }, [db]);
}
