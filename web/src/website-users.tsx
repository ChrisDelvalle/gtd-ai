import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { errorText, get } from "./api";
import { Menu } from "./floating-panel";
import { IconButton } from "./task-row";
import { usePageReads } from "./page-refresh";
import { websiteIdentity } from "./website-identity";
import { OperationDialog } from "./website-user-operation";
import type {
  Command,
  Operation,
  Selection,
  User,
} from "./website-users-model";

function stateLabel(user: User) {
  return user.state === "active"
    ? user.enabled
      ? "Active"
      : "Disabled"
    : user.state[0].toUpperCase() + user.state.slice(1);
}

function UserActions({
  user,
  choose,
}: {
  user: User;
  choose: (selection: Selection) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (
    user.id === websiteIdentity.expected ||
    (!user.operation &&
      (user.state === "revoked" || (user.state === "active" && !user.enabled)))
  )
    return null;
  const select = (action: Command["action"], operation?: Operation) => {
    setOpen(false);
    choose({ action, user, operation });
  };
  return (
    <>
      <IconButton
        ref={anchor}
        label={`Manage ${user.username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal />
      </IconButton>
      {open && (
        <Menu
          label={`Manage ${user.username}`}
          anchor={anchor}
          close={() => setOpen(false)}
        >
          {user.operation && (
            <button
              role="menuitem"
              onClick={() => select(user.operation!.kind, user.operation!)}
            >
              Continue pending operation
            </button>
          )}
          {(user.state === "pending" || user.state === "expired") && (
            <button role="menuitem" onClick={() => select("regenerate")}>
              Regenerate invitation
            </button>
          )}
          {(user.state === "pending" || user.state === "expired") && (
            <button role="menuitem" onClick={() => select("revoke")}>
              Revoke invitation
            </button>
          )}
          {user.state === "active" && (
            <>
              {!user.operation && user.enabled && (
                <button
                  role="menuitem"
                  onClick={() => select("reset_password")}
                >
                  Reset password
                </button>
              )}
              {(user.enabled || user.operation?.kind === "reset_password") && (
                <button role="menuitem" onClick={() => select("disable")}>
                  Disable account
                </button>
              )}
            </>
          )}
        </Menu>
      )}
    </>
  );
}

export function Users({
  revision,
  renewed,
}: {
  revision: number;
  renewed: () => Promise<void>;
}) {
  const { track, refreshRevision } = usePageReads();
  const [users, setUsers] = useState<User[]>([]),
    [after, setAfter] = useState<string | null>(null);
  const [more, setMore] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null),
    [reload, setReload] = useState(0);
  const generation = useRef(0),
    loadingMore = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    void track(() => get<User[]>("/api/users?limit=50"))
      .then((rows) => {
        if (generation.current !== current) return;
        setUsers(rows);
        setMore(rows.length === 50);
        setAfter(rows.at(-1)?.id || null);
      })
      .catch((e) => {
        if (generation.current === current) setError(errorText(e));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [revision, refreshRevision, reload, track]);
  async function loadMore() {
    if (loadingMore.current || !after) return;
    loadingMore.current = true;
    setLoading(true);
    const current = generation.current;
    try {
      const rows = await track(() =>
        get<User[]>(`/api/users?limit=50&after=${after}`),
      );
      if (generation.current !== current) return;
      setUsers((previous) => [
        ...previous,
        ...rows.filter((row) => !previous.some((user) => user.id === row.id)),
      ]);
      setMore(rows.length === 50);
      setAfter(rows.at(-1)?.id || null);
      setError("");
    } catch (e) {
      if (generation.current === current) setError(errorText(e));
    } finally {
      loadingMore.current = false;
      if (generation.current === current) setLoading(false);
    }
  }
  return (
    <section className="users-page" aria-label="Users">
      <div className="users-toolbar">
        <button onClick={() => setSelection({ action: "invite" })}>
          <Plus />
          Invite user
        </button>
      </div>
      {error && (
        <div role="alert" className="banner error">
          {error}
          <button onClick={() => setReload((n) => n + 1)}>Try again</button>
        </div>
      )}
      <ul className="users-list">
        {users.map((user) => (
          <li key={user.id}>
            <div className="user-name">
              <strong>{user.display_name || user.username}</strong>
              {user.display_name && <span>{user.username}</span>}
              {user.expires_at &&
                ["pending", "expired"].includes(user.state) && (
                  <small>
                    {user.state === "expired" ? "Expired" : "Expires"}{" "}
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeZone: websiteIdentity.timezone,
                    }).format(new Date(user.expires_at))}
                  </small>
                )}
            </div>
            <div className="user-status">
              <span>{stateLabel(user)}</span>
              {user.administrator && <small>Admin</small>}
              {user.operation && <small>Operation pending</small>}
            </div>
            <UserActions user={user} choose={setSelection} />
          </li>
        ))}
      </ul>
      {loading && <p role="status">Loading…</p>}
      {!loading && !error && !users.length && (
        <p className="empty">No users.</p>
      )}
      {more && (
        <button disabled={loading} onClick={() => void loadMore()}>
          Load more
        </button>
      )}
      {selection && (
        <OperationDialog
          selection={selection}
          close={() => setSelection(null)}
          changed={() => setReload((n) => n + 1)}
          renewed={renewed}
        />
      )}
    </section>
  );
}
