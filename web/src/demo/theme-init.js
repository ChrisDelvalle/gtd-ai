// This small, local script runs before the stylesheet to avoid a theme flash.
document.documentElement.dataset.theme = matchMedia(
  "(prefers-color-scheme: dark)",
).matches
  ? "dark"
  : "light";
document.documentElement.style.colorScheme =
  document.documentElement.dataset.theme;
