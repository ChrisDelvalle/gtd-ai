import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyMessage({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="message-actions">
      <button
        aria-label={copied ? "Copied" : label}
        title={copied ? "Copied" : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setFailed(false);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1800);
          } catch {
            setFailed(true);
          }
        }}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </button>
      {failed && <span role="status">Select the text to copy it.</span>}
    </div>
  );
}
