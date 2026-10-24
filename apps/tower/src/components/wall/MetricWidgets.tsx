import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { SeriesPointOrGap } from "@shared/surface";
import { ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import { SERIES_TONE_CLASS, type SeriesTone } from "@/components/surface/Sparkline";
import { readingRuns } from "@/lib/chart-path";
import { cn } from "@/lib/utils";
import "./MetricWidgets.css";

export interface MetricTileProps {
  title: string;
  icon?: LucideIcon;
  context?: ReactNode;
  size?: "narrow" | "standard" | "wide";
  expanded?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function MetricTile({ title, icon: Icon, context, size = "standard", expanded = false, className, style, children }: MetricTileProps) {
  return <section className={cn("wall-metric", className)} data-metric-size={size} data-metric-expanded={expanded || undefined} style={style} aria-label={title}>
    <h3 className="wall-metric-title">{Icon ? <Icon aria-hidden="true" /> : null}<span>{title}</span>{context != null ? <span className="wall-metric-context">{context}</span> : null}</h3>
    {children}
  </section>;
}

type TileProps = Omit<MetricTileProps, "children">;
const shown = (value: ReactNode) => value ?? <span aria-label="Unavailable">—</span>;

export interface MetricMovement {
  label: string;
  direction: "up" | "down" | "flat";
  tone?: SeriesTone;
  basis?: ReactNode;
  meaning?: string;
}

function MovementReadout({ movement, className }: { movement: MetricMovement; className?: string }) {
  return <div className={cn("wall-metric-movement", SERIES_TONE_CLASS[movement.tone ?? "neutral"], className)} data-metric-movement data-tone={movement.tone ?? "neutral"} title={movement.meaning} aria-label={movement.meaning}>
    <span className="wall-metric-change"><span aria-hidden="true">{movement.direction === "up" ? "↑" : movement.direction === "down" ? "↓" : "→"} </span>{movement.label}</span>
    {movement.basis != null ? <span className="wall-metric-basis">{movement.basis}</span> : null}
  </div>;
}

export interface NumberMetricProps extends TileProps {
  value: ReactNode;
  qualifier?: ReactNode;
  note?: ReactNode;
  movement?: MetricMovement;
  history?: { data: readonly SeriesPointOrGap[]; startLabel: string; endLabel: string };
}

export function NumberMetric({ value, qualifier, note, movement, history, ...tile }: NumberMetricProps) {
  return <MetricTile {...tile} className={cn("wall-metric-number", tile.className)}>
    <div className="wall-metric-main"><div className="wall-metric-primary">{qualifier != null ? <span className="wall-metric-note wall-metric-qualifier">{qualifier}</span> : null}<strong className="wall-metric-value">{shown(value)}</strong></div>{movement ? <MovementReadout movement={movement} /> : null}</div>
    {history ? <MetricComparisonChart current={history.data} startLabel={history.startLabel} endLabel={history.endLabel} label={`${tile.title} history`} tone={movement?.tone} /> : null}
    {note != null ? <div className="wall-metric-note">{note}</div> : null}
  </MetricTile>;
}

export interface MultiMetricProps extends TileProps {
  primary?: { label: string; value: ReactNode; tone?: SeriesTone };
  metrics: readonly { label: string; value: ReactNode; icon?: LucideIcon }[];
  note?: ReactNode;
}

export function MultiMetric({ primary, metrics, note, ...tile }: MultiMetricProps) {
  const facts = <dl className="wall-metric-facts" style={{ "--metric-count": Math.max(1, metrics.length) } as CSSProperties}>{metrics.map(({ label, value, icon: Icon }) => <div key={label}><dt>{Icon ? <Icon aria-hidden="true" /> : null}{label}</dt><dd>{shown(value)}</dd></div>)}</dl>;
  return <MetricTile {...tile}>{primary ? <div className="wall-metric-breakdown"><dl className="wall-metric-primary"><dt>{primary.label}</dt><dd className={primary.tone ? SERIES_TONE_CLASS[primary.tone] : undefined}>{shown(primary.value)}</dd></dl>{facts}</div> : facts}{note != null ? <div className="wall-metric-note">{note}</div> : null}</MetricTile>;
}

export interface MomentumMetricProps extends TileProps {
  value: ReactNode;
  recent?: { value: ReactNode; label: string };
  bars: readonly (number | null)[];
  highlightLast?: number;
  startLabel: string;
  endLabel: string;
  tone?: SeriesTone;
}

export function MomentumMetric({ value, recent, bars, highlightLast = 5, startLabel, endLabel, tone = "traffic", ...tile }: MomentumMetricProps) {
  const readings = bars.map(value => value !== null && Number.isFinite(value) ? value : null);
  const recentCount = Number.isFinite(highlightLast) ? Math.min(bars.length, Math.max(0, Math.floor(highlightLast))) : 0;
  const maximum = Math.max(1, ...readings.filter((v): v is number => v !== null));
  return <MetricTile {...tile}><div className="wall-metric-main"><strong className="wall-metric-value">{shown(value)}</strong>{recent ? <span className="wall-metric-recent"><b>{shown(recent.value)}</b> {recent.label}</span> : null}</div>
    {readings.some(value => value !== null) ? <div className={cn("wall-metric-bars", SERIES_TONE_CLASS[tone])} role="img" aria-label={`${tile.title}: ${readings.length} periods; latest ${recentCount} highlighted. ${readings.filter(v => v === null).length} unavailable.`}>{readings.map((value, index) => <span key={index} data-value={value ?? undefined} data-metric-bar={value === null ? "missing" : index >= readings.length - recentCount ? "recent" : "earlier"} style={{ "--metric-bar-height": value === null ? "0%" : `${Math.max(0, value) / maximum * 100}%` } as CSSProperties} />)}</div> : <span className="wall-metric-empty">History unavailable</span>}
    <div className="wall-metric-axis"><span>{startLabel}</span><span>{endLabel}</span></div>
  </MetricTile>;
}

export interface MetricComparisonChartProps {
  current: readonly SeriesPointOrGap[];
  reference?: readonly SeriesPointOrGap[];
  forecast?: readonly SeriesPointOrGap[];
  previousTotal?: { value: number; label: string };
  /** Full comparison period, including dates no current observation reaches yet. */
  domain?: { start: string; end: string };
  startLabel: string;
  endLabel: string;
  label: string;
  tone?: SeriesTone;
  className?: string;
}

/** All series share dates and scale; null readings interrupt their own line. */
export function MetricComparisonChart({ current, reference = [], forecast = [], previousTotal, domain, startLabel, endLabel, label, tone = "neutral", className }: MetricComparisonChartProps) {
  const dates = [...new Set([...current, ...reference, ...forecast].map(p => p.t))].sort();
  const values = [...current, ...reference, ...forecast].flatMap(p => p.v !== null && Number.isFinite(p.v) ? [p.v] : []);
  if (previousTotal && Number.isFinite(previousTotal.value)) values.push(previousTotal.value);
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const y = (value: number) => 44 - (value - low) / (high - low) * 40;
  const domainStart = Date.parse(domain?.start ?? dates[0] ?? "");
  const domainEnd = Date.parse(domain?.end ?? dates.at(-1) ?? "");
  const x = (index: number) => Number.isFinite(domainStart) && domainEnd > domainStart
    ? 4 + (Date.parse(dates[index]!) - domainStart) / (domainEnd - domainStart) * 192
    : dates.length < 2 ? 100 : 4 + index / (dates.length - 1) * 192;
  const runs = (series: readonly SeriesPointOrGap[]) => {
    const byDate = new Map(series.map(point => [point.t, point.v]));
    return readingRuns(dates.map(date => { const value = byDate.get(date); return value != null && Number.isFinite(value) ? value : null; })).map(run => run.map(p => ({ x: x(p.index), y: y(p.value) })));
  };
  const currentRuns = runs(current), endpoint = currentRuns.at(-1)?.at(-1);
  const hasReadings = [...current, ...reference, ...forecast].some(p => p.v !== null && Number.isFinite(p.v));
  return <div className={cn("wall-metric-chart", SERIES_TONE_CLASS[tone], className)}>{previousTotal ? <div className="wall-metric-reference">{previousTotal.label}</div> : null}{hasReadings ? <svg viewBox="0 0 200 48" preserveAspectRatio="none" role="img" aria-label={`${label}. Solid: current. Dashed: reference.${forecast.length ? " Dashed in series colour: forecast." : ""}`}>
    {previousTotal ? <g data-metric-previous-total><line x1="4" x2="196" y1={y(previousTotal.value)} y2={y(previousTotal.value)} /><title>{previousTotal.label}: {previousTotal.value}</title></g> : null}
    <ChartLine runs={runs(reference)} kind="ghost" /><ChartLine runs={currentRuns} /><ChartLine runs={runs(forecast)} kind="projection" />{currentRuns.filter(run => run.length === 1 && run[0] !== endpoint).map((run, index) => <ChartDot key={index} at={run[0]!} size="sm" halo={false} />)}{endpoint ? <ChartDot at={endpoint} size="sm" halo={false} /> : null}
  </svg> : <span className="wall-metric-empty">History unavailable</span>}<div className="wall-metric-axis"><span>{startLabel}</span><span>{endLabel}</span></div>{forecast.length ? <div className="wall-metric-series-key" data-metric-series-key><span>Current</span><span>Projected</span></div> : null}</div>;
}

export interface SparklineCompareMetricProps extends TileProps, Omit<MetricComparisonChartProps, "label" | "className" | "current" | "startLabel" | "endLabel"> {
  current?: readonly SeriesPointOrGap[];
  startLabel?: string;
  endLabel?: string;
  value?: ReactNode;
  comparison?: ReactNode;
  chart?: ReactNode;
}

export function SparklineCompareMetric({ value, comparison, chart, current = [], reference, forecast, previousTotal, domain, startLabel = "", endLabel = "", tone, ...tile }: SparklineCompareMetricProps) {
  return <MetricTile {...tile}><div className="wall-metric-main"><div className="wall-metric-comparison">{shown(value)}</div>{comparison != null ? <span className="wall-metric-note">{comparison}</span> : null}</div>{chart ?? <MetricComparisonChart current={current} reference={reference} forecast={forecast} previousTotal={previousTotal} domain={domain} startLabel={startLabel} endLabel={endLabel} tone={tone} label={tile.title} />}</MetricTile>;
}

export interface CumulativeCompareMetricProps extends TileProps {
  value: ReactNode;
  qualifier?: ReactNode;
  unit?: ReactNode;
  valueNote?: ReactNode;
  movement?: MetricMovement;
  secondary?: readonly {
    label: string;
    value: ReactNode;
    note?: ReactNode;
    size?: "figure" | "detail";
    labelPosition?: "above" | "below";
    dividerBefore?: boolean;
  }[];
  note?: ReactNode;
  chartProps?: Omit<MetricComparisonChartProps, "label" | "className">;
  chartUnavailable?: ReactNode;
}

/** Facts and observations share one hierarchy at the base and expanded sizes. */
export function CumulativeCompareMetric({ value, qualifier, unit, valueNote, movement, secondary = [], note, chartProps, chartUnavailable, size = "wide", expanded = false, ...tile }: CumulativeCompareMetricProps) {
  const comparison = movement ? <MovementReadout movement={movement} className="wall-cumulative-movement" /> : null;
  return <MetricTile {...tile} expanded={expanded} size={size} className={cn("wall-metric-cumulative", tile.className)}>
    <div className="wall-metric-split" data-cumulative-layout={expanded ? "expanded" : "base"}>
      <div className="wall-metric-summary">
        <div className="wall-cumulative-primary">{qualifier != null ? <div className="wall-metric-note wall-metric-qualifier">{qualifier}</div> : null}<div className="wall-cumulative-total"><strong className="wall-metric-value" data-metric-value>{shown(value)}</strong>{unit != null ? <span className="wall-metric-note">{unit}</span> : null}</div>{valueNote != null ? <div className="wall-metric-note">{valueNote}</div> : null}</div>
        {!expanded ? comparison : null}
        {secondary.length ? <dl className="wall-cumulative-facts">{secondary.map(fact => <div key={fact.label} data-metric-fact={fact.label} data-fact-size={fact.size ?? "figure"} data-label-position={fact.labelPosition ?? "above"} data-fact-divider={fact.dividerBefore || undefined}><dt>{fact.label}</dt><dd>{shown(fact.value)}</dd>{fact.note != null ? <dd className="wall-metric-note">{fact.note}</dd> : null}</div>)}</dl> : null}
        {note != null ? <div className="wall-metric-note wall-cumulative-note">{note}</div> : null}
      </div>
      <div className="wall-metric-plot">
        {expanded ? comparison : null}
        {chartProps ? <MetricComparisonChart {...chartProps} label={tile.title} /> : <span className="wall-metric-empty">{chartUnavailable ?? "History unavailable"}</span>}
      </div>
    </div>
  </MetricTile>;
}
