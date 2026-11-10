import { expect, type Locator } from "@playwright/test";

// A native tap must hit the already painted button. Playwright's implicit
// scroll-before-tap can send touch input while the compositor is still applying
// the scroll, particularly after a fling in a cross-origin iframe.
export async function revealForTap(target: Locator, scrollContainer: string) {
  await target.evaluate(async (button, selector) => {
    const panel = button.closest<HTMLElement>(selector);
    if (!panel) throw new Error(`Missing touch scroll container: ${selector}`);
    await new Promise<void>((resolve) => {
      const end = () => {
        panel.removeEventListener("scrollend", end);
        resolve();
      };
      panel.addEventListener("scrollend", end);
      const { scrollTop, scrollLeft } = panel;
      button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      if (panel.scrollTop === scrollTop && panel.scrollLeft === scrollLeft) end();
    });
    // Present the new scroll position before dispatching native touch input.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, scrollContainer);
  await expect(target).toBeInViewport();
}
