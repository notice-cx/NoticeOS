import { Link } from "react-router-dom";
import { humanizeMetric } from "@shared/alert-language";
import type { AttentionItem } from "@shared/wall";
import type { ViewId } from "@shared/views";
import { useView } from "@/hooks/useView";
import { alertNormal } from "@/lib/alerts-board";
import { formatInt, formatTimestamp } from "@/lib/format";

type AlertFacts = Pick<AttentionItem, "ruleId" | "ruleInputs" | "metric" | "correlatedChanges" | "firedAt" | "readings"> & Partial<Pick<AttentionItem, "handoffBeads">>;

export function alertViewDetail(flag: AlertFacts, view: ViewId): { detail: string; label: string; tab: string } | null {
  const normal = alertNormal(flag);
  const metric = flag.metric ?? (typeof flag.ruleInputs?.metric === "string" ? flag.ruleInputs.metric : null);
  const reading = normal ? `${normal.label}: ${(normal.format ?? formatInt)(normal.value)}` : null;
  switch (view) {
    case "overview": return null;
    case "growth": return {
      detail: reading ?? (metric ? `Recorded signal: ${humanizeMetric(metric)}. No comparison reading is attached.` : "No acquisition or conversion measurement is attached to this alert."),
      label: "Inspect growth evidence", tab: "growth",
    };
    case "revenue": return {
      detail: metric && /(?:revenue|cost|profit|earnings|mrr|arr|rpm|net)/i.test(metric) && reading ? reading : "Financial impact is unmeasured for this alert. Review the asset’s recorded income and costs.",
      label: "Inspect financial evidence", tab: "financials",
    };
    case "delivery": return {
      detail: `${formatInt(flag.correlatedChanges.length)} changes recorded before onset${flag.handoffBeads === undefined ? "; linked task coverage unavailable" : ` · ${formatInt(flag.handoffBeads.length)} linked tasks`}. Changes alone do not establish a cause.`,
      label: "Inspect changes", tab: "#timeline",
    };
    case "reliability": return {
      detail: `${reading ? `${reading} · ` : ""}Last recorded firing ${formatTimestamp(flag.firedAt)}${flag.readings ? ` · ${formatInt(flag.readings.length)} stored readings` : " · reading history unavailable"}.`,
      label: "Inspect source health", tab: "sources",
    };
  }
}

export function AlertViewContext({ flag, assetId, compact = false }: { flag: AlertFacts; assetId: string | null; compact?: boolean }) {
  const { choice } = useView();
  const context = alertViewDetail(flag, choice.view);
  if (!context) return null;
  const path = assetId ? `/assets/${encodeURIComponent(assetId)}` : null;
  const to = path && (context.tab.startsWith("#") ? `${path}${context.tab}` : `${path}/${context.tab}`);
  return (
    <span className="block text-xs leading-relaxed text-muted-foreground" data-alert-view={choice.view}>
      {context.detail}
      {!compact && to ? <> <Link className="inline-flex min-h-9 items-center underline underline-offset-4" to={to}>{context.label}</Link></> : null}
    </span>
  );
}
