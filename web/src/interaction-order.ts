/** Refresh data without moving a target underneath an editor or gesture. */
let scrollingUntil = 0;
if (typeof document !== "undefined")
  document.addEventListener("scroll", () => {
    scrollingUntil = performance.now() + 160;
  }, { capture: true, passive: true });

export function interactionInProgress() {
  const selector =
    ".inspector, [role='dialog'], [role='menu'], [data-swiping], [data-swipe-open], .task-expansion[data-resizing]";
  return (
    performance.now() < scrollingUntil ||
    [...document.querySelectorAll(selector)].some(
      (el) => el.getClientRects().length > 0,
    ) ||
    !!document.querySelector(":active") ||
    !!document.activeElement?.matches("input,textarea,select")
  );
}
