import { Component, useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

const noSubscription = () => () => {};
const clientRender = () => false;
const serverOrHydrating = () => true;

class ModuleRecovery extends Component<{ retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="compact-empty" role="alert">
      <p>Could not load this view.</p>
      <button onClick={() => { this.props.retry(); this.setState({ failed: false }); }}>Try again</button>
    </div> : this.props.children;
  }
}

// Cache code only. The stable wrapper never replaces a mounted editor when its
// parent updates. A failed chunk can be retried without reloading session drafts.
export function deferred<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
) {
  let ready: ComponentType<P> | undefined;
  let pending: Promise<void> | undefined;
  let failure: unknown;
  let revision = 0;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const snapshot = () => revision;
  const publish = () => { revision++; for (const listener of listeners) listener(); };
  const preload = () => pending ??= Promise.resolve().then(load).then(
    module => { ready = module.default; publish(); },
    error => { failure = error; publish(); throw error; },
  );
  const retry = () => { if (!ready) { pending = undefined; failure = undefined; } };
  function Resolved(props: P) {
    const hydrating = useSyncExternalStore(noSubscription, clientRender, serverOrHydrating);
    // React checks again when subscribing, including a preload that resolves
    // between render and effects. That race must never leave a loading screen.
    useSyncExternalStore(subscribe, snapshot, snapshot);
    useEffect(() => { void preload().catch(() => {}); }, []);
    if (failure) throw failure;
    // Hydration must preserve the server's resolved HTML until its code arrives.
    // Suspense can hydrate that boundary selectively without replacing it with
    // Loading. Later client navigation still uses the immediate reveal below.
    if (!ready && hydrating) throw preload();
    // Ordinary module readiness must not inherit Suspense's fallback reveal
    // delay. Keep one component type alive and update as soon as code arrives.
    if (!ready) return <div className="compact-empty" role="status">Loading…</div>;
    const Screen = ready;
    return <Screen {...props} />;
  }
  return {
    preload,
    Component: (props: P) => <ModuleRecovery retry={retry}><Resolved {...props} /></ModuleRecovery>,
  };
}
