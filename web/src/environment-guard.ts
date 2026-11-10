import { ApiError } from "./api.ts";

// A mounted UI belongs to its original environment, even after a demo lease ends.
export function environmentGuard() {
  let expected: string | undefined;
  let blocked = false;
  const listeners = new Set<() => void>();
  const failure = () => new ApiError(
    "This session has ended. Reopen GTD to continue in the current environment.",
    "environment_changed",
  );
  return {
    get expected() { return expected; },
    get blocked() { return blocked; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    assert() { if (blocked) throw failure(); },
    reject() {
      if (!blocked) { blocked = true; listeners.forEach(listener => listener()); }
      throw failure();
    },
    observe(value: unknown) {
      this.assert();
      if (value !== "production" && value !== "test" && value !== "demo" && value !== "staging") return;
      if (expected && expected !== value) this.reject();
      expected = value;
    },
  };
}
