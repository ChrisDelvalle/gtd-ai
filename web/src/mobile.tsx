import { useEffect, useRef, useState, type RefObject } from "react";

// Extra shortcuts, never the only way to navigate. Only claim a gesture once
// its direction is clear; vertical scrolling, selection and controls win.
export function useMobileGestures({
  shell,
  main,
  refreshContent,
  drawer,
  enabled,
  sidebar,
  setSidebar,
  canRefresh,
  refreshing,
  refresh,
}: {
  shell: RefObject<HTMLDivElement | null>;
  main: RefObject<HTMLElement | null>;
  refreshContent: RefObject<HTMLDivElement | null>;
  drawer: RefObject<HTMLElement | null>;
  enabled: boolean;
  sidebar: boolean;
  setSidebar: (open: boolean) => void;
  canRefresh: boolean;
  refreshing: boolean;
  refresh: () => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [pull, setPull] = useState(0);
  const [pullTracking, setPullTracking] = useState(false);
  const latest = useRef({
    sidebar,
    canRefresh,
    refreshing,
    refresh,
    setSidebar,
  });
  latest.current = { sidebar, canRefresh, refreshing, refresh, setSidebar };
  useEffect(() => {
    // Hold the actual release position until the read finishes. Returning via
    // a separate fixed loading height creates a second, visible movement.
    if (!refreshing && !pullTracking) setPull(0);
  }, [refreshing, pullTracking]);
  useEffect(() => {
    const root = shell.current;
    if (!enabled || !root) {
      setDrag(null);
      setPull(0);
      setPullTracking(false);
      return;
    }
    let gesture: {
      x: number;
      y: number;
      width: number;
      mode: "open" | "close" | "pull";
      locked: boolean;
      amount: number;
    } | null = null;
    let suppressClick = false;
    // Browser pages use document scrolling so content can extend behind Safari's
    // floating controls. Installed apps retain their main-element scrollport.
    const atTop = () => (main.current?.scrollTop || 0) <= 0 && window.scrollY <= 0;
    const reset = () => {
      gesture = null;
      setDrag(null);
      setPull(0);
      setPullTracking(false);
    };
    const start = (e: TouchEvent) => {
      suppressClick = false;
      if (latest.current.refreshing) return;
      reset();
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement;
      const scrim = target.closest(".nav-scrim");
      if (
        !scrim &&
        target.closest(
          "input,textarea,select,form,[contenteditable=true],[role=menu],dialog,[role=dialog],.project-editor,.repeat-controls",
        )
      )
        return;
      const t = e.touches[0];
      const width = drawer.current?.getBoundingClientRect().width || 280;
      if (latest.current.sidebar) {
        gesture = {
          x: t.clientX,
          y: t.clientY,
          width,
          mode: "close",
          locked: false,
          amount: width,
        };
      } else if (t.clientX <= 28) {
        gesture = {
          x: t.clientX,
          y: t.clientY,
          width,
          mode: "open",
          locked: false,
          amount: 0,
        };
      } else if (
        latest.current.canRefresh &&
        main.current?.contains(target) &&
        atTop() &&
        // Let the compositor finish settling before another pull takes over.
        // Ordinary scrolling and drawer gestures remain available meanwhile.
        !refreshContent.current
          ?.getAnimations()
          .some((animation) => animation.playState === "running")
      ) {
        gesture = {
          x: t.clientX,
          y: t.clientY,
          width,
          mode: "pull",
          locked: false,
          amount: 0,
        };
      }
    };
    const move = (e: TouchEvent) => {
      if (!gesture) return;
      if (
        e.touches.length !== 1 ||
        (window.getSelection()?.toString().length || 0) > 0
      ) {
        reset();
        return;
      }
      const dx = e.touches[0].clientX - gesture.x,
        dy = e.touches[0].clientY - gesture.y;
      if (!gesture.locked) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        const valid =
          gesture.mode === "pull"
            ? dy > Math.abs(dx) * 1.5 && atTop()
            : Math.abs(dx) > Math.abs(dy) * 1.5 &&
              (gesture.mode === "open" ? dx > 0 : dx < 0);
        if (!valid || !e.cancelable) {
          reset();
          return;
        }
        gesture.locked = true;
        suppressClick = true;
      }
      if (e.cancelable) e.preventDefault();
      if (gesture.mode === "pull") {
        setPullTracking(true);
        const distance = Math.max(0, dy * 0.5);
        // Preserve the usual pull and refresh threshold, then add smoothly
        // increasing resistance instead of stopping abruptly at a hard limit.
        gesture.amount = distance <= 88
          ? distance
          : 88 + 48 * Math.log1p((distance - 88) / 48);
        setPull(gesture.amount);
      } else {
        gesture.amount = Math.min(
          gesture.width,
          Math.max(0, (gesture.mode === "close" ? gesture.width : 0) + dx),
        );
        setDrag(gesture.amount / gesture.width);
      }
    };
    const end = () => {
      const g = gesture;
      if (!g) return;
      if (g.locked && g.mode === "pull" && g.amount >= 64) {
        gesture = null;
        setPullTracking(false);
        latest.current.refresh();
        return;
      }
      reset();
      if (!g?.locked) return;
      if (g.mode !== "pull")
        latest.current.setSidebar(
          g.mode === "open"
            ? g.amount >= Math.min(80, g.width * 0.25)
            : g.amount > g.width - 70,
        );
    };
    const cancel = () => {
      if (gesture) reset();
    };
    const pointer = (e: PointerEvent) => {
      if (e.pointerType !== "touch") suppressClick = false;
    };
    const click = (e: MouseEvent) => {
      if (suppressClick && e.detail !== 0) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    };
    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", cancel);
    root.addEventListener("click", click, true);
    root.addEventListener("pointerdown", pointer, true);
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", cancel);
      root.removeEventListener("click", click, true);
      root.removeEventListener("pointerdown", pointer, true);
    };
  }, [enabled, shell, main, drawer, refreshContent]);
  return { drag, pull, pullTracking };
}

export function useKeyboardInset(active: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setInset(0);
      return;
    }
    const update = () =>
      setInset(
        Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop),
      );
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [active]);
  return inset;
}

export function useDrawerFocus(
  drawer: RefObject<HTMLElement | null>,
  open: boolean,
) {
  useEffect(() => {
    const node = drawer.current;
    if (!open || !node) return;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () =>
      [
        ...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]',
        ),
      ].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null && !el.closest("[inert]"));
    controls()[0]?.focus({ preventScroll: true });
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const all = controls(),
        i = all.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    };
    // Root-scrolling browser pages must stay put while the drawer is modal.
    // The navigation list keeps its own scrollport and overscroll containment.
    const stopBackgroundScroll = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (!node.contains(target) || !target.closest("nav")) e.preventDefault();
    };
    node.addEventListener("keydown", trap);
    node.parentElement?.addEventListener("wheel", stopBackgroundScroll, { passive: false });
    return () => {
      node.removeEventListener("keydown", trap);
      node.parentElement?.removeEventListener("wheel", stopBackgroundScroll);
      // Safari does not focus buttons on tap and can move focus to body when
      // main becomes inert. Always give keyboard/VoiceOver a useful return.
      const target =
        previous?.isConnected &&
        previous.matches("button,a,input,textarea,select,[tabindex]")
          ? previous
          : node.parentElement?.querySelector<HTMLElement>(
              '.gtd-main button[aria-label="Open navigation"]',
            );
      target?.focus({ preventScroll: true });
    };
  }, [drawer, open]);
}
