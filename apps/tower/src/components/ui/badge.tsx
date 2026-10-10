import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Neutral chrome only: severity colour lives in the severity-aware components
// (AgeBadge, SeverityDot) so the colour system stays in one place.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-muted text-foreground",
        secondary: "border-transparent bg-card text-muted-foreground",
        outline: "border-border text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
