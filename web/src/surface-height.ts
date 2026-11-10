import { useLayoutEffect, type RefObject } from "react";

/** One owner for the rendered inline height, including space needed by overlays.
 * Hosts also measure the DOM, so animate the surface itself, never size hints.
 * Content that already animates its height is followed without a second easing.
 */
export function useSurfaceHeight(
  surface: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  mode: "preview" | "fallback" | "fullscreen",
  limit: number,
) {
  useLayoutEffect(() => {
    const box = surface.current!, body = content.current!;
    if (mode === "fullscreen") {
      box.style.removeProperty("height");
      box.style.removeProperty("transition");
      return;
    }
    let first = true;
    const resize = () => {
      const reserved = parseFloat(box.style.getPropertyValue("--overlay-min-height")) || 0;
      const natural = body.getBoundingClientRect().height + 2;
      const height = Math.min(limit, Math.max(natural, reserved));
      // A task disclosure changes its layout on every frame. Retargeting a
      // second transition would lag behind it and then jump at completion.
      const following = [...body.querySelectorAll('.task-expansion[data-resizing]')]
        .some(element => element.getAnimations().some(animation =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "height" &&
          animation.playState === "running"));
      box.style.transition = first || following ? "none" : "";
      box.style.height = `${height}px`;
      if (first) {
        // Establish the initial/mode-switch size before enabling transitions.
        box.getBoundingClientRect();
        first = false;
        box.style.removeProperty("transition");
      }
    };
    resize();
    // React can hide an outgoing route and reveal one of the same final size
    // in one commit. WebKit may coalesce that resize, leaving a measurement of
    // the temporary loading state. Reconcile layout-changing DOM commits too.
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; resize(); });
    };
    // Height writes during observer delivery can trigger another resize in
    // WebKit. Coalesce them with the existing next-frame measurement path.
    const observer = new ResizeObserver(schedule);
    observer.observe(body);
    const commits = new MutationObserver(records => {
      if (records.some(record => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest('.floating-panel');
      })) schedule();
    });
    commits.observe(body, {childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open']});
    let reserved = box.style.getPropertyValue("--overlay-min-height");
    const overlays = new MutationObserver(() => {
      const next = box.style.getPropertyValue("--overlay-min-height");
      if (next !== reserved) {
        reserved = next;
        resize();
      }
    });
    overlays.observe(box, {attributes: true, attributeFilter: ["style"]});
    return () => {
      observer.disconnect();
      commits.disconnect();
      cancelAnimationFrame(frame);
      overlays.disconnect();
      box.style.removeProperty("height");
      box.style.removeProperty("transition");
    };
  }, [surface, content, mode, limit]);
}
