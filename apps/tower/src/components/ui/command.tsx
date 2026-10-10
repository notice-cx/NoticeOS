import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * The vendored shadcn `Command`, on this app's tokens: `card` over `background`
 * with `muted` marking the highlighted row. `CommandDialog` is written here
 * rather than using cmdk's Radix-based `Command.Dialog`, since
 * `@radix-ui/react-dialog` is not a dependency. It restores focus and closes on
 * Escape and the backdrop, but does not trap Tab.
 */
export const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-xl bg-card text-card-foreground",
      className,
    )}
    {...props}
  />
));
Command.displayName = "Command";

export interface CommandDialogProps
  extends React.ComponentPropsWithoutRef<typeof CommandPrimitive> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for both the dialog and the command list. */
  label: string;
}

/**
 * The palette's chrome: a portal, a backdrop and a centred box. Closing puts
 * focus back where it was, so the next Tab does not start from the top.
 */
export function CommandDialog({
  open,
  onOpenChange,
  label,
  className,
  children,
  ...props
}: CommandDialogProps) {
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const capturedRef = React.useRef(false);
  // Read through a ref so a fresh callback each render cannot tear down the
  // Escape listener and run the focus restore in between.
  const closeRef = React.useRef(onOpenChange);
  closeRef.current = onOpenChange;
  // Whether the latest render was open, read by the cleanup below.
  const openRef = React.useRef(open);
  openRef.current = open;

  // Captured during render: the input's `autoFocus` applies at commit, before
  // any effect, so an effect would capture the palette's own field.
  if (open && !capturedRef.current) {
    capturedRef.current = true;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Only a close restores focus. StrictMode runs this cleanup on a mount
      // that is already open, and restoring then would pull focus off the field.
      if (openRef.current) return;
      const restore = restoreRef.current;
      restoreRef.current = null;
      capturedRef.current = false;
      // Navigating away is the common close, so the opener may be gone.
      if (restore && restore.isConnected) restore.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]">
      <button
        type="button"
        aria-label={`Close ${label.toLowerCase()}`}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      >
        <Command label={label} className={className} {...props}>
          {children}
        </Command>
      </div>
    </div>,
    document.body,
  );
}

export const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center gap-2 border-b border-border px-3">
    <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = "CommandInput";

export const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[min(24rem,60vh)] overflow-y-auto overflow-x-hidden p-1", className)}
    {...props}
  />
));
CommandList.displayName = "CommandList";

export const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn("py-8 text-center text-sm text-muted-foreground", className)}
    {...props}
  />
));
CommandEmpty.displayName = "CommandEmpty";

export const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted-foreground",
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = "CommandGroup";

export const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      // The palette is a touch surface on a phone: rows meet the thumb floor.
      "relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none max-sm:min-h-11 data-[selected=true]:bg-muted data-[selected=true]:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = "CommandItem";

export function CommandShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props}
    />
  );
}
