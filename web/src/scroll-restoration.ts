import { useLayoutEffect, useRef } from "react";

/** Restore remembered section positions after a route island hydrates. Native
 * browser history remains owned by the caller. User input cancels restoration. */
export function scrollport() {
  const widget = document.querySelector<HTMLElement>(".widget-scroll");
  if (widget) return widget;
  const main = [...document.querySelectorAll<HTMLElement>(".gtd-main")].find(
    (element) => element.getBoundingClientRect().height > 0,
  );
  return main &&
    getComputedStyle(main).overflowY !== "visible" &&
    main.clientHeight > 0
    ? main
    : null;
}
export function scrollPosition() {
  return scrollport()?.scrollTop ?? window.scrollY;
}

/** Preserve the visible task when a refreshed snapshot inserts or reorders
 * rows above it. Measure the same row after commit, before the next paint. */
export function useTaskScrollAnchor() {
  const root = useRef<HTMLElement>(null);
  const pending = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = pending.current;
    pending.current = null;
    if (!anchor) return;
    const row = [...(root.current?.querySelectorAll<HTMLElement>("[data-gtd-task]") || [])]
      .find(element => element.dataset.gtdTask === anchor.id && element.getClientRects().length);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    const port = scrollport();
    if (port) port.scrollTop += delta;
    else window.scrollBy(0, delta);
  });
  function remember() {
    if (scrollPosition() <= 0) return;
    const port = scrollport();
    const top = port?.getBoundingClientRect().top ?? 0;
    const rows = root.current?.querySelectorAll<HTMLElement>("[data-gtd-task]") || [];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.height && rect.bottom > top && row.dataset.gtdTask) {
        pending.current = { id: row.dataset.gtdTask, top: rect.top };
        return;
      }
    }
  }
  return { root, remember };
}
export function restorePosition(y?: number, selector?: string) {
  if (y === undefined && !selector) return () => {};
  let stopped = false,
    frame = 0;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    observer.disconnect();
    for (const event of ["pointerdown", "wheel", "touchstart", "keydown"])
      document.removeEventListener(event, stop, true);
  };
  const attempt = () => {
    if (stopped) return;
    if (y !== undefined) {
      const port = scrollport();
      if (port) port.scrollTo(0, y);
      else window.scrollTo(0, y);
    }
    if (selector) {
      const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (element) =>
          element.getBoundingClientRect().height > 0 &&
          !element.closest("[inert]"),
      );
      if (target?.getBoundingClientRect().height) {
        target.focus({ preventScroll: true });
        selector = undefined;
      }
    }
  };
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(attempt);
  });
  observer.observe(document.body);
  const main = [...document.querySelectorAll<HTMLElement>(".gtd-content")].find(
    (element) => element.getBoundingClientRect().height > 0,
  );
  if (main) observer.observe(main);
  const timer = setTimeout(stop, 2000);
  for (const event of ["pointerdown", "wheel", "touchstart", "keydown"])
    document.addEventListener(event, stop, { capture: true, passive: true });
  frame = requestAnimationFrame(attempt);
  return stop;
}

