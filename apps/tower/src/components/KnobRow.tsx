import type * as React from "react";
import { cn } from "@/lib/utils";

export interface KnobRowProps {
  /** Plain-language name. */
  label: string;
  /** The effective value. */
  value: React.ReactNode;
  /** One-line "what this means" so the page needs no external manual. */
  explain?: React.ReactNode;
  /** Small scope tag, e.g. "portfolio default". */
  scope?: string;
  className?: string;
}

/** One knob made legible where it acts: label, effective value, explainer and scope. */
export function KnobRow({ label, value, explain, scope, className }: KnobRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-b border-border py-2.5 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {label}
        </span>
        {explain ? (
          <span className="text-xs leading-snug text-muted-foreground">{explain}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
        {scope ? (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {scope}
          </span>
        ) : null}
      </div>
    </div>
  );
}
