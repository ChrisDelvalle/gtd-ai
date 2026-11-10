import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiError, errorText, websitePost } from "./api";
import { IconButton } from "./task-row";
import { websiteIdentity } from "./website-identity";

export function TimezoneDialog({ current, refresh, close }: {
  current: string; refresh: () => Promise<string>; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const visible = useRef(false), working = useRef(false);
  const [zone, setZone] = useState(current), [expected, setExpected] = useState(current);
  const [busy, setBusy] = useState(false), [inspect, setInspect] = useState(false);
  const [error, setError] = useState("");
  const attempted = useRef<string | null>(null);
  const zones = useRef(Intl.supportedValuesOf("timeZone"));
  useLayoutEffect(() => {
    const node = dialog.current!;
    visible.current = true;
    node.showModal();
    const unsubscribe = websiteIdentity.subscribe(() => {
      if (websiteIdentity.blocked) { node.close(); close(); }
    });
    return () => { visible.current = false; unsubscribe(); node.close(); };
  }, []);
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (error) { if (visible.current) setError(errorText(error)); }
    finally { working.current = false; if (visible.current) setBusy(false); }
  }
  async function save() {
    const value = zone.trim();
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); }
    catch { throw new Error("Choose a valid IANA timezone."); }
    attempted.current = value;
    try {
      await websitePost("/api/account/timezone", { expected_timezone: expected, timezone: value });
      // Refresh authoritative identity before changing defaults. A lost response
      // is inspected explicitly, never retried on behalf of the user.
      setInspect(true);
      const saved = await refresh();
      if (!visible.current) return;
      if (saved === value) close();
      else { setExpected(saved); setInspect(false); throw new Error(`Timezone is now ${saved}. Review before saving.`); }
    } catch (error) {
      if (visible.current && error instanceof ApiError && (error.uncertain || error.code === "settings_conflict")) setInspect(true);
      throw error;
    }
  }
  return <dialog ref={dialog} className="user-dialog timezone-dialog" aria-labelledby="timezone-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="user-dialog-heading"><h2 id="timezone-title">Timezone</h2><IconButton label="Close timezone" disabled={busy} onClick={close}><X /></IconButton></div>
    <form onSubmit={event => { event.preventDefault(); void run(save); }}>
      <label>Timezone<input autoFocus required list="account-timezones" value={zone} onChange={event => setZone(event.target.value)} disabled={busy || inspect} autoComplete="off" spellCheck={false} maxLength={100} /></label>
      <datalist id="account-timezones">{zones.current.map(value => <option key={value} value={value} />)}</datalist>
      <p>Existing task times and repeating schedules stay unchanged.</p>
      {error && <p role="alert">{error}</p>}
      <div className="user-dialog-actions">
        <button type="button" disabled={busy} onClick={close}>Cancel</button>
        {inspect ? <button type="button" disabled={busy} onClick={() => void run(async () => {
          const saved = await refresh();
          if (!visible.current) return;
          if (saved === attempted.current) { close(); return; }
          setExpected(saved); setInspect(false);
          setError(`Timezone is now ${saved}. Review before saving.`);
        })}>{busy ? "Checking…" : "Check setting"}</button>
          : <button className="primary" type="submit" disabled={busy || !zone.trim() || zone.trim() === expected}>{busy ? "Saving…" : "Save"}</button>}
      </div>
    </form>
  </dialog>;
}
