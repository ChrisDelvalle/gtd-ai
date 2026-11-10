/** Report the actual rendered surface. The sandbox also measures the DOM;
 * interpolating these hints separately causes a full-height flash and rewind. */
export function observeHostHeight(report: (height: number) => void) {
  let sent: number | null = null;
  const observer = new ResizeObserver(() => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== sent) {
      sent = height;
      report(height);
    }
  });
  observer.observe(document.body);
  return () => observer.disconnect();
}
