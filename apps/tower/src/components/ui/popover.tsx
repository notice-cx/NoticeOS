import * as PopoverPrimitive from "@radix-ui/react-popover";
import { createContext, useContext, useRef, type ComponentProps, type RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * The desk's anchored popover: shadcn's `Popover` on Radix in this theme's
 * tokens. Radix owns focus into the panel, Escape/outside/focus-out closing,
 * placement and the dialog roles; a scroll moves the panel, never closes it.
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
        /* Radix leaves focus where an outside press put it, which on bare page
           is the body. A close that leaves focus on the body or in the gone
           panel returns it to the trigger; focus on another control stays. */
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
