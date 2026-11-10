import { useLayoutEffect, useRef, type ReactNode } from "react";

/** One measured surface for list, editor, history and recovery transitions.
 * Nested task disclosures already animate their layout, so follow them directly. */
export function AnimatedSize({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null),
    inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = outer.current!,
      content = inner.current!;
    let first = true;
    const resize = () => {
      box.style.transition =
        first || content.querySelector(".task-expansion[data-resizing]")
          ? "none"
          : "";
      box.style.height = `${content.getBoundingClientRect().height}px`;
      first = false;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="animated-size" ref={outer}>
      <div ref={inner}>{children}</div>
    </div>
  );
}
