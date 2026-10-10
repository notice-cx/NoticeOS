import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { type Direction, direction, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICON: Record<Direction, typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
};

export interface DeltaChipProps {
  /** Signed magnitude; the arrow shows direction, the text shows |value|. */
  value: number;
  /** Formatter for the magnitude; defaults to whole-dollar USD. */
  render?: (n: number) => string;
  /** Performance tones are scoped like-for-like signals, never severity; pace
   * tones are today's pace against the same hours last week (`paceTone`). */
  tone?: ChipTone;
  /** What this movement IS, in one sentence: which two windows, over what. A
   * bare signed number is only honest while the reader knows what it compares,
   * so the sentence becomes both the tooltip and the accessible name — the
   * arrow is decorative and a screen reader would otherwise hear a magnitude
   * with no direction and no period. */
  meaning?: string;
  /** The direction in words beside the magnitude, such as ahead or behind. */
  directionLabel?: string;
  className?: string;
}

/** A trend indicator. Direction is always carried by the glyph. Positive green
 * is opt-in only for a completed like-for-like comparison. */
export function DeltaChip({
  value,
  render = (n) => formatUsd(n),
  tone = "neutral",
  meaning,
  directionLabel,
  className,
}: DeltaChipProps) {
  const dir = direction(value);
  const Icon = ICON[dir];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-sm font-medium tabular-nums text-foreground",
        TONE_CLASS[tone],
        className,
      )}
      data-tone={tone}
      title={meaning}
      aria-label={meaning}
    >
      <Icon className="size-3.5" aria-hidden />
      {render(Math.abs(value))}
      {directionLabel ? ` ${directionLabel}` : null}
    </span>
  );
}

export type PerformanceTone =
  | "neutral"
  | "positive-subtle"
  | "positive"
  | "positive-strong"
  | "negative-subtle"
  | "negative"
  | "negative-strong";

/**
 * TODAY'S PACE HAS ITS OWN DIRECTION SCALE (bead `ro-trai.48`;
 * docs/14-design.md § Site rows, doc 14 § Tokens): today's
 * completed hours against the same hours on the same weekday last week. The
 * direction says ahead, on pace or behind; large deficits keep red. It is a
 * comparison, never an alert: "a little behind" borrows the warn HUE through
 * its own `pace-behind` token, and the arrow and the % always ride beside the
 * colour.
 */
export type PaceTone = "pace-on" | "pace-behind" | "pace-far-behind";

export type ChipTone = PerformanceTone | PaceTone;

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "data-[tone=neutral]:text-foreground",
  "positive-subtle":
    "data-[tone=positive-subtle]:text-trend-positive/55",
  positive: "data-[tone=positive]:text-trend-positive/80",
  "positive-strong":
    "data-[tone=positive-strong]:text-trend-positive",
  "negative-subtle":
    "data-[tone=negative-subtle]:text-trend-negative/55",
  negative: "data-[tone=negative]:text-trend-negative/80",
  "negative-strong":
    "data-[tone=negative-strong]:text-trend-negative",
  "pace-on": "data-[tone=pace-on]:text-pace-on",
  "pace-behind": "data-[tone=pace-behind]:text-pace-behind",
  "pace-far-behind": "data-[tone=pace-far-behind]:text-pace-far-behind",
};

/**
 * The tone's colour for something else drawn in it — D28's site rows draw
 * today's line, its wash and its now point in its pace's tone
 * (docs/14-design.md § Site rows). The element carries `data-tone={tone}`
 * like the chip does, so both read the one table above rather than a second
 * copy of the steps.
 */
export function performanceToneClass(tone: ChipTone): string {
  return cn("text-foreground", TONE_CLASS[tone]);
}

/** Below this share of last week's same hours, it is far behind. */
export const PACE_FAR_RATIO = 0.6;

/** The direction of a finite comparable pace; no verdict for missing data. */
export function paceDirectionLabel(percent: number): "ahead" | "behind" | "on pace" | null {
  if (!Number.isFinite(percent)) return null;
  return percent > 0 ? "ahead" : percent < 0 ? "behind" : "on pace";
}

/**
 * THE ONE DERIVATION of a pace's step, for every place a pace is drawn: the
 * Wall's site rows and one-site tile (line, wash, now point and %), the old
 * asset card and the desk's Today column. Takes the signed percent
 * `intradayUsersPace` states (today vs last week, in %), so the ratio is
 * `1 + percent / 100`: positive is ahead, equality neutral, every deficit
 * behind. Deficits below the existing 0.60 boundary are far behind. That
 * boundary retains its whole-basis-point comparison (−40% is behind).
 */
export function paceTone(percent: number): PaceTone | "neutral" {
  if (!Number.isFinite(percent) || percent === 0) return "neutral";
  if (percent > 0) return "pace-on";
  const basisPoints = Math.round((100 + percent) * 100);
  if (basisPoints >= Math.round(PACE_FAR_RATIO * 10_000)) return "pace-behind";
  return "pace-far-behind";
}

/** Three steps communicate materiality without implying more precision than a
 * compact chart can support. Callers provide a signed percent. */
export function performanceTone(percent: number): PerformanceTone {
  if (!Number.isFinite(percent) || percent === 0) return "neutral";
  const magnitude = Math.abs(percent);
  const strength = magnitude >= 25 ? "strong" : magnitude >= 10 ? "" : "subtle";
  if (percent > 0) {
    return strength === "strong"
      ? "positive-strong"
      : strength === "subtle"
        ? "positive-subtle"
        : "positive";
  }
  return strength === "strong"
    ? "negative-strong"
    : strength === "subtle"
      ? "negative-subtle"
      : "negative";
}
