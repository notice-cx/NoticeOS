import { Link } from "react-router-dom";
import type { FinancialsPayload } from "@shared/financials";
import type { ViewId } from "@shared/views";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import type { SiteMoneyRow } from "@/lib/money-page";
import { MONEY_VIEW_CONTEXT } from "./view-money";

export function MoneyViewContext({ data, rows, view }: { data: FinancialsPayload; rows: readonly SiteMoneyRow[]; view: ViewId }) {
  const comparisons = rows.filter((row) => row.change !== null);
  const reported = rows.filter((row) => row.property.revenueReported);
  const netKnown = reported.filter((row) => row.property.figure.net !== null);
  const partialDays = data.dailyRevenue?.coverage.filter((day) => day.missingAssets.length > 0).length;
  const title = MONEY_VIEW_CONTEXT[view].title;
  const metrics = view === "growth" ? [
    { label: "Comparable assets", value: `${comparisons.length} / ${rows.length}`, caption: "prior month or current revenue pace" },
    { label: "Revenue increasing", value: comparisons.filter((row) => row.change!.percent > 0).length, caption: "among comparable assets" },
    { label: "Revenue decreasing", value: comparisons.filter((row) => row.change!.percent < 0).length, caption: "among comparable assets" },
  ] : view === "delivery" ? [
    { label: "Assets with direct cost", value: rows.filter((row) => row.property.figure.cost !== null && row.property.figure.cost > 0).length, caption: "shared overhead stays separate" },
    { label: "Metered cost groups", value: data.costLines.filter((line) => line.provenance === "metered").length, caption: "recorded spending groups" },
    { label: "Declared cost groups", value: data.costLines.filter((line) => line.provenance === "stated" || line.provenance === "amortized").length, caption: "stated or amortized costs" },
  ] : view === "reliability" ? [
    { label: "Revenue reported", value: `${reported.length} / ${rows.length}`, caption: "assets listed in this ledger month" },
    { label: "Missing revenue reports", value: rows.length - reported.length, caption: "missing is distinct from zero earned" },
    { label: "Partial daily coverage", value: partialDays ?? "—", caption: partialDays === undefined ? "daily coverage is unavailable" : "recorded days missing an asset report" },
  ] : [
    { label: "Positive asset net", value: netKnown.filter((row) => row.property.figure.net! > 0).length, caption: "among assets reporting revenue" },
    { label: "Negative asset net", value: netKnown.filter((row) => row.property.figure.net! < 0).length, caption: "direct costs only" },
    { label: "Revenue sources", value: data.revenueLines?.length ?? "—", caption: data.revenueLines ? "source and currency groups" : "source breakdown is unavailable" },
  ];
  return (
    <section aria-label={title} data-money-view={view} className="overflow-hidden rounded-xl bg-card ring-1 ring-border/70">
      <SectionLabel title={title} caption="Selected ledger month" className="px-5 pt-4 pb-3" />
      <KpiStrip columns={3}>
        {metrics.map((metric) => <Kpi key={metric.label} {...metric} />)}
      </KpiStrip>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs text-muted-foreground">
        <span>{view === "growth" ? "Revenue movement does not establish channel attribution." : view === "delivery" ? "Costs are attributed only where the ledger records an asset." : view === "reliability" ? "Coverage describes stored reports for the selected month." : "Asset net excludes unallocated overhead."}</span>
        <Link className="inline-flex min-h-9 items-center underline underline-offset-4" to={view === "reliability" ? "/health" : view === "delivery" ? "/agents" : "/assets"}>{view === "reliability" ? "Inspect source health" : view === "delivery" ? "Inspect recorded agent work" : "Compare assets"}</Link>
      </div>
    </section>
  );
}
