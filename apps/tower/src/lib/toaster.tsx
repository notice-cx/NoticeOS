import { useEffect, useRef } from "react";
import { Toaster } from "sonner";
import { useAppliedTheme } from "@/hooks/useTheme";

/**
 * The desk's toaster, without the keyboard trap.
 *
 * Sonner returns focus to where it came from whenever focus leaves its list
 * (meant for its Alt+T hotkey), but every toast is also a Tab stop, so Tab from
 * the page's last control bounced between the two (WCAG 2.1.2). Sonner has no
 * option for this, so the section hides ordinary focus moves from sonner's
 * handlers; only the hotkey's own focus of the list still reaches it.
 *
 * One return is kept: when the focused toast closes under the operator, focus
 * goes back to the control they came from, never once focus has moved on.
 */
export function AppToaster() {
  const section = useRef<HTMLElement>(null);
  const theme = useAppliedTheme();
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const inside = (target: EventTarget | null) => target instanceof Node && node.contains(target);
    let origin: HTMLElement | null = null;
    const entering = (event: FocusEvent) => {
      const fromOutside = !inside(event.relatedTarget);
      if (fromOutside && event.target instanceof Element && event.target.matches("[data-sonner-toaster]")) {
        origin = null;
        return;
      }
      // React hears focus at the root, above this section: stopping it here
      // hides the move from sonner's `onFocus` and from nothing else in the
      // desk (its own focus listeners run in the capture phase).
      event.stopPropagation();
      if (fromOutside) origin = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    };
    const leaving = (event: FocusEvent) => {
      if (inside(event.relatedTarget)) return;
      const left = event.target;
      const from = origin;
      origin = null;
      if (!(left instanceof Element) || from === null) return;
      // A browser blurs a focused element as it removes it, before it detaches.
      // Once this task is over, a toast that is gone and a page with nothing
      // focused mean it closed under the operator rather than being left.
      setTimeout(() => {
        const nothingFocused = document.activeElement === null || document.activeElement === document.body;
        if (!left.isConnected && nothingFocused && from.isConnected) from.focus({ preventScroll: true });
      });
    };
    node.addEventListener("focusin", entering);
    node.addEventListener("focusout", leaving);
    return () => {
      node.removeEventListener("focusin", entering);
      node.removeEventListener("focusout", leaving);
    };
  }, []);
  return <Toaster ref={section} theme={theme} position="bottom-right" richColors />;
}
