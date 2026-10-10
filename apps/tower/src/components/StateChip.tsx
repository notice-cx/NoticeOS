import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The meaning a state carries, mapped to the existing palette (doc 14 "State is
 * visual, never prose"): connected = the narrow integration-connectivity token;
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

/** tone → palette classes. Exported so an editable control's SELECTED segment can
 * carry the same meaning color+dot (doc 14 "one representation per fact": the
 * control IS the state display) without a rival mapping. `text` is the chip's
 * own ink, for the same state drawn compact — a glyph and a word in a table
 * cell, where a pill per row would be heavier than the fact (bead
 * `ro-ujb9.202`: a task's status on the board and on its page). */
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
 * What a status is ABOUT, as `kind:id` — `integration:bing-webmaster`,
 * `asset:example.com`, `source:example.com:uptime`, `task:ro-1`,
 * `field:Time zone` (bead `ro-ujb9.96.10`). Every status renderer draws it as
 * `data-status-for`, and a row in a list of subjects carries it as
 * `data-subject`: the flow gate reads both from the markup to hold one status
 * per subject per screen and lists grouped by subject (doc 14 principle 3b),
 * rather than guessing the subject from the screen around it. Two chips with
 * one subject and one label on one screen are one fact said twice.
 */
export type StatusSubject = `${string}:${string}`;

export interface StateChipProps {
  /** Plain-language state label (still visible; the color + dot carry meaning). */
  label: ReactNode;
  tone: StateTone;
  /** What this state is about (`StatusSubject`), drawn as `data-status-for`. */
  subject: StatusSubject;
  className?: string;
  /** Hover/tap explainer (doc 14 principle 9 — what this state means). */
  title?: string;
  /** `hollow` renders the dot as a ring — the "hollow notch" for an operator-
   * declined (skipped) state (doc 11 / doc 14-A). Default `solid`. */
  dot?: "solid" | "hollow";
  /** Draws a soft halo on the dot — the "this still needs you" affordance for an
   * unresolved state (needs-setup), keeping it within the tone's own color. */
  attention?: boolean;
  /**
   * A glyph IN PLACE OF the dot, for a state whose vocabulary already owns one
   * (the task lifecycle: an empty circle nobody has taken, a circle with
   * something in it, a barred circle, a snowflake, a tick — the task face
   * the Tasks board and the task page share, `routes/tasks/task-face.tsx`).
   * The dot says only *which tone*; where a surface already reads a
   * state by its SHAPE elsewhere, repeating it here as an anonymous dot would
   * make the two say the same fact in two alphabets (doc 14). Inherits the
   * tone's text color, so it is still the meaning color that carries.
   */
  glyph?: ReactNode;
}

/**
 * A boolean/enum STATE rendered as a glyph: a colored dot + label pill, colored
 * by *meaning* within the palette (doc 14). Replaces bare state words ("Yes",
 * "enabled", "live") so the operator scans state pre-attentively rather than
 * reading it (doc 10 operator profile). The label stays for legibility; color is
 * never the only signal. `hollow` + `attention` distinguish two same-tone states
 * (skipped = hollow notch, needs-setup = filled + halo) without adding a color.
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
