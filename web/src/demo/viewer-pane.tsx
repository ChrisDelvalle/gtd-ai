import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

/** Host layout only: the application iframe stays mounted while the pane moves. */
export function useViewerPane() {
  const [width, setWidth] = useState(() => innerWidth);
  const [fraction, setFraction] = useState(0.39);
  const [full, setFull] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const resize = () => setWidth(innerWidth);
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  const minimum = 405;
  const maximum = Math.max(minimum, width - 350);
  const clamp = (left: number) => Math.min(maximum, Math.max(minimum, left));
  const left =
    width <= 800 ? 0 : full ? 52 : clamp(52 + (width - 52) * fraction);
  const move = (x: number) => setFraction((clamp(x) - 52) / (width - 52));
  const divider =
    width > 800 && !full ? (
      <div
        className="viewer-divider"
        role="separator"
        aria-label="Resize chat and widget"
        aria-orientation="vertical"
        aria-valuemin={minimum}
        aria-valuemax={maximum}
        aria-valuenow={Math.round(left)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.focus({ preventScroll: true });
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
        }}
        onLostPointerCapture={() => setDragging(false)}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          e.preventDefault();
          move(
            e.key === "Home"
              ? minimum
              : e.key === "End"
                ? maximum
                : left + (e.key === "ArrowLeft" ? -32 : 32),
          );
        }}
      />
    ) : null;
  const toggle =
    width > 800 ? (
      <button
        aria-label={full ? "Exit full view" : "Enter full view"}
        aria-pressed={full}
        onClick={() => setFull(!full)}
      >
        {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>
    ) : null;
  return {
    width,
    left,
    full,
    dragging,
    divider,
    toggle,
    reset: () => setFull(false),
  };
}
