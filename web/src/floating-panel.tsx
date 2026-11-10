import {
  useLayoutEffect,
  useRef,
  useId,
  type ReactNode,
  type RefObject,
} from "react";

let spaceTimer: ReturnType<typeof setTimeout> | undefined;
let spaceOwner: symbol | undefined;
function reserveSpace(owner: symbol, height: number) {
  clearTimeout(spaceTimer);
  spaceOwner = owner;
  const surface = document.querySelector<HTMLElement>(".widget-surface");
  if (surface) {
    if (surface.dataset.display !== "fullscreen") {
      const natural =
        surface
          .querySelector<HTMLElement>(".widget-scroll")!
          .getBoundingClientRect().height + 2;
      const limit =
        parseFloat(
          getComputedStyle(surface).getPropertyValue("--widget-limit"),
        ) || 450;
      // Once reserved, keep the surface stable until dismissal. Live filters
      // can shrink its content; recomputing from that shorter content would
      // oscillate the iframe and the controls beneath the pointer.
      const previous =
        parseFloat(surface.style.getPropertyValue("--overlay-min-height")) || 0;
      surface.style.setProperty(
        "--overlay-min-height",
        `${Math.min(limit, Math.max(previous, natural + height))}px`,
      );
    }
    return;
  }
  let space = document.getElementById("gtd-overlay-space");
  if (!space) {
    space = document.createElement("div");
    space.id = "gtd-overlay-space";
    space.setAttribute("aria-hidden", "true");
    space.style.height = "0px";
    document.getElementById("root")!.append(space);
    space.getBoundingClientRect();
  }
  space.dataset.hostResizing = "true";
  space.style.height = `${Math.max(0, Math.ceil(height))}px`;
}
function releaseSpace(owner: symbol) {
  if (spaceOwner !== owner) return;
  const surface = document.querySelector<HTMLElement>(".widget-surface");
  if (surface) {
    surface.style.removeProperty("--overlay-min-height");
    spaceOwner = undefined;
    return;
  }
  const space = document.getElementById("gtd-overlay-space");
  if (!space) return;
  space.style.height = "0px";
  spaceTimer = setTimeout(() => {
    if (spaceOwner === owner) {
      space.remove();
      spaceOwner = undefined;
    }
  }, 240);
}

/** Temporary controls belong above the document; disclosures and editors stay in it.
 * The native top layer escapes scroll/transform clipping while preserving theme,
 * DOM reading order and the inspector's focus scope. */
