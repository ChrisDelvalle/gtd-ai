import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiError, errorText, get, websitePost } from "./api";
import { IconButton } from "./task-row";
import { websiteIdentity } from "./website-identity";
import { reauthenticate } from "./website-reauthenticate";
import type {
  Command,
  Operation,
  Result,
  Selection,
} from "./website-users-model";

const labels = {
  invite: "Invite user",
  regenerate: "Regenerate invitation",
  reset_password: "Reset password",
  revoke: "Revoke invitation",
  disable: "Disable account",
};
const explanations = {
  invite:
    "The invitation expires in seven days. A password change is required at first sign-in.",
  regenerate:
    "The previous temporary password will stop working. This invitation will expire in seven days.",
  reset_password:
    "Current sessions will lose access. A password change is required at next sign-in.",
  revoke: "This invitation will stop working.",
  disable:
    "This account will lose access immediately. Its tasks will be preserved.",
};
function CopyValue({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="user-credential">
      <label>
        {label}
        <input readOnly value={value} autoComplete="off" spellCheck={false} />
      </label>
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setMessage("Copied");
          } catch {
            setMessage("Select and copy the value manually.");
          }
        }}
      >
        Copy
      </button>
      {message && <small role="status">{message}</small>}
    </div>
  );
}

export function OperationDialog({
  selection,
  close,
  changed,
  renewed,
}: {
  selection: Selection;
  close: () => void;
  changed: () => void;
  renewed: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState(""),
    [displayName, setDisplayName] = useState("");
  const request = useRef<{ request_id: string; command: Command } | null>(null);
  const [operation, setOperation] = useState(selection.operation || null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState(""),
    [needsAuth, setNeedsAuth] = useState(false);
  const [uncertain, setUncertain] = useState(!!selection.operation),
    [busy, setBusy] = useState(false);
  const working = useRef(false),
    visible = useRef(false);
  const name = selection.user?.username || username;
  useLayoutEffect(() => {
    const node = dialog.current!;
    visible.current = true;
    node.showModal();
    const unsubscribe = websiteIdentity.subscribe(() => {
      if (websiteIdentity.blocked) {
        node.close();
        setResult(null);
        close();
      }
    });
    // Retained routes suspend effects. Never retain the displayed credential
    // when leaving the page, changing identity, or closing this dialog.
    return () => {
      visible.current = false;
      node.close();
      unsubscribe();
      setResult(null);
      close();
    };
  }, []);
  async function run(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (!visible.current) return;
      setError(errorText(e));
      if (e instanceof ApiError && e.code === "reauthentication_required")
        setNeedsAuth(true);
      else if (
        e instanceof ApiError &&
        (e.uncertain || e.code === "administration_conflict")
      )
        setUncertain(true);
      else if (
        e instanceof ApiError &&
        e.code !== "authentication_required" &&
        !operation
      )
        request.current = null;
    } finally {
      working.current = false;
      if (visible.current) setBusy(false);
    }
  }
  function send() {
    if (!request.current && !operation)
      request.current = {
        request_id: crypto.randomUUID(),
        command:
          selection.action === "invite"
            ? {
                action: "invite",
                username: username.trim(),
                display_name: displayName.trim() || null,
              }
            : { action: selection.action, target_id: selection.user!.id },
      };
    return run(async () => {
      const value = operation
        ? await websitePost<Result>(
            `/api/users/operations/${operation.id}/resume`,
            {},
          )
        : await websitePost<Result>("/api/users/operations", request.current!);
      if (!visible.current) return;
      setResult(value);
      setOperation(value.operation);
      setUncertain(false);
      changed();
    });
  }
  function check() {
    return run(async () => {
      const path = operation
        ? `/api/users/operations/${operation.id}`
        : `/api/users/requests/${request.current!.request_id}`;
      const value = await get<{ operation: Operation | null }>(path);
      if (!visible.current) return;
      if (operation && !value.operation)
        throw new Error(
          "This operation is unavailable. Reload the Users page.",
        );
      setOperation(value.operation);
      setUncertain(false);
      changed();
      if (value.operation && value.operation.state !== "pending")
        setResult({
          operation: value.operation,
          temporary_password: null,
          sign_in_url: "",
        });
    });
  }
  const complete = result?.operation.state === "complete",
    cancelled = result?.operation.state === "cancelled";
  const credentials = result?.temporary_password;
  const recovering = !!request.current || !!operation;
  return (
    <dialog
      className="user-dialog"
      ref={dialog}
      aria-label={labels[selection.action]}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="user-dialog-heading">
        <h2>{labels[selection.action]}</h2>
        <IconButton label="Close" disabled={busy} onClick={close}>
          <X />
        </IconButton>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!uncertain && !needsAuth) void send();
        }}
      >
        {selection.action === "invite" && !selection.user && !complete ? (
          <div className="user-invite-fields">
            <label>
              Username
              <input
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                pattern="[a-z0-9][a-z0-9._-]{0,63}"
                maxLength={64}
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="off"
                disabled={busy || recovering}
              />
            </label>
            <label>
              <span>
                Display name <span className="muted">(optional)</span>
              </span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={100}
                autoComplete="off"
                disabled={busy || recovering}
              />
            </label>
          </div>
        ) : (
          <p className="user-operation-name">{name}</p>
        )}
        {credentials ? (
          <section
            aria-label="Invitation credentials"
            className="user-credentials"
          >
            <p>
              Copy these before closing. The temporary password is shown once.
            </p>
            <CopyValue label="Sign-in URL" value={result.sign_in_url} />
            <CopyValue label="Username" value={name} />
            <CopyValue label="Temporary password" value={credentials} />
          </section>
        ) : complete ? (
          <p role="status">
            {["invite", "regenerate", "reset_password"].includes(
              result.operation.kind,
            )
              ? "Completed. The temporary password cannot be shown again. Generate new credentials if you did not receive it."
              : "Completed."}
          </p>
        ) : cancelled ? (
          <p role="status">This operation was cancelled.</p>
        ) : (
          <p>
            {uncertain
              ? "Check the saved operation before continuing. No action will be retried automatically."
              : explanations[selection.action]}
          </p>
        )}
        {error && (
          <p className="user-error" role="alert">
            {error}
          </p>
        )}
        <div className="user-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            {result ? "Done" : "Cancel"}
          </button>
          {!result &&
            (needsAuth ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => {
                  // Open synchronously from this click; renewing sign-in does not send
                  // or resume the saved operation. The user presses Continue afterward.
                  void run(async () => {
                    await reauthenticate();
                    await renewed();
                    if (visible.current) setNeedsAuth(false);
                  });
                }}
              >
                {busy ? "Signing in…" : "Sign in again"}
              </button>
            ) : uncertain ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void check()}
              >
                {busy ? "Checking…" : "Check status"}
              </button>
            ) : (
              <button type="submit" className="primary" disabled={busy}>
                {busy
                  ? "Working…"
                  : recovering
                    ? "Continue"
                    : labels[selection.action]}
              </button>
            ))}
        </div>
      </form>
    </dialog>
  );
}
