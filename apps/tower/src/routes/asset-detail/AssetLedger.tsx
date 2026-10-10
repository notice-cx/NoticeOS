import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { LedgerPeriod, LedgerSlice } from "@shared/asset-detail";
import { figureHasMoney } from "@shared/wall";
import { BookingChip, bookingChipState } from "@/components/BookingChip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { SmallMultiple, SmallMultipleStrip } from "@/components/surface/SmallMultiple";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, formatPeriodMonthYear } from "@/lib/format";
import { Panel } from "./shared";

// --- P&L (booked revenue and cost) -----------------------------------------
export function AssetLedger({
  ledger,
}: {
  ledger: LedgerSlice;
  /** Unused: the ledger's age is System health's to say. */
  ledgerRecordedAt?: string | null;
  nowMs?: number;
}) {
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
          All sites →
        </Link>
      }
      count={
        <>
          {/* One marker for the whole strip: the figures are the booked ones;
              where a month also carries an estimate, its own line names it. */}
          {/* One word for the strip: the figures are booked, and a month's
              estimate is named on its own line. */}
          booked
        </>
      }
    >
      {ledger.empty ? (
        <span className="text-xs text-muted-foreground">
          No booked months yet
        </span>
      ) : (
        <div className="flex flex-col gap-4">
          <SmallMultipleStrip columns={3}>
            {ledger.periods.slice(0, 6).map((p) => (
              <PeriodCell key={p.period} period={p} />
            ))}
          </SmallMultipleStrip>

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
                      className="font-mono text-xs text-muted-foreground"
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
 * One accounting month as a small multiple: the month is the eyebrow, the
 * booked net is the figure, and what it is made of is the line under it. The
 * stated net is reconciled rows only; the forecast rides in the secondary
 * line, prefixed with the word, where it cannot be read as part of the number
 * above it. `figureHasMoney` is the same rule the Wall uses, because three
 * zeroes are not a figure.
 */
function PeriodCell({ period }: { period: LedgerPeriod }) {
  const hasBooked = figureHasMoney(period.booked.figure);
  const hasForecast = figureHasMoney(period.forecast.figure);
  return (
    <SmallMultiple
      label={formatPeriodMonthYear(period.period)}
      value={
        hasBooked ? (
          formatMoney(period.booked.figure.net, period.booked.figure.currency, { cents: true })
        ) : (
          // A dash is "nothing reconciled", never zero, said on the dash itself.
          <span title="Nothing reconciled yet">—</span>
        )
      }
      secondary={
        <>
          {hasBooked ? (
            <FamilyLine
              revenue={period.booked.revenueByFamily}
              cost={period.booked.costByFamily}
            />
          ) : null}
          {/* The forecast keeps its own figure and its own word, on the same
              line but never inside the number above: a month can be part
              booked and part estimated, and the two are never summed into one
              net. */}
          {hasForecast ? (
            <span title="Estimated for this month. Not booked, and not in the net above.">
              {hasBooked ? " · " : ""}forecast{" "}
              {formatMoney(period.forecast.figure.net, period.forecast.figure.currency, { cents: true })}
            </span>
          ) : null}
          {!hasBooked && !hasForecast ? "nothing booked" : null}
        </>
      }
      className="[&]:p-3"
    />
  );
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
