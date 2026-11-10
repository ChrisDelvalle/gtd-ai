import { useEffect, useLayoutEffect, useState } from "react";

export type DemoTheme = "light" | "dark";
export const systemTheme = (): DemoTheme =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

// Follow system changes until the visitor explicitly chooses a theme. Like
// other demo preferences, that override lasts until reload/reset.
export function useDemoTheme() {
  const [system, setSystem] = useState(systemTheme);
  const [override, setOverride] = useState<DemoTheme | null>(null);
  const theme = override ?? system;
  useEffect(() => {
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystem(preference.matches ? "dark" : "light");
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  return [
    theme,
    () => setOverride(theme === "light" ? "dark" : "light"),
  ] as const;
}
