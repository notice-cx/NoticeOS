import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * The vendored shadcn `Command` (doc 14's stack table: "cmdk via shadcn
 * `Command`"), copied in by hand like every other primitive in this folder and
 * adapted to this app's tokens — there is no `primary`/`secondary` color here,
 * and severity owns attention color, so a command list is `card` over
 * `background` with `muted` marking the highlighted row and nothing else.
 *
 * ONE DELIBERATE DIVERGENCE from upstream: `CommandDialog` is written here
 * rather than delegating to `cmdk`'s own `Command.Dialog`, which mounts a Radix
 * Dialog. `@radix-ui/react-dialog` is not a dependency of this app (only
 * `@radix-ui/react-slot` is, for `Button`), and the shell already owns a
 * portal + backdrop idiom for exactly this shape — `AppShell`'s navigation
 * drawer. Reusing it keeps the dependency decision to the one package doc 14
 * already sanctioned. What that costs, and what is paid back by hand: the focus
 * trap Radix would give us. The palette restores focus to where it came from
 * and closes on Escape and on the backdrop; it does not cycle Tab inside
 * itself, which for a list whose only control is one input is a gap nobody can
 * see. If a future dialog needs a real trap, that is the day Radix Dialog earns
 * its entry — not today.
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
 * The palette's chrome: a portal, a backdrop, and a centered box.
 *
 * Focus is the whole reason this is a component rather than three divs. Opening
 * it records what had focus and closing puts it back, because a palette that
 * drops focus on `<body>` makes the operator's next Tab start from the top of
 * the page — the exact cost a keyboard shortcut is supposed to save.
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
  // The close callback is read through a ref so a caller that passes a fresh
  // arrow function each render cannot tear the Escape listener down and back up
  // — and, worse, run the focus restore in between.
  const closeRef = React.useRef(onOpenChange);
  closeRef.current = onOpenChange;
  // Whether the LATEST render was open — read by the cleanup below, which runs
  // after the render that closed the box (bead `ro-ujb9.84`, see there).
  const openRef = React.useRef(open);
  openRef.current = open;

  // Captured during RENDER rather than in an effect. React applies the input's
  // `autoFocus` while it commits it, which is before any effect here could
  // look — by then `document.activeElement` is already the palette's own field,
  // and "restore focus" would mean restoring it to the box we just closed. This
  // render is the last moment the answer is still the operator's page.
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
      // Only a CLOSE gives focus back. React's StrictMode (development, which
      // is what `os:up` serves) runs this cleanup and then the effect again
      // straight away when a dialog MOUNTS already open — and the palette does,
      // since it is fetched on its first open (bead `ro-ujb9.84`). That
      // rehearsal is not a close: restoring on it pulled focus off the field
      // this dialog had just given it, back onto whatever had it before. A real
      // close re-renders with `open` false before this runs.
      if (openRef.current) return;
      const restore = restoreRef.current;
      restoreRef.current = null;
      capturedRef.current = false;
      // Only if it is still in the document: navigating away from the palette
      // is the common close, and the page that launched it is gone by now.
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
      // `max-sm:min-h-11`: the palette is a touch surface on a phone — the
      // drawer's Search opens it — and a 37px row is under the thumb floor
      // (bead `ro-md80`).
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
