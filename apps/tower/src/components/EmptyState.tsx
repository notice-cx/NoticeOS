import type * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** `sm` is a list's own empty value under its heading (bead
   * `ro-ujb9.96.6.22`): the state at the heading's size, never louder than
   * the heading it answers. */
  size?: "default" | "sm";
  className?: string;
}

/** A designed empty state (doc 14 principle 2) — never a blank tile, never a
 * spinner. Used for the first-run portfolio band and any band with no data yet. */
export function EmptyState({ title, hint, size = "default", className }: EmptyStateProps) {
  const small = size === "sm";
  return (
    <div className={cn("flex flex-col items-start justify-center gap-1", small ? "py-1" : "py-2", className)} data-empty-state={small ? "sm" : undefined}>
      <span className={cn("font-medium text-foreground", small ? "text-sm" : "text-base")}>{title}</span>
      {hint ? <span className={cn("text-muted-foreground", small ? "text-xs" : "text-sm")}>{hint}</span> : null}
    </div>
  );
}
