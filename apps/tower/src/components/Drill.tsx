import type * as React from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface DrillProps {
  /** Desk mode wraps children in a drill-down link; the Wall renders them plain. */
  interactive: boolean;
  children: React.ReactNode;
  className?: string;
  /** The in-app evidence route used by interactive mode. */
  to: string;
}

/** Desk numbers link to their evidence; the Wall stays link-free. */
export function Drill({ interactive, children, className, to }: DrillProps) {
  if (!interactive) return <>{children}</>;

  return (
    <Link
      to={to}
      className={cn(
        "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </Link>
  );
}
