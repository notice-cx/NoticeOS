import { useEffect, useRef } from "react";
import { Toaster } from "sonner";
import { useAppliedTheme } from "@/hooks/useTheme";

/**
 * THE DESK'S TOASTER, WITHOUT THE KEYBOARD TRAP (beads `ro-ujb9.87`,
 * `ro-ujb9.54`).
 *
 * Sonner (2.0.7) remembers the element focus came from whenever focus enters
 * its list, and puts focus back there as soon as focus leaves the list (its
 * `onFocus`/`onBlur` on the `<ol>`). That return is built for its Alt+T hotkey,
 * which jumps into the notifications from wherever the operator is and should
 * bring them back. But every toast is ALSO a normal Tab stop (`<li tabIndex=0>`),
 * and the toaster sits last in the page. So Tab from the page's last control
 * entered the toast, the next Tab left it, and sonner put focus straight back on
 * that last control: Tab alternated between the two for as long as the toast
 * stayed up (WCAG 2.1.2, no keyboard trap). The same return pulled focus back
 * when the operator clicked somewhere else.
 *
 * Sonner has no option for this (its props are `hotkey`, `containerAriaLabel`
 * and presentation), so the section keeps ordinary focus moves — a Tab or a
 * click onto a toast, or between the parts of one — from reaching sonner's
 * handlers. Tab then passes through a toast once and continues out of the page,
 * Shift+Tab returns to the page, and leaving a toast never moves focus anywhere
 * but where the operator sent it. Only the hotkey's own focus of the list, from
 * outside it, still reaches sonner, so Alt+T keeps its "take me there and back".
 *
 * One return is kept, because nothing else would place focus: when the toast the
 * operator is on closes under them (its timer, or its own Undo), focus goes back
 * to the control they came from — never when focus has already moved on.
 *
 * IN THE DESK'S THEME (bead `ro-ujb9.117`): a toast is drawn light on a light
 * desk and dark on a dark one, and follows a toggle while it is up. It used to
 * be dark always, so the Undo after answering an inbox row was a dark block on
 * a light page.
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
