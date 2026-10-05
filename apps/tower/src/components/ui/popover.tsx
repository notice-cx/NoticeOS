import * as PopoverPrimitive from "@radix-ui/react-popover";
import { createContext, useContext, useRef, type ComponentProps, type RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * THE DESK'S ANCHORED POPOVER — shadcn's `Popover` on Radix (doc 14's stack),
 * dressed in this theme's tokens (bead `ro-ujb9.219`).
 *
 * What Radix gives every caller, so none re-implements it: opening moves
 * keyboard focus into the panel; Escape, a press outside and focus leaving
 * close it and hand focus back to the trigger (unless it went to another
 * control); the panel is portalled, placed against its trigger and kept inside
 * the viewport as the page scrolls — a scroll moves it, it never closes it.
 * `role="dialog"` with the trigger's `aria-expanded` and `aria-controls` wired.
 *
 * Registry justification: `EvidencePopover` was a hand-rolled portal with no
 * focus management and a scroll listener that closed it; `InfoTooltip` is a
 * hover/focus/tap tooltip for label-length facts, not a dialog. No primitive in
 * `components/ui/` placed a focusable panel against its trigger.
 */
const TriggerContext = createContext<RefObject<HTMLButtonElement | null> | null>(null);

export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <TriggerContext.Provider value={trigger}>
      <PopoverPrimitive.Root {...props} />
    </TriggerContext.Provider>
  );
}

export function PopoverTrigger({ ref, ...props }: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const trigger = useContext(TriggerContext);
  return (
    <PopoverPrimitive.Trigger
      ref={(node) => {
        if (trigger) trigger.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      {...props}
    />
  );
}

export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  collisionPadding = 8,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  const trigger = useContext(TriggerContext);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        /* FOCUS IS NEVER DROPPED ON THE PAGE. Radix returns focus to the
           trigger on Escape but, after a press outside, leaves it wherever
           the press put it — which on a bare stretch of page is nowhere: the
           body, and a keyboard starts again from the top. So a close that
           leaves focus on the body (or in the panel that just went) sends it
           back to the trigger; a press or a Tab that landed on another control
           keeps it there. */
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const panel = event.target instanceof Node ? event.target : null;
          const now = document.activeElement;
          if (now && now !== document.body && !panel?.contains(now)) return;
          trigger?.current?.focus();
        }}
        className={cn(
          "z-50 max-h-(--radix-popover-content-available-height) w-72 overflow-auto rounded-lg border border-border bg-card p-3 text-card-foreground shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
