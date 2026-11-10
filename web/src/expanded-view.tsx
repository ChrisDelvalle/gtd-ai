import { createContext, useContext } from "react";

/** Website controls already have room. Only the embedded surface negotiates
 * expansion; keeping this context separate avoids importing the host bridge. */
export const ExpandedView = createContext<(action: () => void) => void>(
  (action) => action(),
);
export const useExpandedView = () => useContext(ExpandedView);
