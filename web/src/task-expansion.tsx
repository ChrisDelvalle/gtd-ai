import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Keep the rendered height and the height seen by the host in step. Animating
 * only size-changed messages lets the host first observe the full-height DOM. */
export function TaskExpansion({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(open);
  useLayoutEffect(() => {
    if (open) setRetained(true);
    const box = outer.current!;
    const contents = inner.current!;
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      const height = open ? contents.getBoundingClientRect().height : 0;
      if (!open && !box.style.height) {
        box.style.height = "0px";
        return;
      }
      if (box.style.height === `${height}px`) return;
      // While the content animates, the bridge must report its actual height,
      // not run a second animation behind it. Include the final resize frame.
      box.dataset.resizing = "true";
      box.style.height = `${height}px`;
      clearTimeout(timer);
      timer = setTimeout(() => {
        delete box.dataset.resizing;
        if (!open) setRetained(false);
      }, 240);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(contents);
    return () => {
      clearTimeout(timer);
      delete box.dataset.resizing;
      observer.disconnect();
    };
  }, [open]);
  return (
    <div
      ref={outer}
      className="task-expansion"
      data-open={open}
      inert={!open}
      aria-hidden={!open}
    >
      <div ref={inner}>{open || retained ? children : null}</div>
    </div>
  );
}
