import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Maximize2, Minimize2, LoaderCircle } from "lucide-react";
import type { HostContext } from "./adapter-bridge";
import { ExpandedView } from "./expanded-view";
import { useSurfaceHeight } from "./surface-height";

const positive = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

export function WidgetSurface({
  context,
  requestExpansion,
  children,
}: {
  context: HostContext;
  requestExpansion: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [fallback, setFallback] = useState(false);
  const [pending, setPending] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const fullscreen = context.displayMode === "fullscreen";
  const currentFull = useRef(fullscreen);
  currentFull.current = fullscreen;
  const mode = fullscreen ? "fullscreen" : fallback ? "fallback" : "preview";
  // Only maxHeight is a host-imposed ceiling in inline mode. A negotiated
  // height is commonly the current iframe height, not its available capacity.
  const ceiling = Math.min(
    450,
    positive(context.containerDimensions?.maxHeight) ?? 450,
  );
  useSurfaceHeight(surface, content, mode, ceiling);
  const fullHeight =
    positive(context.containerDimensions?.height) ??
    positive(context.containerDimensions?.maxHeight);
  const [viewport, setViewport] = useState<number | undefined>();
  useLayoutEffect(() => {
    if (!fullscreen) {
      setViewport(undefined);
      return;
    }
    const update = () =>
      setViewport(window.visualViewport?.height || window.innerHeight);
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, [fullscreen]);
  useLayoutEffect(() => {
    // Returning via the host's close control always restores the safe preview.
    if (fullscreen) setFallback(false);
  }, [fullscreen]);
  const expand = useCallback(async () => {
    if (currentFull.current || fallback) return;
    if (inFlight.current) return inFlight.current;
    setPending(true);
    inFlight.current = (async () => {
      try {
        const mode = await requestExpansion();
        if (mode !== "fullscreen" && !currentFull.current) setFallback(true);
      } catch {
        if (!currentFull.current) setFallback(true);
      } finally {
        setPending(false);
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [fallback, requestExpansion]);
  const expandedAction = useCallback(
    (action: () => void) => {
      void expand().then(action);
    },
    [expand],
  );

  useLayoutEffect(() => {
    const box = scroll.current!,
      body = content.current!;
    const original = new Map<
      HTMLElement,
      { tab: string | null; hidden: string | null; inert: boolean }
    >();
    const restore = (el: HTMLElement) => {
      const old = original.get(el);
      if (!old) return;
      if (old.tab === null) el.removeAttribute("tabindex");
      else el.setAttribute("tabindex", old.tab);
      if (old.hidden === null) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", old.hidden);
      el.inert = old.inert;
      delete el.dataset.previewClipped;
      original.delete(el);
    };
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = box.getBoundingClientRect();
      const clipped = body.getBoundingClientRect().height > bounds.height + 1;
      setOverflow(clipped);
      const edge =
        bounds.bottom -
        (clipped && mode === "preview" ? Math.min(80, bounds.height / 2) : 0);
      for (const el of body.querySelectorAll<HTMLElement>(
        "button,a[href],input,textarea,select,[tabindex]",
      )) {
        const r = el.getBoundingClientRect();
        // Top-layer overlays own the visibility of their controls.
        const outside =
          mode === "preview" &&
          !el.closest(".floating-panel, dialog[open]") &&
          r.height > 0 &&
          (r.bottom > edge + 1 || r.top < bounds.top - 1);
        if (outside) {
          if (!original.has(el))
            original.set(el, {
              tab: el.getAttribute("tabindex"),
              hidden: el.getAttribute("aria-hidden"),
              inert: el.inert,
            });
          el.inert = true;
          el.tabIndex = -1;
          el.setAttribute("aria-hidden", "true");
          el.dataset.previewClipped = "true";
          if (el === document.activeElement)
            expandButton.current?.focus({ preventScroll: true });
        } else restore(el);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    resize.observe(body);
    const mutation = new MutationObserver(schedule);
    mutation.observe(body, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame);
      for (const el of original.keys()) restore(el);
    };
  }, [mode, ceiling, fullHeight]);
  useLayoutEffect(() => {
    if (mode === "preview") scroll.current?.scrollTo(0, 0);
  }, [mode]);

  const height = fullscreen
    ? Math.min(fullHeight ?? viewport ?? 600, viewport ?? Infinity)
    : ceiling;
  const inset = (side: "top" | "right" | "bottom" | "left") =>
    `${Math.max(0, context.safeAreaInsets?.[side] || 0)}px`;
  return (
    <ExpandedView.Provider value={expandedAction}>
      <div
        ref={surface}
        className="widget-surface"
        data-display={mode}
        style={
          {
            "--widget-limit": `${height}px`,
            "--widget-safe-top": inset("top"),
            "--widget-safe-right": inset("right"),
            "--widget-safe-bottom": inset("bottom"),
            "--widget-safe-left": inset("left"),
          } as CSSProperties
        }
      >
        {!fullscreen && (
          <button
            ref={expandButton}
            className="widget-expand"
            aria-label={fallback ? "Return to preview" : "Expand view"}
            title={fallback ? "Return to preview" : "Expand view"}
            disabled={pending}
            onClick={() => (fallback ? setFallback(false) : void expand())}
          >
            {pending ? (
              <LoaderCircle className="spinning" />
            ) : fallback ? (
              <Minimize2 />
            ) : (
              <Maximize2 />
            )}
          </button>
        )}
        <div className="widget-scroll" ref={scroll}>
          <div className="widget-content" ref={content}>
            {children}
          </div>
        </div>
        {mode === "preview" && overflow && (
          <button
            className="widget-fade"
            aria-label="Open full view"
            disabled={pending}
            onClick={() => void expand()}
          ><span>Expand</span></button>
        )}
      </div>
    </ExpandedView.Provider>
  );
}
