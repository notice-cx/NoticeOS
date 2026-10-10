import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * THE ONE CARD SHAPE (doc 14 principle 4 and its "Details the mockup settles"):
 * `rounded-[10px]`, one border, no shadow.
 *
 * The radius and the shadow are what made a page of cards read as a page of
 * boxes. doc 14's hierarchy comes from SCALE — an eyebrow over large numbers —
 * so every card that lifts off the page with its own drop shadow is competing
 * for the rank the numbers are supposed to hold, and twelve of them competing at
 * once is the "scattered rectangles" the operator named. Ten pixels also matches
 * `ListPanel`, which drew the new radius first: two radii on one screen is one
 * card style in name only.
 *
 * ONE SHAPE, FOUR TINTS (D44, accent system 3; doc 14 § Surface kinds). A card
 * may declare its SUBJECT as a `kind`, and wears that kind's tint from its top
 * edge down to the ordinary surface, with the kind's border and a one-pixel
 * inner highlight. A tint is the subject, never the verdict: an alert card is
 * tinted alert whether its alert is warn or error, and the severity still rides
 * the ring, the glyph and the word. Only a highlight card and a hero use kinds;
 * lists, tables and strips stay unkinded. Depth comes from the tint and the
 * highlight line — still no shadow.
 */
export type CardKind = "money" | "alert" | "win" | "neutral";

const KIND_CLASS: Record<CardKind, string> = {
  money: "border-surface-money-line bg-linear-to-b from-surface-money to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  alert: "border-surface-alert-line bg-linear-to-b from-surface-alert to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  win: "border-surface-win-line bg-linear-to-b from-surface-win to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  neutral: "border-border bg-linear-to-b from-surface-neutral to-card to-60% shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The card's subject, as a tint (D44). Absent, the plain card. */
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
