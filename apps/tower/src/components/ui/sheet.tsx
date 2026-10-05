import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SheetProps {
  /** The id of the heading that names the sheet. */
  labelledBy: string;
  onClose: () => void;
  /** What the close control is called to a screen reader. */
  closeLabel?: string;
  /** The sheet's own header content, beside the close control. */
  header: ReactNode;
  children: ReactNode;
  /** `data-*` hooks for tests and walks, put on the dialog itself. */
  data?: Record<`data-${string}`, string>;
  className?: string;
  /**
   * Where the sheet sits. `side` (the default) is a working panel over the
   * right edge that the operator stays in for several steps — the connect
   * panel. `center` is a short question asked over the page and gone after one
   * answer — Add a site (bead `ro-ujb9.96.7.5`): a card in the middle of the
   * desk, the width of its one field, and on a phone the same card under the
   * app bar rather than a whole screen for one input.
   */
  placement?: "side" | "center";
}

/**
 * A panel that slides over the right edge of the desk — a modal side sheet
 * (bead `ro-ujb9.96.7.1`, first used by `ConnectPanel`).
 *
 * WHAT MAKES IT A SCREEN OF ITS OWN WITHOUT BEING A PAGE. The desk behind is
 * blurred and made `inert` while the sheet is open, so the one thing in focus
 * is the one thing that can be operated: Tab stays inside, a screen reader
 * hears only the sheet, and a status drawn behind it is not a second copy of
 * the status drawn in it (doc 14, one representation per fact). Escape, the
 * close control and a press on the blurred desk all close it, and focus goes
 * back to the control that opened it.
 *
 * On a phone the sheet is the screen: it spans the width under the app bar,
 * which stays visible so the operator knows where they are.
 */
export function Sheet({ labelledBy, onClose, closeLabel = "Close", header, children, data, className, placement = "side" }: SheetProps) {
  const center = placement === "center";
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]")
      ?? panel.current?.querySelector<HTMLElement>("input, button, a[href]");
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      root?.removeAttribute("inert");
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex max-md:top-12",
        center ? "items-start justify-center p-4 md:pt-[14vh]" : "justify-end",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={closeLabel}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-background/75 backdrop-blur-sm"
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        {...data}
        className={cn(
          "relative flex w-full flex-col overflow-y-auto border-border bg-card shadow-xl",
          center
            ? "max-h-full max-w-[440px] gap-4 rounded-[14px] border p-5"
            : "h-full gap-5 p-5 md:max-w-[430px] md:border-l",
          className,
        )}
      >
        <header className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-3">{header}</div>
          <Button type="button" variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose} className="shrink-0">
            <X aria-hidden />
          </Button>
        </header>
        {children}
      </aside>
    </div>,
    document.body,
  );
}
