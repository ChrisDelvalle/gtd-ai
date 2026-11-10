/** A mounted website belongs to one immutable account/environment. Cookies may
 * change in another tab; they must never redirect this tab's pending work. */
import { setDefaultZone } from "./calendar-context.ts";
export type WebsiteAccount = {
  id: string; username: string; display_name: string | null;
  timezone: string; administrator: boolean;
};
export type SessionStatus = {
  authenticated: boolean; enabled: boolean; environment?: string;
  method?: "oidc"; account?: WebsiteAccount; csrf?: string; security_url?: string;
  authorization_url?: string;
};
class AccountChanged extends Error {
  code = "account_changed";
  uncertain = false;
  constructor() { super("The signed-in account changed. Reopen GTD to continue."); }
}
export function identityGuard(onTimezone?: (zone: string) => void) {
  let expected: string | undefined;
  let environment: string | undefined;
  let csrf: string | undefined;
  let timezone = "America/New_York";
  let blocked = false;
  const listeners = new Set<() => void>();
  return {
    get expected() { return expected; },
    get blocked() { return blocked; },
    get timezone() { return timezone; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    assert() { if (blocked) throw new AccountChanged(); },
    reject(): never {
      if (!blocked) { blocked = true; listeners.forEach(listener => listener()); }
      throw new AccountChanged();
    },
    observe(status: SessionStatus) {
      this.assert();
      if (!status.authenticated) return; // Retain the binding while signed out.
      if (status.method !== "oidc") { if (expected) this.reject(); return; }
      const account = status.account;
      if (!account) return this.reject();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.id) || !status.environment
          || !/^[0-9a-f]{64}$/.test(status.csrf || "")) this.reject();
      if (expected && (expected !== account.id || environment !== status.environment)) this.reject();
      try { new Intl.DateTimeFormat("en-US", { timeZone: account.timezone }); }
      catch { this.reject(); }
      expected = account.id; environment = status.environment; csrf = status.csrf; timezone = account.timezone;
      onTimezone?.(timezone);
    },
    headers(): Record<string, string> {
      this.assert();
      return expected ? { "X-GTD-Account": expected, "X-GTD-Environment": environment!, "X-GTD-CSRF": csrf! } : {};
    },
  };
}
export const websiteIdentity = identityGuard(setDefaultZone);
