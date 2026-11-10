import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The one card shape, as Precise draws a panel: flat on the page, a 1px
 * inset Border ring and 12px corners, so hierarchy comes from scale rather
 * than from cards lifting off the page. `kind` names the card's subject on
 * `data-surface-kind`; it changes nothing drawn.
 */
export type CardKind = "money" | "alert" | "win" | "neutral";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The card's subject. */
  kind?: CardKind;
}

export function Card({ className, kind, ...props }: CardProps) {
  return (
    <div
      data-surface-kind={kind}
      className={cn("rounded-xl bg-card text-card-foreground ring-1 ring-inset ring-border", className)}
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
        "font-semibold text-muted-foreground",
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
