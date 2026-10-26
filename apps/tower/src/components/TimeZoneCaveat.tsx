import { windowSpansTimeZoneChange, type TimeZoneChangePoint } from "@shared/wall";

/**
 * Marks a comparison whose window straddles a reporting-timezone change.
 * Derived daily boundaries use estimates; the comparison remains usable.
 */
export function TimeZoneCaveat({
  trend,
  window,
}: {
  trend: { timeZoneChanges: TimeZoneChangePoint[] };
  window: { start: string; end: string };
}) {
  const change = windowSpansTimeZoneChange(trend.timeZoneChanges, window);
  if (!change) return null;
  return (
    <span
      className="shrink-0 text-muted-foreground"
      data-time-zone-caveat={change.effectiveOn}
      title={`Timezone adjusted ${change.effectiveOn}: ${change.from} → ${change.to} · estimated daily boundaries`}
      aria-label={`Comparison uses estimated timezone boundaries on ${change.effectiveOn}`}
    >
      ≈
    </span>
  );
}
