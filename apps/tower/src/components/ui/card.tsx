import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The one card shape: `rounded-[10px]`, one border, no shadow, so hierarchy
 * comes from scale rather than from cards lifting off the page. A `kind` tints
 * the card by its subject, never its verdict: an alert card is tinted alert
 * whether warn or error. Only highlight cards and heroes use kinds.
 */
export type CardKind = "money" | "alert" | "win" | "neutral";

const KIND_CLASS: Record<CardKind, string> = {
  money: "border-surface-money-line bg-linear-to-b from-surface-money to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  alert: "border-surface-alert-line bg-linear-to-b from-surface-alert to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  win: "border-surface-win-line bg-linear-to-b from-surface-win to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  neutral: "border-border bg-linear-to-b from-surface-neutral to-card to-60% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The card's subject, as a tint. Absent, the plain card. */
  kind?: CardKind;
}

export function Card({ className, kind, ...props }: CardProps) {
  return (
    <div
      data-surface-kind={kind}
      className={cn(
        "rounded-[10px] border text-card-foreground",
        kind ? KIND_CLASS[kind] : "border-border bg-card",
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
