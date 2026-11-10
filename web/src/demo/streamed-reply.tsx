import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";

type TextTree = { type: string; value?: string; children?: TextTree[] };

// Parse the complete reply, then reveal its text. A half-streamed bold phrase
// remains bold instead of flashing Markdown punctuation or shifting list layout.
function revealText(limit: number) {
  return () => (tree: TextTree) => {
    let remaining = limit;
    const reveal = (node: TextTree): boolean => {
      if (remaining <= 0) return false;
      if (node.type === "text") {
        node.value = (node.value || "").slice(0, remaining);
        remaining -= node.value.length;
        return !!node.value;
      }
      node.children = node.children?.filter(reveal);
      return !!node.children?.length;
    };
    tree.children = tree.children?.filter(reveal);
  };
}

/** Presentation only: the scenario has already produced its complete result. */
export function StreamedReply({ text }: { text: string }) {
  const [visible, setVisible] = useState("");
  const [finished, setFinished] = useState(false);
  const plugins = useMemo(
    () => [revealText(finished ? Infinity : visible.length)],
    [visible.length, finished],
  );
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
      <Markdown
        allowedElements={["p", "strong", "em", "ul", "ol", "li"]}
        unwrapDisallowed
        skipHtml
        rehypePlugins={plugins}
      >
        {text}
      </Markdown>
    </div>
  );
}
