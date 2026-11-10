import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./task-row";

export function SecondaryPages({
  page,
  more,
  busy,
  previous,
  next,
}: {
  page: number;
  more: boolean;
  busy: boolean;
  previous: () => void;
  next: () => void;
}) {
  if (!page && !more) return null;
  return (
    <nav className="secondary-pages compact-pagination" aria-label="List pages">
      <IconButton
        label="Previous page"
        disabled={!page || busy}
        onClick={previous}
      >
        <ChevronLeft />
      </IconButton>
      <span aria-label={`Page ${page + 1}`}>{page + 1}</span>
      <IconButton label="Next page" disabled={!more || busy} onClick={next}>
        <ChevronRight />
      </IconButton>
    </nav>
  );
}
