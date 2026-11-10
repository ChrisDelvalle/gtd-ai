import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  CircleHelp,
  House,
  PanelLeftClose,
  Search,
  Settings,
  ScrollText,
  HeartPulse,
} from "lucide-react";
import { IconButton } from "./task-row";
import { Menu } from "./floating-panel";
import type { Destination } from "./app-context";
import { navigationGroups, isDestination } from "./navigation";

export function SidebarContents({
  current,
  choose,
  close,
  account,
  admin,
}: {
  current: Destination;
  choose: (route: Destination) => void;
  close?: () => void;
  account?: ReactNode;
  admin: boolean;
}) {
  const [more, setMore] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = nav.current!;
    const update = () =>
      setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(content.current!);
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  const go = choose;
  return (
    <>
      <div className="sidebar-brand">
        <span className="gtd-wordmark">GTD</span>
        <div className="sidebar-brand-actions">
          {close && <IconButton
            className="icon-button sidebar-close"
            label="Close navigation"
            onClick={close}
          >
            <PanelLeftClose />
          </IconButton>}
          <IconButton
            label="Search tasks"
            onClick={() =>
              go({
                page: "Tasks",
                scope: "all",
                input: { view: "all", archived: false, open_search: true },
              })
            }
          >
            <Search />
          </IconButton>
        </div>
      </div>
      <div className="sidebar-scroll" data-more={more || undefined}>
        <nav ref={nav} aria-label="Task views">
          <div ref={content} className="sidebar-nav-content">
            <button
              className={current.page === "Home" ? "active" : ""}
              aria-current={current.page === "Home" ? "page" : undefined}
              onClick={() => go({ page: "Home" })}
            >
              <House />
              Home
            </button>
            {navigationGroups.map((group, i) => (
              <div className="sidebar-group" key={i}>
                {group.map(({ label, icon: Icon, route }) => (
                  <button
                    key={label}
                    className={isDestination(current, route) ? "active" : ""}
                    aria-current={
                      isDestination(current, route) ? "page" : undefined
                    }
                    onClick={() => go(route)}
                  >
                    <Icon />
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
      </div>
      <SidebarTools current={current} choose={choose} account={account} admin={admin}/>
    </>
  );
}

/** Shared interactive footer; Astro can keep its navigation links static. */
export function SidebarTools({current, choose, account, admin}: {
  current: Destination; choose: (route: Destination) => void; account?: ReactNode; admin: boolean;
}) {
  const [settings,setSettings] = useState(false);
  const anchor=useRef<HTMLButtonElement>(null);
  const go=(route:Destination)=>{setSettings(false);choose(route);};
  return (
      <div className="nav-bottom">
        <IconButton
          label="Help"
          aria-current={current.page === "Help" ? "page" : undefined}
          onClick={() => go({ page: "Help" })}
        >
          <CircleHelp />
        </IconButton>
        <IconButton
          ref={anchor}
          label="Settings"
          aria-haspopup="menu"
          aria-expanded={settings}
          data-active={
            ["Activity", "Logs", "Health", "Users"].includes(current.page) || undefined
          }
          onClick={() => setSettings(!settings)}
        >
          <Settings />
        </IconButton>
        {settings && (
          <Menu
            label="Settings"
            className="sidebar-settings"
            anchor={anchor}
            close={() => setSettings(false)}
          >
            <button role="menuitem" onClick={() => go({ page: "Activity" })}>
              <Activity />
              Activity
            </button>
            {admin && (
              <>
                <button role="menuitem" onClick={() => go({ page: "Logs" })}>
                  <ScrollText />
                  Logs
                </button>
                <button role="menuitem" onClick={() => go({ page: "Health" })}>
                  <HeartPulse />
                  Service health
                </button>
              </>
            )}
            {account && (
              <>
                <hr />
                {account}
              </>
            )}
          </Menu>
        )}
      </div>
  );
}
