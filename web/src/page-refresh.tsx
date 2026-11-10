import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Api, Args } from "./api";
import { readTools } from "./app-context";

type TrackRead = <T>(read: () => Promise<T>) => Promise<T>;
export const PageReads = createContext<{
  track: TrackRead;
  refreshing: boolean;
  refreshRevision: number;
}>({ track: (read) => read(), refreshing: false, refreshRevision: 0 });
export const usePageReads = () => useContext(PageReads);

/** Count reads for this workspace, including nested lists and cursor pages.
 * Completion belongs to the whole visible page, not whichever list is first.
 * The API remains stable so starting/stopping the spinner cannot refetch data.
 */
export function usePageRefresh(
  source: Api,
  revision: number,
  refresh: () => void,
) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const pending = useRef(0);
  const awaiting = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef({ revision, refresh });
  latest.current = { revision, refresh };
  const cancelFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const settle = useCallback(() => {
    cancelFrame();
    const requested = awaiting.current;
    if (
      requested === null ||
      latest.current.revision < requested ||
      pending.current
    )
      return;
    // Allow the refreshed data to commit and mount dependent readers (for
    // example, a newly populated project group). Each new read cancels this
    // idle check; this is not a fixed loading timeout.
    let frames = 2;
    const check = () => {
      frame.current = null;
      if (awaiting.current !== requested || pending.current) return;
      if (--frames) frame.current = requestAnimationFrame(check);
      else {
        awaiting.current = null;
        setRefreshing(false);
      }
    };
    frame.current = requestAnimationFrame(check);
  }, [cancelFrame]);
  const track = useCallback<TrackRead>(
    async (read) => {
      pending.current++;
      cancelFrame();
      try {
        return await read();
      } finally {
        pending.current--;
        settle();
      }
    },
    [cancelFrame, settle],
  );
  const api = useMemo<Api>(
    () => ({
      taskPreparation: source.taskPreparation,
      invalidateReads: source.invalidateReads?.bind(source),
      identityScope: source.identityScope?.bind(source),
      openLink: source.openLink?.bind(source),
      home: source.home ? (date) => track(() => source.home!(date)) : undefined,
      call<T>(name: string, args: Args): Promise<T> {
        return readTools.has(name)
          ? track(() => source.call<T>(name, args))
          : source.call<T>(name, args);
      },
    }),
    [source, track],
  );
  const requestRefresh = useCallback(() => {
    if (awaiting.current !== null) return;
    awaiting.current = latest.current.revision + 1;
    setRefreshRevision(awaiting.current);
    setRefreshing(true);
    latest.current.refresh();
  }, []);
  useEffect(settle, [revision, settle]);
  useEffect(
    () => () => {
      // Cached routes suspend effects when hidden. Do not restore a stale
      // gesture/spinner when the user later returns to this page.
      awaiting.current = null;
      cancelFrame();
      setRefreshing(false);
    },
    [cancelFrame],
  );
  return { api, track, refreshing, refreshRevision, requestRefresh };
}
