import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

export interface InfoTooltipProps {
  /** Names the explanation, for example "How average daily users is counted". */
  label: string;
  /** Supporting explanation only. Links and actions belong in a disclosure/dialog. */
  children: ReactNode;
  /** Compact visible text or glyph; never pass another interactive control. */
  trigger?: ReactNode;
  className?: string;
}

/** General supporting context, not a substitute for a visible warning, unit or
 * essential period. Uses the chart-event hover/focus/tap interaction contract;
 * evidence dialogs and the Wall's event presentation remain independent. */
export function InfoTooltip({ label, children, trigger, className }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  /** Bumped by a scroll, so the panel follows its trigger instead of closing. */
  const [scrolled, setScrolled] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  // client dimensions exclude permanent scrollbars. The zero fallback supports
  // non-layout test environments; real document viewports supply these values.
  const viewportWidth = open ? document.documentElement.clientWidth || window.innerWidth : 0;
  const viewportHeight = open ? document.documentElement.clientHeight || window.innerHeight : 0;
  const clearClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => { clearClose(); pinned.current = false; setOpen(false); };
  const leave = () => {
    if (pinned.current || document.activeElement === button.current) return;
    clearClose();
    closeTimer.current = setTimeout(close, 150);
  };

  useLayoutEffect(() => {
    if (!open || !button.current || !panel.current) return;
    const anchor = button.current.getBoundingClientRect();
    const rect = panel.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, viewportWidth - rect.width - 8));
    const top = anchor.bottom + rect.height <= viewportHeight - 8
      ? anchor.bottom : Math.max(8, anchor.top - rect.height);
    setPosition({ top, left });
  }, [open, children, viewportWidth, viewportHeight, scrolled]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (!button.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    // A scroll moves the panel rather than closing it: tabbing to a trigger
    // below the fold scrolls, and must not close what focus just opened.
    const scroll = () => setScrolled((count) => count + 1);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      clearClose();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return <>
    <button ref={button} type="button" aria-label={label} aria-expanded={open}
      aria-describedby={open ? id : undefined} data-info-tooltip-trigger
      className={cn("relative inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-sm text-xs font-normal normal-case tracking-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 max-sm:min-w-11",
        trigger != null && "cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4", className)}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") { clearClose(); setOpen(true); } }}
      onPointerLeave={leave}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onFocus={() => { clearClose(); setOpen(true); }}
      onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget)) close(); }}
      onClick={(event) => {
        event.stopPropagation();
        if (pinned.current) close();
        else { clearClose(); pinned.current = true; setOpen(true); }
      }}>
      {trigger ?? <Info className="size-3.5" aria-hidden />}
    </button>
    {open ? createPortal(<div ref={panel} id={id} role="tooltip" aria-label={label}
      className="fixed z-50 grid w-80 gap-2 overflow-auto rounded-md border border-border bg-card p-3 text-left text-xs leading-relaxed text-card-foreground shadow-lg"
      style={{ ...position, maxWidth: Math.max(0, viewportWidth - 16), maxHeight: viewportHeight * 0.7 }} onPointerEnter={clearClose} onPointerLeave={leave}
      onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      {children}
    </div>, document.body) : null}
  </>;
}
