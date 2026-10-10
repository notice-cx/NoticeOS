import { windowSpansTimeZoneChange, type TimeZoneChangePoint } from "@shared/wall";

/**
 * Marks a comparison whose window straddles a reporting-timezone change.
 * Providers do not reprocess history when the timezone changes, so the window
 * subtracts days bucketed in two zones. The figure is still shown, marked,
 * and its delta chip goes neutral wherever this glyph appears.
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
      className="shrink-0 text-warn"
      data-time-zone-caveat={change.effectiveOn}
      title={`Timezone changed ${change.effectiveOn}: ${change.from} → ${change.to} · not like-for-like`}
      aria-label={`Comparison spans a timezone change on ${change.effectiveOn}`}
    >
      ⚠
    </span>
  );
}
