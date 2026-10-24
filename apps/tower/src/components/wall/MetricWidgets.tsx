import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { SeriesPointOrGap } from "@shared/surface";
import { ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import { SERIES_TONE_CLASS, type SeriesTone } from "@/components/surface/Sparkline";
import { readingRuns } from "@/lib/chart-path";
import { cn } from "@/lib/utils";
import { useWallMetricBinding } from "./WallMetricEditing";
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
  const { binding, selection, editing, selected, related } = useWallMetricBinding();
  const config = binding?.configured ? binding.tile : undefined;
  title = config?.title ?? title;
  if (config?.icon === false) Icon = undefined;
  size = config?.size ?? size;
  const dragType = selection ? `application/x-noticeos-wall-metric-${encodeURIComponent(selection.widgetId).toLowerCase()}` : "";
  return <section className={cn("wall-metric", className)} data-metric-size={size} data-metric-expanded={expanded || undefined} data-wall-metric={binding?.tile.id} data-wall-asset={binding?.assetId} data-metric-selected={selected || undefined} data-metric-related={related || undefined} data-metric-axes={config?.axes === false ? "hidden" : undefined} data-metric-reference={config?.reference === false ? "hidden" : undefined} style={style} aria-label={title}>
    <h3 className="wall-metric-title">{Icon ? <Icon aria-hidden="true" /> : null}<span>{title}</span>{context != null ? <span className="wall-metric-context">{context}</span> : null}</h3>
    {children}
    {selection && editing ? <button type="button" className="wall-metric-select" data-wall-metric-select={selection.tileId} aria-label={`Edit ${title}${binding?.assetId ? ` for ${binding.assetId}` : ""}`} aria-pressed={selected} disabled={editing.disabled} draggable={!!editing.onReorder && !editing.disabled}
      onDragStart={event => { if (!editing.onReorder || editing.disabled) { event.preventDefault(); return; } event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(dragType, selection.tileId); event.dataTransfer.setData("text/plain", `${selection.widgetId}\n${selection.tileId}`); }}
      onDragOver={event => { if (editing.onReorder && !editing.disabled && event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }}
      onDrop={event => { const source = event.dataTransfer.getData(dragType); if (!editing.onReorder || editing.disabled || !source) return; event.preventDefault(); event.stopPropagation(); if (source !== selection.tileId) editing.onReorder(source, selection.tileId); }}
      onClick={event => { event.stopPropagation(); editing.onSelect(selection); }} /> : null}
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
  const { binding } = useWallMetricBinding();
  if (binding?.configured && binding.tile.reference === false) movement = undefined;
  return <MetricTile {...tile} className={cn("wall-metric-number", tile.className)}>
    <div className="wall-metric-main"><div className="wall-metric-primary">{qualifier != null ? <span className="wall-metric-note wall-metric-qualifier">{qualifier}</span> : null}<strong className="wall-metric-value">{shown(value)}</strong></div>{movement ? <MovementReadout movement={movement} /> : null}</div>
    {history ? <MetricComparisonChart current={history.data} startLabel={history.startLabel} endLabel={history.endLabel} label={`${tile.title} history`} tone={movement?.tone} /> : null}
    {note != null ? <div className="wall-metric-note">{note}</div> : null}
  </MetricTile>;
}

export interface MultiMetricProps extends TileProps {
  primary?: { label: string; value: ReactNode; tone?: SeriesTone };
  metrics: readonly { label: string; value: ReactNode; icon?: LucideIcon; tone?: SeriesTone }[];
  note?: ReactNode;
}

export function MultiMetric({ primary, metrics, note, ...tile }: MultiMetricProps) {
  const { binding } = useWallMetricBinding();
  if (binding?.configured && binding.tile.display === "number" && primary) return <NumberMetric {...tile} value={primary.value} qualifier={primary.label} note={note} />;
  const facts = <dl className="wall-metric-facts" style={{ "--metric-count": Math.max(1, metrics.length) } as CSSProperties}>{metrics.map(({ label, value, icon: Icon, tone }) => <div key={label}><dt>{Icon ? <Icon aria-hidden="true" /> : null}{label}</dt><dd className={tone ? SERIES_TONE_CLASS[tone] : undefined}>{shown(value)}</dd></div>)}</dl>;
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
  const { binding } = useWallMetricBinding();
  if (binding?.configured && binding.tile.display === "number") return <NumberMetric {...tile} value={value} note={recent ? <>{recent.value} {recent.label}</> : undefined} />;
  const readings = bars.map(value => value !== null && Number.isFinite(value) ? value : null);
  const recentCount = Number.isFinite(highlightLast) ? Math.min(bars.length, Math.max(0, Math.floor(highlightLast))) : 0;
  const maximum = Math.max(1, ...readings.filter((v): v is number => v !== null));
  return <MetricTile {...tile}><div className="wall-metric-main"><strong className="wall-metric-value">{shown(value)}</strong>{recent ? <span className="wall-metric-recent"><b>{shown(recent.value)}</b> {recent.label}</span> : null}</div>
    {readings.some(value => value !== null) ? <div className={cn("wall-metric-bars", SERIES_TONE_CLASS[tone])} role="img" aria-label={`${tile.title}: ${readings.length} periods; latest ${recentCount} highlighted. ${readings.filter(v => v === null).length} unavailable.`}>{readings.map((value, index) => <span key={index} data-value={value ?? undefined} data-metric-bar={value === null ? "missing" : index >= readings.length - recentCount ? "recent" : "earlier"} style={{ "--metric-bar-height": value === null ? "0%" : `${Math.max(0, value) / maximum * 100}%` } as CSSProperties} />)}</div> : <span className="wall-metric-empty">History unavailable</span>}
    <div className="wall-metric-axis"><span>{startLabel}</span><span>{endLabel}</span></div>
  </MetricTile>;
}

export interface MetricComparisonChartProps {
  variant?: "line" | "cumulative-bars" | "daily-bars-line";
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

/** All series share dates and scale; unavailable days stay gaps. */
export function MetricComparisonChart({ current, reference = [], forecast = [], previousTotal, domain, startLabel, endLabel, label, tone = "neutral", className, variant = "line" }: MetricComparisonChartProps) {
  const { binding } = useWallMetricBinding();
  if (binding?.configured) label = binding.tile.title ?? label;
  if (binding?.configured && binding.tile.reference === false) { reference = []; previousTotal = undefined; }
  let dates = [...new Set([...current, ...reference, ...forecast].map(p => p.t))].sort();
  if (variant !== "line") {
    const start = Date.parse(domain?.start ?? dates[0] ?? ""), end = Date.parse(domain?.end ?? dates.at(-1) ?? "");
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 366 * 86_400_000) dates = Array.from({ length: Math.floor((end - start) / 86_400_000) + 1 }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
  }
  const values = [...current, ...reference, ...forecast].flatMap(p => p.v !== null && Number.isFinite(p.v) ? [p.v] : []);
  if (previousTotal && Number.isFinite(previousTotal.value)) values.push(previousTotal.value);
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const y = (value: number) => 44 - (value - low) / (high - low) * 40;
  const domainStart = Date.parse(domain?.start ?? dates[0] ?? "");
  const domainEnd = Date.parse(domain?.end ?? dates.at(-1) ?? "");
  const x = (index: number) => variant !== "line" ? 4 + (index + .5) * 192 / Math.max(1, dates.length) : Number.isFinite(domainStart) && domainEnd > domainStart
    ? 4 + (Date.parse(dates[index]!) - domainStart) / (domainEnd - domainStart) * 192
    : dates.length < 2 ? 100 : 4 + index / (dates.length - 1) * 192;
  const runs = (series: readonly SeriesPointOrGap[]) => {
    const byDate = new Map(series.map(point => [point.t, point.v]));
    return readingRuns(dates.map(date => { const value = byDate.get(date); return value != null && Number.isFinite(value) ? value : null; })).map(run => run.map(p => ({ x: x(p.index), y: y(p.value) })));
  };
  const currentRuns = runs(current), endpoint = currentRuns.at(-1)?.at(-1);
  const hasReadings = [...current, ...reference, ...forecast].some(p => p.v !== null && Number.isFinite(p.v));
  const currentByDay = new Map(current.map(point => [point.t.slice(0, 10), point.v]));
  const forecastByDay = new Map(forecast.map(point => [point.t.slice(0, 10), point.v]));
  // A daily count needs adjacent observations; only the period start has a zero baseline.
  const dailyValues = dates.map((date, index) => {
    const value = currentByDay.get(date);
    const previous = index > 0 ? currentByDay.get(dates[index - 1]!) : domain?.start === date ? 0 : null;
    return value != null && Number.isFinite(value) && previous != null && Number.isFinite(previous) && value >= previous ? value - previous : null;
  });
  const bars = dates.map((date, index) => {
    const observed = currentByDay.get(date);
    const projected = forecastByDay.get(date);
    const known = observed != null && Number.isFinite(observed);
    const value = variant === "daily-bars-line" ? dailyValues[index] ?? null : known ? observed : projected != null && Number.isFinite(projected) ? projected : null;
    if (value === null) return <g key={date} data-metric-cumulative-day={variant === "cumulative-bars" ? "missing" : undefined} data-metric-daily-day={variant === "daily-bars-line" ? "missing" : undefined} data-date={date}><title>{date}: unavailable; no bar</title></g>;
    const width = 192 / Math.max(1, dates.length) * .72;
    return <rect key={date} x={x(index) - width / 2} y={Math.min(y(0), y(value)) - (value === 0 ? .5 : 0)} width={width} height={Math.max(.5, Math.abs(y(0) - y(value)))} rx={Math.min(.8, width / 4)} fill={variant === "daily-bars-line" ? "currentColor" : undefined} fillOpacity={variant === "daily-bars-line" ? .3 : undefined} data-metric-daily-bar={variant === "daily-bars-line" ? "current" : undefined} data-metric-cumulative-bar={variant === "cumulative-bars" ? known ? "current" : "forecast" : undefined} data-date={date} data-value={value}><title>{date}: {value} {variant === "daily-bars-line" ? "daily closes observed" : `cumulative${known ? " observed" : " forecast"}`}</title></rect>;
  });
  const description = variant === "daily-bars-line" ? `Bars: daily closes. Solid line: cumulative closes this week. All marks share one count scale from zero. Missing daily readings have no bar.${previousTotal ? " Dashed horizontal line: last week’s total." : ""}` : variant === "cumulative-bars" ? `Daily cumulative bars: total reached by each day. Filled: observed.${forecast.length ? " Outlined: forecast." : ""} Missing days have no bar.${reference.length || previousTotal ? " Dashed: reference." : ""}` : `Solid: current.${reference.length || previousTotal ? " Dashed: reference." : ""}${forecast.length ? " Dashed in series colour: forecast." : ""}`;
  return <div className={cn("wall-metric-chart", SERIES_TONE_CLASS[tone], className)} data-metric-chart={variant}>{previousTotal ? <div className="wall-metric-reference">{previousTotal.label}</div> : null}{hasReadings ? <svg viewBox="0 0 200 48" preserveAspectRatio="none" role="img" aria-label={`${label}. ${description}`}>
    {variant === "cumulative-bars" ? bars : <>{variant === "daily-bars-line" ? bars : null}<ChartLine runs={currentRuns} /><ChartLine runs={runs(forecast)} kind="projection" />{currentRuns.filter(run => run.length === 1 && run[0] !== endpoint).map((run, index) => <ChartDot key={index} at={run[0]!} size="sm" halo={false} />)}{endpoint ? <ChartDot at={endpoint} size="sm" halo={false} /> : null}</>}
    <ChartLine runs={runs(reference)} kind="ghost" />
    {previousTotal ? <g data-metric-previous-total><line x1="4" x2="196" y1={y(previousTotal.value)} y2={y(previousTotal.value)} /><title>{previousTotal.label}: {previousTotal.value}</title></g> : null}
  </svg> : <span className="wall-metric-empty">History unavailable</span>}<div className="wall-metric-axis"><span>{startLabel}</span><span>{endLabel}</span></div>{variant === "daily-bars-line" ? <div className="wall-metric-axis" data-metric-daily-key><span>Bars: daily</span><span>Line: cumulative</span></div> : null}{forecast.length ? <div className="wall-metric-series-key" data-metric-series-key><span>Current</span><span>Projected</span></div> : null}</div>;
}

export interface SparklineCompareMetricProps extends TileProps, Omit<MetricComparisonChartProps, "label" | "className" | "current" | "startLabel" | "endLabel"> {
  primary?: { value: ReactNode; unit?: ReactNode };
  secondary?: ReactNode;
  referenceFact?: { label: ReactNode; value: ReactNode };
  current?: readonly SeriesPointOrGap[];
  startLabel?: string;
  endLabel?: string;
  value?: ReactNode;
  comparison?: ReactNode;
  chart?: ReactNode;
}

export function SparklineCompareMetric({ primary, secondary, referenceFact, value, comparison, chart, current = [], reference, forecast, previousTotal, domain, startLabel = "", endLabel = "", tone, ...tile }: SparklineCompareMetricProps) {
  const { binding } = useWallMetricBinding();
  const context = referenceFact ? <>{referenceFact.label} <b>{shown(referenceFact.value)}</b></> : tile.context;
  if (binding?.configured && binding.tile.display === "number") return <NumberMetric {...tile} context={context} value={primary ? primary.value : value} qualifier={primary?.unit} note={secondary ?? comparison} />;
  return <MetricTile {...tile} context={context}><div className="wall-metric-main">{primary ? <div className="wall-metric-primary"><strong className="wall-metric-value">{shown(primary.value)}</strong>{primary.unit != null ? <span className="wall-metric-note">{primary.unit}</span> : null}</div> : <div className="wall-metric-comparison">{shown(value)}</div>}{secondary != null ? <div className="wall-metric-secondary">{secondary}</div> : comparison != null ? <span className="wall-metric-note">{comparison}</span> : null}</div>{chart ?? <MetricComparisonChart current={current} reference={reference} forecast={forecast} previousTotal={previousTotal} domain={domain} startLabel={startLabel} endLabel={endLabel} tone={tone} label={tile.title} />}</MetricTile>;
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
  const { binding } = useWallMetricBinding();
  if (binding?.configured && binding.tile.reference === false) {
    movement = undefined;
    if (chartProps) chartProps = { ...chartProps, reference: undefined, previousTotal: undefined };
  }
  if (binding?.configured && binding.tile.display === "number") return <NumberMetric {...tile} expanded={expanded} size={size} value={value} qualifier={qualifier} movement={movement} note={<>{valueNote}{note}</>} />;
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
        {chartProps ? <MetricComparisonChart {...chartProps} variant={chartProps.variant ?? "cumulative-bars"} label={tile.title} /> : <span className="wall-metric-empty">{chartUnavailable ?? "History unavailable"}</span>}
      </div>
    </div>
  </MetricTile>;
}
