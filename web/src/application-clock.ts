// Logical task time is separate from elapsed time used by animations and caches.
let fixed: number | undefined;
export const applicationNow = () => fixed ?? Date.now();
export function setApplicationTime(instant: string) {
  const value = Date.parse(instant);
  if (!Number.isFinite(value)) throw new Error("Invalid application clock");
  fixed = value;
}
