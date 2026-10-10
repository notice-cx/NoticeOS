import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The meaning a state carries, mapped to the existing palette: connected = the
 * narrow integration-connectivity token;
 * missing/failing = severity scale; operator-declined = slate (the info token);
 * not-applicable = muted. `affirmative` and `neutral` are plain non-semantic
 * states; emerald remains exclusive to milestone-kind outcomes.
 */
export type StateTone =
  | "connected"
  | "affirmative"
  | "caution"
  | "critical"
  | "declined"
  | "na"
  | "neutral";

/** tone → palette classes. Exported so an editable control's selected segment
 * carries the same colour and dot without a rival mapping. `text` is the
 * chip's own ink, for the same state drawn compact as a glyph and a word. */
export const STATE_TONE: Record<StateTone, { chip: string; dot: string; ring: string; text: string }> = {
  connected: { chip: "border-connected/30 bg-connected-soft text-connected", dot: "bg-connected", ring: "ring-connected/40", text: "text-connected" },
  affirmative: { chip: "border-border bg-muted/50 text-foreground", dot: "bg-muted-foreground", ring: "ring-muted-foreground/30", text: "text-foreground" },
  caution: { chip: "border-warn/30 bg-warn-soft text-warn", dot: "bg-warn", ring: "ring-warn/40", text: "text-warn" },
  critical: { chip: "border-error/30 bg-error-soft text-error", dot: "bg-error", ring: "ring-error/40", text: "text-error" },
  declined: { chip: "border-info/40 bg-info/10 text-info", dot: "bg-info", ring: "ring-info/40", text: "text-info" },
  na: { chip: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground/50", ring: "ring-muted-foreground/30", text: "text-muted-foreground" },
  neutral: { chip: "border-border text-foreground", dot: "bg-muted-foreground", ring: "ring-muted-foreground/30", text: "text-foreground" },
};

/**
 * What a status is about, as `kind:id` — `integration:bing-webmaster`,
 * `asset:example.com`, `source:example.com:uptime`, `field:Time zone`. Drawn
 * as `data-status-for` (or `data-subject` on a list row); the flow gate reads
 * both to hold one status per subject per screen.
 */
export type StatusSubject = `${string}:${string}`;

export interface StateChipProps {
  /** Plain-language state label (still visible; the color + dot carry meaning). */
  label: ReactNode;
  tone: StateTone;
  /** What this state is about (`StatusSubject`), drawn as `data-status-for`. */
  subject: StatusSubject;
  className?: string;
  /** Hover/tap explainer: what this state means. */
  title?: string;
  /** `hollow` renders the dot as a ring — the "hollow notch" for an operator-
   * declined (skipped) state. Default `solid`. */
  dot?: "solid" | "hollow";
  /** Draws a soft halo on the dot — the "this still needs you" affordance for an
   * unresolved state (needs-setup), keeping it within the tone's own color. */
  attention?: boolean;
  /**
   * A glyph in place of the dot, for a state whose vocabulary already owns one
   * (the task face in `routes/tasks/task-face.tsx`). Inherits the tone's text
   * colour.
   */
  glyph?: ReactNode;
}

/**
 * A boolean/enum state rendered as a coloured dot + label pill, coloured by
 * meaning. Colour is never the only signal. `hollow` + `attention` distinguish
 * two same-tone states (skipped = hollow notch, needs-setup = filled + halo)
 * without adding a colour.
 */
export function StateChip({
  label,
  tone,
  subject,
  className,
  title,
  dot = "solid",
  attention = false,
  glyph,
}: StateChipProps) {
  const t = STATE_TONE[tone];
  return (
    <span
      title={title}
      data-status-for={subject}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        t.chip,
        className,
      )}
    >
      {glyph ? (
        <span aria-hidden className="inline-flex shrink-0 items-center">
          {glyph}
        </span>
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            dot === "hollow" ? "border-2 border-current bg-transparent" : t.dot,
            attention && cn("ring-2", t.ring),
          )}
        />
      )}
      {label}
    </span>
  );
}
