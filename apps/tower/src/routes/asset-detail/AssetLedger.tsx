import { stackRanges } from "@/lib/chart-path";
import { ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { LedgerPeriod, LedgerRollup, LedgerSlice } from "@shared/asset-detail";
import { figureHasMoney } from "@shared/wall";
import { BookingChip, bookingChipState } from "@/components/BookingChip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, formatPeriodMonthYear, formatSignedMoney } from "@/lib/format";
import { chartSources, ledgerChartSource, totalSources, type MoneyChartSource } from "@/lib/money-chart";
import { costSourceLabel } from "@/routes/financials/cost-comparison";
import { cn } from "@/lib/utils";
import { Panel } from "./shared";

// --- P&L (booked revenue and cost) -----------------------------------------
type AccountingBar = ReturnType<typeof accountingBar>;

function accountingBar(period: LedgerPeriod, kind: "revenue" | "cost", currency: string | null) {
  const parts = (rollup: LedgerRollup, forecast: boolean) => {
    if (currency === null || !figureHasMoney(rollup.figure) || rollup.figure.currency !== currency) return [];
    if (!rollup.sourceLines) return [{ source: totalSources[kind], amount: rollup.figure[kind] ?? 0, forecast }];
    const bySource = new Map<string, { source: MoneyChartSource; amount: number; forecast: boolean }>();
    for (const line of rollup.sourceLines) {
      if (line.kind !== kind || line.currency !== currency) continue;
      const source = ledgerChartSource(line, kind === "cost" ? costSourceLabel(line.source, []) : null);
      bySource.set(source.id, { source, amount: (bySource.get(source.id)?.amount ?? 0) + line.amount, forecast });
    }
    return [...bySource.values()].sort((a, b) => a.source.id.localeCompare(b.source.id));
  };
  const readings = [...parts(period.booked, false), ...parts(period.forecast, true)];
  return stackRanges(readings.map(reading => reading.amount)).flatMap((range, index) => (
    range && range.from !== range.to ? [{ ...range, ...readings[index]! }] : []
  ));
}

export function AssetLedger({
  ledger,
}: {
  ledger: LedgerSlice;
  /** Unused: the ledger's age is System health's to say. */
  ledgerRecordedAt?: string | null;
  nowMs?: number;
}) {
  const months = ledger.periods.slice(0, 6);
  const bars = months.map(period => ({
    revenue: accountingBar(period, "revenue", ledger.currency),
    cost: accountingBar(period, "cost", ledger.currency),
  }));
  const segments = bars.flatMap(bar => [...bar.revenue, ...bar.cost]);
  const sources = chartSources(segments.map(segment => segment.source));
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const values = segments.map(segment => segment.to);
  const top = Math.max(1, ...values);
  const bottom = Math.min(0, ...values);
  const at = (value: number) => (value - bottom) / (top - bottom) * 100;
  return (
    <Panel
      title="Monthly accounting"
      /* The way to the portfolio view, in the header's "All →" slot: the
         comparison across assets and the shared costs live on /financials. */
      action={
        <Link
          to="/financials"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-sm:-my-2.5 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
        >
          All assets →
        </Link>
      }
      // One word for the rows: the figures are booked, and a month's
      // estimate is named on its own line.
      count="booked"
    >
      {ledger.empty ? (
        <span className="text-xs text-muted-foreground">
          No booked months yet
        </span>
      ) : (
        <div className="@container flex flex-col gap-4">
          {sources.length ? <div className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted-foreground" aria-label="Accounting chart key">
            {sources.map(source => <span key={source.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("h-1.5 w-3 rounded-full bg-current", source.tone)} />{source.name}
            </span>)}
            {segments.some(segment => segment.forecast) ? <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-1.5 w-3 rounded-full border border-dashed border-muted-foreground/70" />forecast
            </span> : null}
          </div> : null}
          <ul className="m-0 flex list-none flex-col p-0" aria-label="Accounting months">
            {months.map((period, index) => {
              const month = bars[index]!;
              return <MonthRow key={period.period} period={period} index={index} bars={ledger.currency === null ? null : <>
                <Bar kind="Revenue" currency={ledger.currency} segments={month.revenue} sourceById={sourceById} at={at} />
                <Bar kind="Cost" currency={ledger.currency} segments={month.cost} sourceById={sourceById} at={at} />
              </>} />;
            })}
          </ul>

          {/* The months are the answer; the rows behind them are the audit
              trail, one press away. */}
          <details className="group flex flex-col gap-2">
            {/* The summary keeps the press target and its ring; the header
                inside it is the vocabulary's. */}
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground max-sm:min-h-11 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 group-open:rotate-90 motion-safe:transition-transform"
              />
              <SectionLabel title="Recent entries" caption={ledger.recentRows.length} />
            </summary>
            {/* `stacked`: six columns of a ledger entry would run past a 390px
                screen, with Amount, Booking and the source reference off the
                right edge. */}
            <Table stacked>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Family</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Booking</TableHead>
                  <TableHead>Source / ref</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.recentRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell label="Period" className="tabular-nums">{r.period}</TableCell>
                    <TableCell label="Kind" className="capitalize text-muted-foreground">
                      {r.kind}
                    </TableCell>
                    <TableCell label="Family">{r.family}</TableCell>
                    <TableCell label="Amount" className="text-right tabular-nums">
                      {formatMoney(r.amount, r.currency, { cents: true })}
                    </TableCell>
                    <TableCell label="Booking">
                      <BookingChip state={bookingChipState(r.bookingState)} subject={`ledger:${r.id}`} />
                    </TableCell>
                    <TableCell
                      label="Source / ref"
                      className="break-all font-mono text-xs text-muted-foreground"
                    >
                      {r.source ?? r.ref ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </div>
      )}
    </Panel>
  );
}

/**
 * One accounting month: its name, its revenue and its cost as two bars on the
 * panel's ruler, the booked net at the end and what it is made of under it.
 * The stated net is reconciled rows only; the forecast extends each bar as a
 * dashed run and keeps its own figure, prefixed with the word, where it cannot
 * be read as part of the net. `figureHasMoney` is the same rule the Wall
 * uses, because three zeroes are not a figure.
 */
function MonthRow({ period, bars, index }: { period: LedgerPeriod; bars: React.ReactNode; index: number }) {
  const booked = period.booked.figure;
  const forecast = period.forecast.figure;
  const hasBooked = figureHasMoney(booked);
  const hasForecast = figureHasMoney(forecast);
  return (
    <li
      className="viz-arrive grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-1.5 border-b border-border/40 py-3 last:border-b-0 @2xl:grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)_14rem]"
      style={{ "--viz-i": index } as CSSProperties}
      data-ledger-month={period.period}
    >
      <span className="text-sm font-medium text-foreground">{formatPeriodMonthYear(period.period)}</span>
      <span className="col-span-2 row-start-2 flex min-w-0 flex-col gap-1 @2xl:col-span-1 @2xl:row-start-auto">
        {bars}
      </span>
      <span className="col-start-2 row-start-1 flex flex-col items-end gap-0.5 text-end tabular-nums @2xl:col-start-auto @2xl:row-start-auto">
        <span className={cn("text-figure-sm", hasBooked && (booked.net ?? 0) < 0 ? "text-muted-foreground" : "text-foreground")}>
          {hasBooked ? (
            formatSignedMoney(booked.net, booked.currency, { cents: true })
          ) : (
            // A dash is "nothing reconciled", never zero, said on the dash itself.
            <span title="Nothing reconciled yet">—</span>
          )}
        </span>
        <span className="text-micro text-muted-foreground">
          {hasBooked ? <FamilyLine revenue={period.booked.revenueByFamily} cost={period.booked.costByFamily} /> : null}
          {/* The forecast keeps its own figure and its own word, on the
              same line but never inside the number above: a month can be
              part booked and part estimated, and the two are never summed. */}
          {hasForecast ? (
            <span title="Estimated for this month. Not booked, and not in the net above.">
              {hasBooked ? " · " : ""}forecast{" "}
              {formatMoney(forecast.net, forecast.currency, { cents: true })}
            </span>
          ) : null}
          {!hasBooked && !hasForecast ? "nothing booked" : null}
        </span>
      </span>
    </li>
  );
}

function Bar({ kind, currency, segments, sourceById, at }: {
  kind: string;
  currency: string;
  segments: AccountingBar;
  sourceById: ReadonlyMap<string, MoneyChartSource>;
  at: (value: number) => number;
}) {
  const describe = (segment: AccountingBar[number]) => {
    const name = sourceById.get(segment.source.id)?.name ?? segment.source.name;
    return `${name} ${formatMoney(segment.amount, currency, { cents: true })}${segment.forecast ? " forecast" : ""}`;
  };
  return <span
    role={segments.length ? "img" : undefined}
    aria-label={segments.length ? [kind, ...segments.map(describe)].join(" · ") : undefined}
    aria-hidden={!segments.length || undefined}
    className="relative block h-2 rounded-full bg-viz-track">
    {segments.map(segment => (
      <span
        key={`${segment.source.id}-${segment.forecast}`}
        data-ledger-source={segment.source.id}
        title={describe(segment)}
        className={cn("absolute inset-y-0 rounded-xs",
          sourceById.get(segment.source.id)?.tone, segment.forecast ? "border border-dashed border-current bg-current/20" : "bg-current")}
        style={{ insetInlineStart: `${at(Math.min(segment.from, segment.to))}%`, width: `${Math.abs(at(segment.to) - at(segment.from))}%` }}
      />
    ))}
    {at(0) > 0 ? <span aria-hidden className="pointer-events-none absolute inset-y-0 border-s border-muted-foreground"
      style={{ insetInlineStart: `${at(0)}%` }} /> : null}
  </span>;
}

/** What a booked net is made of, in one line: the families that actually carry
 * money, revenue first. A family list of nothing renders nothing rather than an
 * em dash, because the figure above has already said there is none. */
function FamilyLine({
  revenue,
  cost,
}: {
  revenue: { family: string; amount: number; currency: string }[];
  cost: { family: string; amount: number; currency: string }[];
}) {
  const parts = [
    ...revenue.map((f) => `${f.family} ${formatMoney(f.amount, f.currency, { cents: true })}`),
    ...cost.map((f) => `costs ${f.family} ${formatMoney(f.amount, f.currency, { cents: true })}`),
  ];
  return <>{parts.join(" · ")}</>;
}
