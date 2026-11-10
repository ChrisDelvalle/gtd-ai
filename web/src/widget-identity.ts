import { setDefaultZone } from "./calendar-context";

export type HostResult = { isError?: boolean; structuredContent?: unknown; _meta?: Record<string, unknown> };
class AccountChanged extends Error {
  code = "account_changed";
  uncertain = false;
  constructor() { super("The signed-in account changed. Reopen GTD to continue."); }
}
export function widgetIdentityGuard(required: boolean, onTimezone?: (zone: string) => void) {
  let expected: string | undefined, environment: string | undefined;
  let blocked = false;
  const listeners = new Set<() => void>();
  return {
    get expected() { return expected; },
    get blocked() { return blocked; },
    get ready() { return !required || !!expected; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reject(): never {
      if (!blocked) { blocked = true; listeners.forEach(listener => listener()); }
      throw new AccountChanged();
    },
    assert() { if (blocked || (required && !expected)) throw new AccountChanged(); },
    observe(result: HostResult) {
      if (blocked) throw new AccountChanged();
      const data = result.structuredContent as { code?: string; environment?: string } | undefined;
      if (data?.code === "account_changed") this.reject();
      const meta = result._meta, id = meta?.["gtd/accountId"];
      if (id === undefined && !required && !expected) return;
      const nextEnvironment = meta?.["gtd/environment"], zone = meta?.["gtd/timezone"];
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
          || !["staging", "production"].includes(String(nextEnvironment)) || typeof zone !== "string"
          || (data?.environment && data.environment !== nextEnvironment)) this.reject();
      if (expected && (id !== expected || nextEnvironment !== environment)) this.reject();
      try { new Intl.DateTimeFormat("en-US", { timeZone: zone as string }); } catch { this.reject(); }
      expected = id as string; environment = nextEnvironment as string;
      onTimezone?.(zone as string);
    },
    metadata(): Record<string, string> {
      this.assert();
      return expected ? { "gtd/expectedAccount": expected, "gtd/expectedEnvironment": environment! } : {};
    },
  };
}
export const widgetIdentity = widgetIdentityGuard(document.documentElement.dataset.accountRequired === "true", setDefaultZone);
