import { createContext, useContext, type ReactNode } from "react";
import type { Api, Args, List, Projects, HomeSnapshot } from "./api";
import type { Page } from "./workspace";

export type Destination = { page: Page; scope?: string; input?: Args };
export type Launch = Destination & {
  initial?: List | null;
  projects?: Projects | null;
  home?: HomeSnapshot | null;
  error?: string;
  canRefresh?: boolean;
  errorIsWrite?: boolean;
  recheck?: boolean;
};
export const Environment = createContext<{
  api: Api;
  embedded: boolean;
  compact: boolean;
  revision?: number;
  refreshGeneration?: number;
}>({
  api: {
    call: async () => {
      throw new Error("GTD connection unavailable");
    },
  },
  embedded: false,
  compact: false,
});
export const AppNavigation = createContext<{
  current: Destination;
  go: (destination: Destination, focusSelector?: string) => void;
  back: (() => void) | null;
  updateUrl?: (destination: Destination) => void;
  menu: (capture: () => void) => ReactNode;
}>({ current: { page: "Home" }, go: () => {}, back: null, menu: () => null });
export const useEnvironment = () => useContext(Environment);
export const useAppNavigation = () => useContext(AppNavigation);

export { readTools, coalescedApi } from "./read-coordinator";
