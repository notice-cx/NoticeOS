import type { PulseMetric } from "./asset-detail";
import { fillSeriesGaps } from "./surface";

/** A display comparison over observed reports, never an assumed seven-day
 * calendar baseline. Does not change the collector's stored avg7d or rules. */
export function productReportSummary(metric: PulseMetric, reportDate: string | null) {
  const points = metric.series.filter((point) => Number.isFinite(point.v));
  const previous = reportDate === null ? [] : points.filter((point) => point.t < reportDate).slice(-7);
  const series = fillSeriesGaps(points);
  return {
    series,
    missingDays: series.length - points.length,
    first: points[0]?.t ?? null,
    last: points.at(-1)?.t ?? null,
    previousCount: previous.length,
    previousMean: previous.length === 0 ? null : previous.reduce((sum, point) => sum + point.v, 0) / previous.length,
    previousFirst: previous[0]?.t ?? null,
    previousLast: previous.at(-1)?.t ?? null,
  };
}
