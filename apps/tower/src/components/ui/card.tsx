import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * THE ONE CARD STYLE (doc 21 principle 4 and its "Details the mockup settles"):
 * `rounded-[10px]`, one border, no shadow.
 *
 * The radius and the shadow are what made a page of cards read as a page of
 * boxes. Doc 21's hierarchy comes from SCALE — an eyebrow over large numbers —
 * so every card that lifts off the page with its own drop shadow is competing
 * for the rank the numbers are supposed to hold, and twelve of them competing at
 * once is the "scattered rectangles" the operator named. Ten pixels also matches
 * `ListPanel`, which drew the new radius first: two radii on one screen is one
 * card style in name only.
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[10px] border border-border bg-card text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "font-semibold uppercase tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-4 pt-0", className)} {...props} />;
}
