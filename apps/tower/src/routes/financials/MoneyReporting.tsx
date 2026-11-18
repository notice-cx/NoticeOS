import type { FinancialsPayload } from "@shared/financials";
import type { SiteMoneyRow } from "@/lib/money-page";

export function MoneyReporting({ data, rows }: { data: FinancialsPayload; rows: readonly SiteMoneyRow[] }) {
  const comparisons = rows.flatMap((row) => row.change ? [row.change.percent] : []);
  const reported = rows.filter((row) => row.property.revenueReported);
  const net = rows.flatMap((row) => row.property.figure.net === null ? [] : [row.property.figure.net]);
  const partialDays = data.dailyRevenue?.coverage.filter((day) => day.missingAssets.length > 0).length;
  const facts = [
    { label: "Revenue reports", value: `${reported.length} of ${rows.length} assets · ${rows.length - reported.length} missing` },
    { label: "Incomplete daily reports", value: partialDays === undefined ? "Unavailable" : String(partialDays) },
    { label: "Revenue comparisons", value: `${comparisons.length} of ${rows.length} assets · ${comparisons.filter((value) => value > 0).length} increasing · ${comparisons.filter((value) => value < 0).length} decreasing` },
    { label: "Asset net", value: net.length === 0 ? "Unavailable" : `${net.filter((value) => value > 0).length} positive · ${net.filter((value) => value < 0).length} negative` },
    { label: "Revenue source groups", value: data.revenueLines?.length ?? "Unavailable" },
    { label: "Assets with direct costs", value: rows.filter((row) => (row.property.figure.cost ?? 0) > 0).length },
    { label: "Recorded cost groups", value: `${data.costLines.filter((line) => line.provenance === "metered").length} metered · ${data.costLines.filter((line) => line.provenance === "stated" || line.provenance === "amortized").length} declared` },
  ];
  return (
    <dl className="m-0 grid gap-4 px-5 py-3 sm:grid-cols-2">
      {facts.map(({ label, value }) => (
        <div key={label} className="text-sm">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="m-0 mt-1 tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
