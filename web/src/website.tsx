import "./input-modality";
import { EnvironmentBoundary } from "./environment-boundary";
import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, LogOut, Shield, Users as UsersIcon } from "lucide-react";
import { Application } from "./application";
import { websiteApi, websiteEnvironment, get, setWebsiteLocked } from "./api";
import { Logs, Health } from "./website-admin";
import { Login, authRequest } from "./website-login";
import { websiteIdentity, type SessionStatus } from "./website-identity";
import { useAppNavigation } from "./app-context";
const Users = lazy(() => import("./website-users").then(module => ({ default: module.Users })));
const TimezoneDialog = lazy(() => import("./website-timezone").then(module => ({ default: module.TimezoneDialog })));
function AccountMenu({ session, timezone }: { session: SessionStatus | null; timezone: () => void }) {
  const navigation = useAppNavigation();
  if (!session?.account) return null;
  return <>
    <span className="sidebar-account-name" title={session.account.username}>{session.account.display_name || session.account.username}</span>
    <button role="menuitem" onClick={timezone}><Globe />Timezone</button>
    {session.account.administrator && <button role="menuitem" onClick={() => navigation.go({ page: "Users" })}><UsersIcon />Users</button>}
    {session.security_url && <button role="menuitem" onClick={() => window.open(session.security_url, "_blank", "noopener,noreferrer")}><Shield />Account security</button>}
  </>;
}
function Website() {
  const [test, setTest] = useState<boolean | "demo">(false);
  const [ready, setReady] = useState(false), [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false), [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [timezoneOpen, setTimezoneOpen] = useState(false);
  useEffect(() => {
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme = preference.matches ? "dark" : "light";
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (meta) meta.content = preference.matches ? "#0e0e0e" : "#ffffff";
    };
    update(); preference.addEventListener("change", update);
    const required = () => setAuthenticated(false);
    window.addEventListener("gtd:authentication-required", required);
    void initialize();
    return () => { preference.removeEventListener("change", update); window.removeEventListener("gtd:authentication-required", required); };
  }, []);
  async function load(environment?: string) {
    try {
      const value = environment ? { environment } : await get<{ environment: string }>("/api/health");
      websiteEnvironment.observe(value.environment);
      setTest(value.environment === "demo" ? "demo" : value.environment === "test" || value.environment === "staging");
      setReady(true); setError("");
    } catch { setError("Could not connect to GTD. Please try again."); }
  }
  async function initialize() {
    setError("");
    try {
      const status = await authRequest("session");
      setSession(status);
      setTest(status.environment === "demo" ? "demo" : status.environment === "test" || status.environment === "staging");
      setEnabled(status.enabled); setAuthenticated(status.authenticated); setWebsiteLocked(!status.authenticated);
      if (status.authenticated) await load(status.environment);
    } catch { setError("Could not connect to GTD. Please try again."); }
  }
  async function signedIn() {
    const status = await authRequest("session");
    setSession(status);
    setWebsiteLocked(false); setAuthenticated(true); setEnabled(true); setError("");
    if (!ready) {
      await load(status.environment);
    }
    // Refresh reads only; rejected or uncertain writes remain explicit retries.
    window.dispatchEvent(new Event("gtd:changed"));
  }
  async function refreshAccount() {
    const status = await authRequest("session");
    if (!status.authenticated || !status.account) {
      setWebsiteLocked(true); setAuthenticated(false);
      throw new Error("Sign in to continue. Your draft is still here.");
    }
    setSession(status);
    window.dispatchEvent(new Event("gtd:changed"));
    return status.account.timezone;
  }
  const account = enabled ? <><AccountMenu session={session} timezone={() => setTimezoneOpen(true)} /><button role="menuitem" disabled={signingOut} onClick={async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authRequest("logout", {});
      setWebsiteLocked(true); setAuthenticated(false); setError("");
    } catch { setError("Could not sign out. Please try again."); }
    finally { setSigningOut(false); }
  }}><LogOut />{signingOut ? "Signing out…" : "Sign out"}</button></> : undefined;
  return <EnvironmentBoundary guard={websiteIdentity} conceal reopen={async () => { window.location.reload(); }}>
    {ready && <EnvironmentBoundary guard={websiteEnvironment} reopen={async () => { window.location.reload(); }}><Application
      api={websiteApi} test={test} account={account}
      admin={session?.account && !session.account.administrator ? undefined :
        (page, revision, onSelect) => page === "Users"
          ? session?.account?.administrator ? <Suspense fallback={<p role="status">Loading…</p>}><Users revision={revision} renewed={signedIn} /></Suspense> : <p role="alert">Administrator access is required.</p>
          : page === "Logs" ? <Logs externalRevision={revision} onSelect={onSelect} /> : <Health revision={revision} />}
    /></EnvironmentBoundary>}
    {timezoneOpen && session?.account && <Suspense fallback={null}><TimezoneDialog current={session.account.timezone} refresh={refreshAccount} close={() => setTimezoneOpen(false)} /></Suspense>}
    {authenticated === false && <Login test={test} resume={ready} onSuccess={signedIn} oidc={session?.method === "oidc"} />}
    {error && authenticated !== false && <div className={ready ? "login-connection-banner" : "login-page"}><div className="login-card" role="alert"><p>{error}</p><button onClick={() => void initialize()}>Try again</button></div></div>}
    {!ready && authenticated !== false && !error && <main className="login-page"><p role="status">Connecting…</p></main>}
  </EnvironmentBoundary>;
}
// The notification carries no account data or credentials. The original page
// always reads the session again before accepting the resumed identity.
if (new URLSearchParams(location.search).get("gtd_sign_in") === "complete" && window.opener) {
  window.opener.postMessage("gtd:sign-in-complete", location.origin);
  window.close();
}
createRoot(document.getElementById("root")!).render(<Website />);
