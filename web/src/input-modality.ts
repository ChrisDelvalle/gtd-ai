// Native selects/date fields can match :focus-visible after a mouse click.
// Preserve their real focus; only suppress the keyboard ring for pointer input.
const root = document.documentElement;
document.addEventListener("pointerdown", () => {
  root.dataset.inputModality = "pointer";
}, true);
document.addEventListener("keydown", event => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey &&
      !["Shift", "Control", "Meta", "Alt"].includes(event.key)) {
    root.dataset.inputModality = "keyboard";
  }
}, true);
// Let the browser choose a focus indicator when entering from browser chrome
// or assistive navigation, before this document receives another input event.
window.addEventListener("blur", () => { delete root.dataset.inputModality; });
