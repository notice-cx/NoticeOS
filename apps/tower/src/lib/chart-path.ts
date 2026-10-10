// The charts' one geometry: the SVG path strings every line, area and point in
// the Tower's small charts is drawn with. Pure functions of points already in
// the chart's own coordinates; nothing here knows about data, dates or colour.
//
// Why a monotone curve. A daily line drawn as straight segments reads like a
// seismograph at TV size, and an ordinary smoothing spline invents peaks and
// dips the data never had (it overshoots between two readings). The monotone
// cubic (Fritsch–Carlson, the curve d3-shape calls `curveMonotoneX`) passes
// through every reading exactly and never goes above or below the two readings
// either side of a segment, so the smooth line states nothing the points do
// not. It is affine-invariant, so it stays monotone when a chart's 1000×100
// viewBox is stretched to any box.

export interface ChartPoint {
  x: number;
  y: number;
}

/** Two decimals: sub-pixel at any size these charts are drawn, and a short
 * string. */
function n(value: number): number {
  return Math.round(value * 100) / 100;
}

const sign = (value: number) => (value < 0 ? -1 : 1);

/**
 * The tangent at `b`, between `a` and `c`: zero at a local peak or trough
 * (the secants disagree in sign), otherwise the gentlest of the two secants
 * and half their weighted mean — the Fritsch–Carlson bound that keeps each
 * segment monotone.
 */
function innerTangent(a: ChartPoint, b: ChartPoint, c: ChartPoint): number {
  const h0 = b.x - a.x;
  const h1 = c.x - b.x;
  const s0 = h0 === 0 ? 0 : (b.y - a.y) / h0;
  const s1 = h1 === 0 ? 0 : (c.y - b.y) / h1;
  const p = h0 + h1 === 0 ? 0 : (s0 * h1 + s1 * h0) / (h0 + h1);
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

/** The tangent at an end of the line, from its one neighbour's tangent. */
function endTangent(a: ChartPoint, b: ChartPoint, neighbour: number): number {
  const h = b.x - a.x;
  return h === 0 ? neighbour : (3 * ((b.y - a.y) / h) - neighbour) / 2;
}

/**
 * A monotone cubic through `points` (x ascending): `M` to the first point, then
 * one `C` per segment ending exactly on the next point. One point is a bare
 * `M` (a caller draws it as a dot), two are a straight `L`.
 */
export function monotonePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  const [first] = points;
  const start = `M${n(first!.x)} ${n(first!.y)}`;
  if (points.length === 1) return start;
  if (points.length === 2) return `${start} L${n(points[1]!.x)} ${n(points[1]!.y)}`;

  const last = points.length - 1;
  const tangents = points.map((point, index) =>
    index === 0 || index === last ? 0 : innerTangent(points[index - 1]!, point, points[index + 1]!),
  );
  tangents[0] = endTangent(points[0]!, points[1]!, tangents[1]!);
  tangents[last] = endTangent(points[last - 1]!, points[last]!, tangents[last - 1]!);

  let path = start;
  for (let index = 0; index < last; index += 1) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const third = (b.x - a.x) / 3;
    path +=
      ` C${n(a.x + third)} ${n(a.y + third * tangents[index]!)}` +
      ` ${n(b.x - third)} ${n(b.y - third * tangents[index + 1]!)}` +
      ` ${n(b.x)} ${n(b.y)}`;
  }
  return path;
}

/** The same curve closed down to `baseline` (a y), for the wash under a line. */
export function areaPath(points: readonly ChartPoint[], baseline: number): string {
  if (points.length < 2) return "";
  return `${monotonePath(points)} L${n(points.at(-1)!.x)} ${n(baseline)} L${n(points[0]!.x)} ${n(baseline)} Z`;
}

/**
 * A point as a zero-length stroke. Drawn with a round cap and a non-scaling
 * stroke it is a circle whose DIAMETER is the stroke width in screen pixels,
 * whatever the viewBox is stretched to — so a chart can keep its dots in the
 * same SVG as its lines instead of placing HTML over them, and they never
 * become ellipses.
 */
export function dotPath(point: ChartPoint): string {
  return `M${n(point.x)} ${n(point.y)}h0`;
}

/** Split an ordered series into runs of consecutive readings: a `null` ends
 * the run it interrupts, so a line breaks over a period nobody reported
 * instead of joining the readings either side. */
export function readingRuns<T>(values: readonly (T | null)[]): { index: number; value: T }[][] {
  const runs: { index: number; value: T }[][] = [];
  let run: { index: number; value: T }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, value });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}
