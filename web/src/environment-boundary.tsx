import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { environmentGuard } from "./environment-guard";

export function EnvironmentBoundary({guard, children, reopen, conceal = false}: {
  guard: Pick<ReturnType<typeof environmentGuard>, "subscribe" | "blocked">; children: ReactNode; reopen?: () => Promise<void>;
  conceal?: boolean;
}) {
  const blocked = useSyncExternalStore(guard.subscribe, () => guard.blocked, () => false);
  const [reopening, setReopening] = useState(false);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  async function startFresh() {
    if (!reopen || reopening || requested) return;
    setReopening(true);
    try { await reopen(); setRequested(true); }
    catch { setFailed(true); }
    finally { setReopening(false); }
  }
  return <>
    {blocked && <div className="environment-ended" role="alert">
      <span>This session has ended.</span>
      {reopen && !failed ? <button disabled={reopening || requested} onClick={() => void startFresh()}>
        {requested ? "Requested in chat" : reopening ? "Opening…" : "Reopen"}
      </button> : <span>Reopen GTD to continue.</span>}
      {failed && <small>Ask ChatGPT to open GTD again.</small>}
    </div>}
    <div hidden={blocked && conceal} inert={blocked || undefined} className={blocked ? "environment-locked" : undefined}>{children}</div>
  </>;
}
