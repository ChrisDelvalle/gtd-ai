import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";

type ActiveRow = { element: HTMLElement; close: (focus?: boolean) => void };
function coordinator() {
  let active: ActiveRow | null = null;
  return {
    claim(row: ActiveRow) {
      if (active?.element !== row.element) active?.close();
      active = row;
    },
    release(element: HTMLElement) {
      if (active?.element === element) active = null;
    },
    dismiss(event?: Event) {
      if (!active) return;
      if (
        event &&
        ["pointerdown", "touchstart", "focusin"].includes(event.type) &&
        active.element.contains(event.target as Node)
      )
        return;
      const row = active;
      active = null;
      row.close(event?.type === "keydown");
    },
    get opened() {
      return active !== null;
    },
  };
}
const Swipes = createContext<ReturnType<typeof coordinator> | null>(null);

/** One coordinator per app, not one per list or retained route. */
export function SwipeActionsProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string;
}) {
  const [scope] = useState(coordinator);
  useLayoutEffect(() => {
    scope.dismiss();
  }, [scope, resetKey]);
  useLayoutEffect(() => {
    const dismiss = (event: Event) => scope.dismiss(event);
    let width = window.innerWidth;
    const resize = () => {
      // Inline hosts resize the iframe height as content settles. That must
      // not cancel a gesture already underway on an otherwise unchanged row.
      if (width !== window.innerWidth) scope.dismiss();
      width = window.innerWidth;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && scope.opened) {
        event.preventDefault();
        scope.dismiss(event);
      }
    };
    for (const name of [
      "pointerdown",
      "touchstart",
      "focusin",
      "scroll",
      "visibilitychange",
    ])
      document.addEventListener(name, dismiss, {
        capture: true,
        passive: true,
      });
    window.addEventListener("resize", resize);
    document.addEventListener("keydown", key);
    return () => {
      scope.dismiss();
      for (const name of [
        "pointerdown",
        "touchstart",
        "focusin",
        "scroll",
        "visibilitychange",
      ])
        document.removeEventListener(name, dismiss, true);
      window.removeEventListener("resize", resize);
      document.removeEventListener("keydown", key);
    };
  }, [scope]);
  return <Swipes.Provider value={scope}>{children}</Swipes.Provider>;
}

const WIDTH = 144;
export function SwipeTaskRow({
  children,
  disabled,
  archived,
  title,
  onEdit,
  onArchive,
}: {
  children: ReactNode;
  disabled: boolean;
  archived: boolean;
  title: string;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const scope = useContext(Swipes);
  const root = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const current = useRef({ disabled, open });
  current.current = { disabled, open };
  const cancel = useRef<(focus?: boolean) => void>(() => {});
  useLayoutEffect(() => {
    if (disabled) cancel.current();
  }, [disabled]);
  useLayoutEffect(() => {
    const element = root.current!;
    if (!scope) return;
    let gesture: {
      x: number;
      y: number;
      start: number;
      offset: number;
      locked: boolean;
      time: number;
      dx: number;
      action: boolean;
    } | null = null;
    let suppressedUntil = 0;
    let focusFrame = 0;
    const close = (focus = false) => {
      gesture = null;
      setOffset(0);
      setOpen(false);
      setDragging(false);
      scope.release(element);
      if (focus) {
        cancelAnimationFrame(focusFrame);
        focusFrame = requestAnimationFrame(() =>
          element
            .querySelector<HTMLButtonElement>(".task-title")
            ?.focus({ preventScroll: true }),
        );
      }
    };
    cancel.current = close;
    const start = (event: TouchEvent) => {
      suppressedUntil = 0;
      if (event.touches.length !== 1) {
        close();
        return;
      }
      const target = event.target as HTMLElement;
      if (
        current.current.disabled ||
        target.closest(
          "[inert], [data-preview-clipped], input, textarea, select, a, [contenteditable=true]",
        )
      )
        return;
      if (window.getSelection()?.toString()) return;
      const touch = event.touches[0];
      // Leave both screen edges to browser/host navigation and our drawer.
      if (touch.clientX <= 28 || touch.clientX >= window.innerWidth - 24)
        return;
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        start: current.current.open ? WIDTH : 0,
        offset: current.current.open ? WIDTH : 0,
        locked: false,
        time: event.timeStamp,
        dx: 0,
        action: !!target.closest(".task-swipe-actions"),
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (
        event.touches.length !== 1 ||
        current.current.disabled ||
        window.getSelection()?.toString()
      ) {
        close();
        return;
      }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = event.touches[0].clientY - gesture.y;
      if (!gesture.locked) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        if (
          !event.cancelable ||
          Math.abs(dx) <= Math.abs(dy) * 1.5 ||
          (!gesture.start && dx >= 0)
        ) {
          close();
          return;
        }
        gesture.locked = true;
        scope.claim({ element, close });
        setDragging(true);
      }
      if (!event.cancelable) {
        close();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      gesture.dx = dx;
      gesture.offset = Math.min(WIDTH, Math.max(0, gesture.start - dx));
      setOffset(gesture.offset);
      suppressedUntil = performance.now() + 700;
    };
    const end = (event: TouchEvent) => {
      const finished = gesture;
      gesture = null;
      if (!finished?.locked) {
        if (finished && !finished.action && current.current.open) {
          suppressedUntil = performance.now() + 700;
          close(true);
        }
        return;
      }
      event.stopPropagation();
      suppressedUntil = performance.now() + 700;
      const elapsed = Math.max(1, event.timeStamp - finished.time);
      const flick =
        Math.abs(finished.dx) >= 16 && Math.abs(finished.dx) / elapsed > 0.45;
      const revealed = flick
        ? finished.dx < 0
        : finished.start
          ? finished.offset > WIDTH - 48
          : finished.offset >= 48;
      setDragging(false);
      setOpen(revealed);
      setOffset(revealed ? WIDTH : 0);
      if (!revealed) scope.release(element);
    };
    const click = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressedUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressedUntil = 0;
      }
    };
    const cancelled = () => close();
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== "touch") suppressedUntil = 0;
    };
    element.addEventListener("pointerdown", pointer);
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", cancelled);
    element.addEventListener("click", click, true);
    return () => {
      close();
      cancelAnimationFrame(focusFrame);
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancelled);
      element.removeEventListener("pointerdown", pointer);
      element.removeEventListener("click", click, true);
    };
  }, [scope]);
  function act(action: () => void, restoreFocus = false) {
    cancel.current(restoreFocus);
    action();
  }
  return (
    <div
      ref={root}
      className="compact-row task-swipe-row"
      data-swipe-open={open || undefined}
      data-swiping={dragging || undefined}
      style={{ "--swipe-offset": `${-offset}px` } as CSSProperties}
    >
      <div
        className="task-swipe-actions"
        role="group"
        aria-label={`Actions: ${title}`}
        aria-hidden={!open}
        inert={!open}
      >
        <button
          type="button"
          className="swipe-edit"
          disabled={disabled}
          tabIndex={open ? 0 : -1}
          onClick={() => act(onEdit)}
        >
          <Pencil aria-hidden="true" />
          <span>Edit</span>
        </button>
        <button
          type="button"
          className="swipe-archive"
          disabled={disabled}
          tabIndex={open ? 0 : -1}
          onClick={() => act(onArchive, true)}
        >
          {archived ? (
            <ArchiveRestore aria-hidden="true" />
          ) : (
            <Archive aria-hidden="true" />
          )}
          <span>{archived ? "Unarchive" : "Archive"}</span>
        </button>
      </div>
      <div className="task-swipe-front" inert={open}>
        {children}
      </div>
    </div>
  );
}
