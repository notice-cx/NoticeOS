import type { KeyboardEvent } from "react";

/** Move focus among a menu's enabled items with the arrow keys, Home and End. */
export function roveMenuFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

/** A menu's first item that can act takes focus when the menu opens, rather than the panel itself. */
export function focusFirstMenuItem(event: Event): void {
  event.preventDefault();
  const panel = event.currentTarget as HTMLElement | null;
  panel?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
}
