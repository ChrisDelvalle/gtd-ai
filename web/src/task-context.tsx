import { Suspense, useState, useRef, type ReactNode } from "react";
import { deferred } from "./deferred-component";
import { Link2, MapPin, Plus, X, AlertCircle } from "lucide-react";
import { type Api, type Task, type TaskLink } from "./api";

import { Menu } from "./floating-panel";

// Shared by structured fields and note links. Never allow executable URLs.
export function safeUrl(value: string): string | null {
  try {
    if (!/^https?:\/\//.test(value) || /[\s\u0000-\u001f\u007f]/.test(value))
      return null;
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function ExternalLink({
  url,
  api,
  children,
  className,
}: {
  url: string;
  api: Api;
  children: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const href = safeUrl(url);
  if (!href) return <span>{children}</span>;
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        className={className}
        onClick={
          api.openLink
            ? (e) => {
                e.preventDefault();
                setFailed(false);
                void api.openLink!(href).catch(() => setFailed(true));
              }
            : undefined
        }
      >
        {children}
      </a>
      {failed && (
        <span
          role="status"
          className="link-error"
          title="Could not open link. Try again or copy its address."
        >
          <AlertCircle size={14} />
          <span className="sr-only">
            Could not open link. Try again or copy its address.
          </span>
        </span>
      )}
    </>
  );
}

// A small link tokenizer, not a Markdown/HTML renderer. Surrounding prose stays literal.
export function NoteText({
  text,
  api,
  markdownLinks = true,
}: {
  text: string;
  api: Api;
  markdownLinks?: boolean;
}) {
  const parts: ReactNode[] = [];
  const pattern = markdownLinks
    ? /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^()\s<>]*\))+)\)|https?:\/\/[^\s<>]+/g
    : /https?:\/\/[^\s<>]+/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index!;
    parts.push(text.slice(start, at));
    let url = match[2] || match[0];
    let trailing = "";
    if (!match[2]) {
      while (
        /[.,!?;:'"]$/.test(url) ||
        (url.endsWith(")") &&
          (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) ||
        /[\]}]$/.test(url)
      ) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
    }
    parts.push(
      <ExternalLink key={at} url={url} api={api}>
        {match[1] || url}
      </ExternalLink>,
      trailing,
    );
    start = at + match[0].length;
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

// Keep the Markdown parser out of collapsed-task startup bundles. A disclosure
// starts loading this code alongside its data; SSR preloads visible descriptions.
const description = deferred<{text:string;api:Api}>(()=>import("./description"));
const DescriptionBody = description.Component;
export const preloadDescription = description.preload;
export function Description(props:{text:string;api:Api}) {
  return <Suspense fallback={<div className="compact-empty" role="status">Loading…</div>}><DescriptionBody {...props}/></Suspense>;
}

export function TaskContext({ task, api }: { task: Task; api: Api }) {
  const links = task.links || [];
  const location = task.location;
  return (
    <div className="task-context-content">
      {task.brief && <p className="task-reading-notes task-brief">{task.brief}</p>}
      {task.brief && task.notes && <hr className="task-brief-divider" />}
      {task.notes && <Description text={task.notes} api={api} />}
      {(links.length > 0 || location) && (
        <div className="task-resources">
          {links.map((link, i) => (
            <div className="task-resource" key={`${i}:${link.url}`}>
              <Link2 aria-hidden="true" />
              <ExternalLink api={api} url={link.url}>
                {link.label?.trim() ||
                  (safeUrl(link.url) ? new URL(link.url).hostname : link.url)}
              </ExternalLink>
            </div>
          ))}
          {location && (
            <div className="task-resource">
              <MapPin aria-hidden="true" />
              <ExternalLink
                api={api}
                url={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`}
              >
                {location}
              </ExternalLink>
            </div>
          )}
        </div>
      )}
      {!task.brief && !task.notes &&
        !links.length &&
        !location &&
        !task.importance &&
        !task.deadline_time &&
        !task.start_by &&
        !task.planned_start &&
        !task.started &&
        !task.project_id &&
        !task.review_date &&
        !task.work_sessions?.length &&
        !task.completion_result && (
          <p className="muted">No additional details.</p>
        )}
    </div>
  );
}

export type ContextDraft = { links: TaskLink[]; location: string };
export function ContextFields({
  value,
  onChange,
  allowLocation = true,
  addLabel = "Add detail",
}: {
  allowLocation?: boolean;
  addLabel?: string;
  value: ContextDraft;
  onChange: (value: ContextDraft) => void;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [addingLocation, setAddingLocation] = useState(false);
  return (
    <div className="context-fields">
      {value.links.map((link, i) => (
        <div className="context-link-editor" key={i}>
          <Link2 aria-hidden="true" />
          <div>
            <label>
              <span className="sr-only">Link {i + 1} label</span>
              <input
                aria-label={`Link ${i + 1} label`}
                maxLength={120}
                placeholder="Label (optional)"
                value={link.label || ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    links: value.links.map((l, n) =>
                      n === i ? { ...l, label: e.target.value } : l,
                    ),
                  })
                }
              />
            </label>
            <label>
              <span className="sr-only">Link {i + 1} URL</span>
              <input
                aria-label={`Link ${i + 1} URL`}
                type="url"
                required
                maxLength={2048}
                placeholder="https://…"
                value={link.url}
                ref={(input) => {
                  input?.setCustomValidity(
                    !link.url || safeUrl(link.url)
                      ? ""
                      : "Enter an HTTP or HTTPS URL without login credentials.",
                  );
                }}
                onChange={(e) => {
                  e.target.setCustomValidity(
                    safeUrl(e.target.value)
                      ? ""
                      : "Enter an HTTP or HTTPS URL without login credentials.",
                  );
                  onChange({
                    ...value,
                    links: value.links.map((l, n) =>
                      n === i ? { ...l, url: e.target.value } : l,
                    ),
                  });
                }}
              />
            </label>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove link ${i + 1}`}
            onClick={() =>
              onChange({
                ...value,
                links: value.links.filter((_, n) => n !== i),
              })
            }
          >
            <X />
          </button>
        </div>
      ))}
      {(value.location || addingLocation) && (
        <div className="context-location-editor">
          <MapPin aria-hidden="true" />
          <label>
            <span className="sr-only">Location</span>
            <input
              aria-label="Location"
              maxLength={1000}
              placeholder="Place or address"
              value={value.location}
              onChange={(e) => onChange({ ...value, location: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label="Remove location"
            onClick={() => {
              onChange({ ...value, location: "" });
              setAddingLocation(false);
            }}
          >
            <X />
          </button>
        </div>
      )}
      <button
        type="button"
        className="text-action"
        ref={anchor}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <Plus />
        {addLabel}
      </button>
      {menu && (
        <Menu anchor={anchor} close={() => setMenu(false)} label="Add detail">
          <button
            type="button"
            role="menuitem"
            disabled={value.links.length >= 20}
            onClick={() => {
              onChange({ ...value, links: [...value.links, { url: "" }] });
              setMenu(false);
              anchor.current?.focus({ preventScroll: true });
            }}
          >
            <Link2 />
            Link
          </button>
          {allowLocation && (
            <button
              type="button"
              role="menuitem"
              disabled={!!value.location || addingLocation}
              onClick={() => {
                setAddingLocation(true);
                setMenu(false);
                anchor.current?.focus({ preventScroll: true });
              }}
            >
              <MapPin />
              Location
            </button>
          )}
        </Menu>
      )}
    </div>
  );
}
