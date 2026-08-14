import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Trash2 } from "lucide-react";

const ACTION_WIDTH = 76;
const OPEN_THRESHOLD = 32;
const DELETE_THRESHOLD = 96;
const DIRECTION_THRESHOLD = 8;
const MAX_DRAG = 120;

export type SwipeDeleteOutcome = "closed" | "open" | "delete";

export function swipeDeleteOutcome(offset: number): SwipeDeleteOutcome {
  if (offset <= -DELETE_THRESHOLD) return "delete";
  if (offset <= -OPEN_THRESHOLD) return "open";
  return "closed";
}

interface SwipeState {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  direction: "pending" | "horizontal" | "vertical";
}

export function SwipeToDelete({
  open,
  label,
  children,
  onOpenChange,
  onDelete,
}: {
  open: boolean;
  label: string;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}) {
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const dragOffsetRef = useRef<number | null>(null);
  const swipe = useRef<SwipeState | null>(null);
  const suppressClick = useRef(false);
  const restingOffset = open ? -ACTION_WIDTH : 0;
  const offset = dragOffset ?? restingOffset;

  const resetSwipe = () => {
    swipe.current = null;
    dragOffsetRef.current = null;
    setDragOffset(null);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || event.button !== 0) return;
    swipe.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: restingOffset,
      direction: "pending",
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = swipe.current;
    if (!current || current.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (current.direction === "pending") {
      if (
        Math.abs(deltaX) < DIRECTION_THRESHOLD &&
        Math.abs(deltaY) < DIRECTION_THRESHOLD
      ) {
        return;
      }
      current.direction =
        Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
    }
    if (current.direction === "vertical") return;

    event.preventDefault();
    const nextOffset = Math.max(-MAX_DRAG, Math.min(0, current.startOffset + deltaX));
    dragOffsetRef.current = nextOffset;
    setDragOffset(nextOffset);
  };

  const finishSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = swipe.current;
    if (!current || current.pointerId !== event.pointerId) return;

    const finalOffset = dragOffsetRef.current ?? current.startOffset;
    const wasHorizontal = current.direction === "horizontal";
    resetSwipe();
    if (!wasHorizontal) return;

    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);

    const outcome = swipeDeleteOutcome(finalOffset);
    if (outcome === "delete") {
      onOpenChange(false);
      onDelete();
    } else {
      onOpenChange(outcome === "open");
    }
  };

  return (
    <div
      className={`thread-swipe${open ? " open" : ""}${
        dragOffset !== null ? " dragging" : ""
      }`}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }}
    >
      <button
        type="button"
        className="thread-swipe-delete"
        aria-label={`Delete ${label}`}
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChange(false);
          onDelete();
        }}
      >
        <Trash2 size={18} />
        <span>Delete</span>
      </button>
      <div
        className="thread-swipe-content"
        style={{ transform: `translate3d(${offset}px, 0, 0)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={resetSwipe}
      >
        {children}
      </div>
    </div>
  );
}