export function FloatingPanel({
  children,
  anchor,
  returnFocus,
  close,
  label,
  className = "",
  menu = false,
  align = "end",
}: {
  children: ReactNode;
  anchor: RefObject<HTMLButtonElement | null>;
  returnFocus?: RefObject<HTMLButtonElement | null>;
  close: () => void;
  label: string;
  className?: string;
  menu?: boolean;
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(close);
  dismiss.current = close;
  const id = useId();
  useLayoutEffect(() => {
    const panel = ref.current!;
    const trigger = anchor.current;
    if (!trigger) return;
    const restoreFocus = () => {
      const target = returnFocus?.current?.isConnected
        ? returnFocus.current
        : trigger;
      if (target.isConnected) target.focus({ preventScroll: true });
    };
    const controls = trigger.getAttribute("aria-controls");
    trigger.setAttribute("aria-controls", id);
    if (typeof panel.showPopover === "function") panel.showPopover();
    else panel.dataset.fallback = "true";

    const body = document.body;
    const owner = Symbol();
    let widgetDown: boolean | undefined;
    const widget = body.classList.contains("widget");
    const root = document.getElementById("root")!;
    const list =
      widget && !menu && !document.querySelector(".widget-surface")
        ? trigger.closest<HTMLElement>(".compact-widget")
        : null;
    const previousMinHeight = list?.style.minHeight;
    if (list) {
      // Keep the footer anchor in place while live filters temporarily remove
      // rows. Release this space with the card’s normal size animation on close.
      list.style.minHeight = `${list.getBoundingClientRect().height}px`;
      list.dataset.overlayLocked = "true";
    }
    const safe = document.createElement("div");
    safe.className = "floating-safe-area";
    panel.append(safe);
    let frame = 0;
    let closing = false;
    const finish = (restore = false) => {
      if (closing) return;
      closing = true;
      if (restore) restoreFocus();
      dismiss.current();
    };
    const place = () => {
      frame = 0;
      if (closing) return;
      if (!trigger.isConnected) {
        finish();
        return;
      }
      const a = trigger.getBoundingClientRect();
      const v = window.visualViewport;
      const inset = getComputedStyle(safe);
      const left = (v?.offsetLeft || 0) + 8 + parseFloat(inset.paddingLeft);
      const top = (v?.offsetTop || 0) + 8 + parseFloat(inset.paddingTop);
      const right =
        (v?.offsetLeft || 0) +
        (v?.width || innerWidth) -
        8 -
        parseFloat(inset.paddingRight);
      const bottom =
        (v?.offsetTop || 0) +
        (v?.height || innerHeight) -
        8 -
        parseFloat(inset.paddingBottom);
      panel.style.maxWidth = `${Math.max(0, right - left)}px`;
      // scrollHeight remains the natural height even when the menu is constrained.
      // Measuring the natural height temporarily removes the scroll range.
      // WebKit clamps scrollTop during that layout; restore it after sizing so
      // host resize notifications cannot move an item between press and click.
      const scrollTop = panel.scrollTop;
      panel.style.maxHeight = "none";
      const height = Math.ceil(panel.getBoundingClientRect().height);
      if (widget) {
        // Pick a side once from the card content, never from the iframe that
        // is still resizing. Short cards reserve real, animated space below.
        const reservedHeight =
          document.getElementById("gtd-overlay-space")?.getBoundingClientRect()
            .height || 0;
        const contentHeight = Math.max(
          0,
          root.getBoundingClientRect().height - reservedHeight,
        );
        widgetDown ??= a.top - top - 6 < height;
        const surface = document.querySelector<HTMLElement>(".widget-surface");
        const limit = surface
          ? parseFloat(
              getComputedStyle(surface).getPropertyValue("--widget-limit"),
            )
          : 640;
        const needed = widgetDown
          ? Math.min(limit, a.bottom + height + 14)
          : contentHeight;
        reserveSpace(owner, Math.max(0, needed - contentHeight));
      }
      const below = Math.max(0, bottom - a.bottom - 6);
      const above = Math.max(0, a.top - top - 6);
      const down = widgetDown ?? (below >= height || below >= above);
      const available = Math.max(
        0,
        Math.min(bottom - top, down ? below : above),
      );
      panel.style.maxHeight = `${available}px`;
      panel.scrollTop = scrollTop;
      const actualHeight = Math.min(height, available);
      const width = panel.getBoundingClientRect().width;
      panel.style.left = `${Math.max(left, Math.min(align === "start" ? a.left : a.right - width, right - width))}px`;
      const y = down ? a.bottom + 6 : a.top - actualHeight - 6;
      panel.style.top = `${Math.max(top, Math.min(y, bottom - actualHeight))}px`;
      panel.dataset.placement = down ? "bottom" : "top";
      const ready = available >= Math.min(height, 80);
      panel.style.visibility = ready ? "visible" : "hidden";
      if (ready && !panel.dataset.ready) {
        panel.dataset.ready = "true";
        if (menu)
          (
            panel.querySelector<HTMLButtonElement>(
              'button[aria-checked="true"]',
            ) || panel.querySelector<HTMLButtonElement>("button:not(:disabled)")
          )?.focus({ preventScroll: true });
        else panel.focus({ preventScroll: true });
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    // Focus is assigned when the panel is first visible; never summon a keyboard.
    const outside = (event: PointerEvent) => {
      if (
        !panel.contains(event.target as Node) &&
        !trigger.contains(event.target as Node)
      )
        finish();
    };
    const focus = (event: FocusEvent) => {
      if (
        !panel.contains(event.target as Node) &&
        !trigger.contains(event.target as Node)
      )
        finish();
    };
    const scroll = (event: Event) => {
      if (panel.contains(event.target as Node)) return;
      // Layout anchoring and focus can scroll either surface without a user
      // gesture. Reposition instead of closing between pointerdown and click.
      // Explicit wheel/touch gestures outside still dismiss below.
      schedule();
    };
    const scrollGesture = (event: Event) => {
      if (!panel.contains(event.target as Node)) finish();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (menu && panel.contains(document.activeElement)) {
        const buttons = [
          ...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        } else if (event.key === "Tab") finish(true);
      }
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    observer.observe(trigger);
    observer.observe(root);
    const blur = () => finish();
    window.addEventListener("blur", blur);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("wheel", scrollGesture, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchmove", scrollGesture, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("wheel", scrollGesture, true);
      document.removeEventListener("touchmove", scrollGesture, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      if (panel.contains(document.activeElement)) restoreFocus();
      if (
        typeof panel.showPopover === "function" &&
        panel.matches(":popover-open")
      )
        panel.hidePopover();
      safe.remove();
      if (list) {
        list.style.minHeight = previousMinHeight || "";
        delete list.dataset.overlayLocked;
      }
      if (widget) releaseSpace(owner);
      if (controls === null) trigger.removeAttribute("aria-controls");
      else trigger.setAttribute("aria-controls", controls);
    };
  }, [anchor, returnFocus, id, menu, align]);
  return (
    <div
      ref={ref}
      id={id}
      popover="manual"
      tabIndex={-1}
      className={`floating-panel ${className}`}
      role={menu ? "menu" : "dialog"}
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function Menu({
  children,
  anchor,
  returnFocus,
  close,
  label = "Task menu",
  className = "",
  align,
}: {
  children: ReactNode;
  anchor: RefObject<HTMLButtonElement | null>;
  returnFocus?: RefObject<HTMLButtonElement | null>;
  close: () => void;
  label?: string;
  className?: string;
  align?: "start" | "end";
}) {
  return (
    <FloatingPanel
      menu
      align={align}
      anchor={anchor}
      returnFocus={returnFocus}
      close={close}
      label={label}
      className={`compact-menu ${className}`}
    >
      {children}
    </FloatingPanel>
  );
}
