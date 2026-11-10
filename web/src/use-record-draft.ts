import {
  useState,
  useSyncExternalStore,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useActions } from "./actions";

/** Editors are keyed by record by their callers. State survives view unmounts
 * and an in-flight acknowledgement can still rebase the session draft. */
export function useRecordDraft<T>(
  key: string,
  initial: () => T,
  dirty: (value: T) => boolean,
) {
  const { drafts } = useActions();
  const [serverValue] = useState(initial);
  const [cell] = useState(() => drafts.cell(key, () => serverValue, dirty));
  const value = useSyncExternalStore(
    cell.subscribe,
    cell.snapshot,
    () => serverValue,
  );
  return [value, cell.update] as const;
}

/** Group related form fields in one retained draft with a single dirty rule. */
export function useDraftFields<T extends object>(
  key: string,
  initial: () => T,
  dirty: (value: T) => boolean,
) {
  const [value, update] = useRecordDraft(key, initial, dirty);
  const setters = useRef(new Map<keyof T, unknown>());
  return function field<K extends keyof T>(
    name: K,
  ): readonly [T[K], Dispatch<SetStateAction<T[K]>>] {
    if (!setters.current.has(name))
      setters.current.set(name, (next: SetStateAction<T[K]>) =>
        update((previous) => ({
          ...previous,
          [name]:
            typeof next === "function"
              ? (next as (old: T[K]) => T[K])(previous[name])
              : next,
        })),
      );
    return [
      value[name],
      setters.current.get(name) as Dispatch<SetStateAction<T[K]>>,
    ];
  };
}

/** Mutable request identities must outlive the screen that submitted them. */
export function useDraftRef<T>(
  key: string,
  initial: T,
  dirty: (value: T) => boolean,
) {
  const [ref] = useRecordDraft(
    key,
    () => ({ current: initial }),
    (value) => dirty(value.current),
  );
  return ref;
}
