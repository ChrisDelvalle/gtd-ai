import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { websiteIdentity, type SessionStatus } from "./website-identity";

export async function authRequest(path: string, body?: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-GTD-Request": "1", ...websiteIdentity.headers() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  const value = await response.json();
  if (value.code === "account_changed") websiteIdentity.reject();
  if (!response.ok) throw new Error(value.message || "Could not sign in. Please try again.");
  if (path === "session") websiteIdentity.observe(value);
  return value as SessionStatus;
}

export function Login({ resume, onSuccess, test, oidc = false }: { test: boolean | "demo"; resume: boolean; onSuccess: () => Promise<void>; oidc?: boolean }) {
  const [username, setUsername] = useState("owner"), [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true), [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(() =>
    new URLSearchParams(location.search).has("auth_error") ? "Sign-in was not completed. Please try again." : "");
  const dialog = useRef<HTMLDialogElement>(null);
  const popup = useRef<Window | null>(null);
  useEffect(() => {
    const current = new URL(location.href);
    if (current.searchParams.has("auth_error")) {
      current.searchParams.delete("auth_error");
      history.replaceState(history.state, "", current.pathname + current.search);
    }
  }, []);
  useEffect(() => {
    if (!oidc || !resume) return;
    let disposed = false, checking = false;
    let checkedClosed: Window | null = null;
    // Resume in a separate window so unsaved in-memory drafts remain intact.
    // Only a fresh session read establishes identity; messages carry no tokens.
    const check = async () => {
      if (!popup.current || checking) return;
      checking = true;
      try {
        const status = await authRequest("session");
        if (status.authenticated && !disposed) { popup.current?.close(); popup.current = null; await onSuccess(); }
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : "Could not sign in."); }
      finally { checking = false; }
    };
    const message = (event: MessageEvent) => { if (event.origin === location.origin && event.source === popup.current && event.data === "gtd:sign-in-complete") void check(); };
    window.addEventListener("message", message);
    window.addEventListener("focus", check);
    const timer = window.setInterval(() => { if (popup.current?.closed && checkedClosed !== popup.current) { checkedClosed = popup.current; void check(); setBusy(false); } }, 1000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("message", message); window.removeEventListener("focus", check); };
  }, [oidc, resume, onSuccess]);
  useEffect(() => {
    if (resume) dialog.current?.showModal();
    return () => dialog.current?.close();
  }, [resume]);
  const form = <form className="login-form" aria-label="Sign in" onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (oidc) {
        // Open synchronously for Safari popup rules, then navigate after the
        // same-origin login request has installed its HttpOnly binding cookie.
        if (resume) {
          popup.current = window.open("about:blank", "gtd-sign-in", "popup,width=480,height=720");
          if (!popup.current) throw new Error("Allow the sign-in window to continue. Your draft is still here.");
        }
        const result = await authRequest("login", { remember, return_to: resume ? "/?gtd_sign_in=complete" : location.pathname + location.search });
        if (!result.authorization_url || !result.authorization_url.startsWith("https://")) throw new Error("Could not start sign-in.");
        if (resume && popup.current) popup.current.location.href = result.authorization_url;
        else window.location.assign(result.authorization_url);
        return;
      }
      await authRequest("login", { username, password, remember });
      setPassword("");
      await onSuccess();
    } catch (error) {
      popup.current?.close(); popup.current = null;
      setError(error instanceof Error && error.name !== "TimeoutError" && error.name !== "TypeError" ? error.message : "Could not connect. Please try again.");
    } finally { if (!popup.current) setBusy(false); }
  }}>
    {test && <div className="login-environment" role="status">{test === "demo" ? "Demo Mode" : "Test mode · Disposable data"}</div>}
    <h1 id="login-title">GTD</h1>
    {!oidc && <div className="login-field login-username">
      <label htmlFor="login-username">Username</label>
      <input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={128} value={username} onChange={e => setUsername(e.target.value)} />
    </div>}
    {!oidc && <div className="login-field login-password">
      <label className="sr-only" htmlFor="login-password">Password</label>
      <input id="login-password" name="password" placeholder="Password" type={show ? "text" : "password"} autoComplete="current-password" required maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} />
      <button type="button" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow(!show)}>{show ? <EyeOff /> : <Eye />}</button>
    </div>}
    <label className="login-remember" title="Stay signed in for 30 days"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /><span>Stay signed in</span></label>
    {error && <p className="login-error" id="login-error" role="alert">{error}</p>}
    <button className="primary login-submit" type="submit" disabled={busy} aria-busy={busy}><span>{busy ? "Signing in…" : "Sign in"}</span>{busy ? <LoaderCircle className="login-spinner" /> : null}</button>
  </form>;
  return resume ? <dialog className="login-dialog" ref={dialog} aria-label="Sign in to GTD" onCancel={e => e.preventDefault()}>{form}</dialog> : <main className="login-page">{form}</main>;
}
