import { CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Severity } from "@shared/wall";
import { severityBgClass, severityLabel, severityTextClass } from "@/lib/severity";
import { cn } from "@/lib/utils";

const SIZE: Record<"sm" | "md" | "lg", string> = {
  sm: "size-2",
  md: "size-2.5",
  lg: "size-3.5",
};

/** A shape a little larger than the dot it replaces, so its mark reads at the
 * dot's own sizes: 12, 14 and 16 px. */
const GLYPH_SIZE: Record<"sm" | "md" | "lg", string> = {
  sm: "size-3",
  md: "size-3.5",
  lg: "size-4",
};

/**
 * Severity as a shape, not only a colour. The Wall's `IssueGlyph` reads these
 * shapes from here so the desk and the TV cannot drift apart.
 */
export const SEVERITY_SHAPE: Record<"error" | "warn", LucideIcon> = {
  error: CircleAlert,
  warn: TriangleAlert,
};

export interface SeverityDotProps {
  /** Worst open severity, or null when no flag establishes a severity. */
  severity: Severity | null;
  /** Current reports exist and there are no open error/warn flags. */
  healthy?: boolean;
  /** Milestone kind overrides severity → the reserved emerald accent. */
  milestone?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** What this mark stands for here ("2 open error alerts"), as its accessible
   * name. The shape already says error, warning or healthy without it. */
  title?: string;
}

/**
 * Error/warn take precedence; an evidenced all-clear is green, while no health
 * evidence stays neutral. Milestone-kind retains its reserved event accent.
 * Error, warning and healthy are shapes so they read without colour; info,
 * unknown and milestone stay dots.
 */
export function SeverityDot({
  severity,
  healthy = false,
  milestone = false,
  size = "md",
  className,
  title,
}: SeverityDotProps) {
  const attentionSeverity = severity === "error" || severity === "warn" ? severity : null;
  const label = milestone
    ? "Milestone"
    : attentionSeverity
      ? severityLabel[attentionSeverity]
      : healthy
        ? "Healthy — no open warnings or errors"
        : severity
          ? severityLabel[severity]
          : "No open alerts";
  const Shape = milestone ? null : attentionSeverity ? SEVERITY_SHAPE[attentionSeverity] : healthy ? CircleCheck : null;
  if (Shape) {
    return (
      <span
        role="img"
        aria-label={title ?? label}
        title={title ?? label}
        data-severity-mark={attentionSeverity ?? "healthy"}
        className={cn(
          "inline-flex shrink-0",
          attentionSeverity ? severityTextClass[attentionSeverity] : "text-healthy",
          className,
        )}
      >
        <Shape aria-hidden className={GLYPH_SIZE[size]} strokeWidth={2.5} />
      </span>
    );
  }
  const color = milestone
    ? "bg-milestone"
    : severity
      ? severityBgClass[severity]
      : "bg-muted-foreground/40";
  return (
    <span
      role="img"
      aria-label={title ?? label}
      title={title ?? label}
      className={cn("inline-block shrink-0 rounded-full", SIZE[size], color, className)}
    />
  );
}
