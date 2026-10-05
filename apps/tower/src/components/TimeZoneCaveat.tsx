import { windowSpansTimeZoneChange, type TimeZoneChangePoint } from "@shared/wall";

/**
 * A comparison whose window straddles a reporting-timezone change (`ro-tzq`).
 *
 * A provider buckets each event into a day using the asset's reporting
 * timezone, and it does not reprocess history when that timezone changes — so a
 * window spanning the change is subtracting ET-days from PT-days. The figure is
 * still SHOWN (operator decision, 2026-08-31): continuity is worth more than a
 * blank, and the operator can judge a marked number. What it must never do is
 * present the comparison as clean.
 *
 * A glyph rather than a sentence; the detail belongs in the title for whoever
 * wants it.
 *
 * Shared since `ro-kukv.13`: the site page's supporting-trend tiles, its
 * Performance header and its Overview ask the same question, and a second ⚠
 * with its own wording would be two vocabularies for one fact. It lived
 * beside the Wall card it was born on; since bead `ro-trai.14` it is its own
 * file, so the site page does not download that card to draw one glyph, and
 * the card left the Tower with bead `ro-trai.20`.
 *
 * Since `ro-jkp2` the marked chip goes NEUTRAL wherever this glyph appears. Doc
 * 14 withdraws the week-on-week verdict on both sides of a distorted day.
 * Whether the window straddles a change is decided ONCE, by
 * `spannedTimeZoneChange` in `lib/series.ts`.
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
