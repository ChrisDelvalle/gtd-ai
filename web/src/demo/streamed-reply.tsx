import { useEffect, useState } from "react";

/** Presentation only: the scenario has already produced its complete result. */
export function StreamedReply({ text }: { text: string }) {
  const [visible, setVisible] = useState("");
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const words = text.match(/\S+\s*/g) || [];
    const step = Math.min(36, 3000 / Math.max(1, words.length));
    const started = performance.now() + 380;
    let frame = 0,
      previous = -1,
      done = false;
    setFinished(false);
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      setVisible(text);
      setFinished(true);
    };
    const tick = () => {
      if (done) return;
      const count = Math.min(
        words.length,
        Math.max(0, 1 + Math.floor((performance.now() - started) / step)),
      );
      if (count === words.length) return finish();
      if (count !== previous) {
        previous = count;
        setVisible(words.slice(0, count).join("").trimEnd());
      }
      frame = requestAnimationFrame(tick);
    };
    const preferenceChanged = () => {
      if (motion.matches) finish();
    };
    motion.addEventListener("change", preferenceChanged);
    if (motion.matches) finish();
    else tick();
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", preferenceChanged);
    };
  }, [text]);
  return (
    <div
      className="streamed-reply"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={!finished}
    >
      {visible &&
        visible
          .split("\n\n")
          .map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    </div>
  );
}
