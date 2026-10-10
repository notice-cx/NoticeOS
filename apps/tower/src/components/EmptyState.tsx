import type * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** `sm` is a list's own empty value under its heading: never louder than the heading. */
  size?: "default" | "sm";
  className?: string;
}

/** A designed empty state, never a blank tile or a spinner. */
export function EmptyState({ title, hint, size = "default", className }: EmptyStateProps) {
  const small = size === "sm";
  return (
    <div className={cn("flex flex-col items-start justify-center gap-1", small ? "py-1" : "py-2", className)} data-empty-state={small ? "sm" : undefined}>
      <span className={cn("font-medium text-foreground", small ? "text-sm" : "text-base")}>{title}</span>
      {hint ? <span className={cn("text-muted-foreground", small ? "text-xs" : "text-sm")}>{hint}</span> : null}
    </div>
  );
}
