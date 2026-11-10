import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Menu } from "./floating-panel";

export function ChartSelector<T extends string>({
  value,
  select,
  options,
  labels,
  label,
  prefix,
  triggerLabel = labels[value],
  children,
  align = "start",
  anchorRef,
}: {
  value: T;
  select: (value: T) => void;
  options: readonly T[];
  labels: Record<T, string>;
  label: string;
  prefix: string;
  triggerLabel?: string;
  children?: ReactNode;
  align?: "start" | "end";
  anchorRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const localAnchor = useRef<HTMLButtonElement>(null);
  const anchor = anchorRef || localAnchor;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="chart-selector"
        aria-label={`${prefix}: ${triggerLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="chart-selector-label">{triggerLabel}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <Menu
          label={label}
          className="chart-mode-menu"
          align={align}
          anchor={anchor}
          close={() => setOpen(false)}
        >
          {options.map((option) => (
            <button
              key={option}
              role="menuitemradio"
              aria-checked={value === option}
              onClick={() => {
                setOpen(false);
                select(option);
              }}
            >
              <span>{labels[option]}</span>
              {value === option && <Check aria-hidden="true" />}
            </button>
          ))}
          {children}
        </Menu>
      )}
    </>
  );
}

export function intensity(count: number) {
  return count === 0
    ? 0
    : count <= 2
      ? 1
      : count <= 5
        ? 2
        : count <= 10
          ? 3
          : 4;
}
