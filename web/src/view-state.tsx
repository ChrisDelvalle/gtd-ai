import {createContext,useContext,useMemo,useState,useSyncExternalStore,type ReactNode} from "react";
import {DraftCell} from "./draft-store";
import {ViewStore} from "./view-store";
const ViewContext=createContext<ReturnType<ViewStore["open"]>|null>(null);
export function ViewState({store,id,children}:{store:ViewStore;id:string;children:ReactNode}) {
  const [scene]=useState(()=>store.open(id));
  return <ViewContext.Provider value={scene}>{children}</ViewContext.Provider>;
}
/** The same record can appear in several groups. Its form draft is shared, but
 * opening an editor in one list must not open its other representations. */
export function ViewScope({id,children}:{id:string;children:ReactNode}) {
  const parent=useContext(ViewContext);
  const scoped=useMemo(()=>parent&&({...parent,cell<T>(key:string,initial:()=>T){return parent.cell(`${id}:${key}`,initial);}}),[parent,id]);
  return <ViewContext.Provider value={scoped}>{children}</ViewContext.Provider>;
}
export const useRestoredView=()=>!!useContext(ViewContext)?.restored;
export function useViewState<T>(key:string, initial:T|(()=>T)) {
  const scene=useContext(ViewContext);
  const [serverValue]=useState(initial);
  const [cell]=useState(()=>scene?.cell(key,()=>serverValue) || new DraftCell(()=>serverValue,()=>false,()=>{}));
  const value=useSyncExternalStore(cell.subscribe,cell.snapshot,()=>serverValue);
  return [value,cell.update] as const;
}
export function useViewRef<T>(key:string,initial:T) {
  const scene=useContext(ViewContext);
  const [value]=useState(()=>scene?.cell(key,()=>({current:initial})).snapshot() || {current:initial});
  return value;
}
