import type { KeyboardEvent } from "react";

export const SHORTCUT_MODIFIER = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘" : "Ctrl+";

/** Keep Tab inside a portalled dialog, including when responsive links are hidden. */
export function containDialogTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
  )).filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  const edge = event.shiftKey ? first : last;
  if (edge && document.activeElement === edge) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}
