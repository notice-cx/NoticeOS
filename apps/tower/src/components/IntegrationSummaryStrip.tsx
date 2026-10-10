import { KeyRound } from "lucide-react";
import type { ConnectionKind } from "@shared/connection-status";
import type { SharedCredentialInsight } from "@shared/integrations";
import { siteCount } from "@shared/site-noun";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { cn } from "@/lib/utils";

/** Problems lead, then proven work, then what is still owed. */
const ORDER: ConnectionKind[] = ["failing", "overdue", "unknown", "working", "key-accepted", "collecting", "not-checked", "not-connected", "not-using"];

export interface IntegrationSummaryStripProps {
  /** How many register cells read as each status (`laneStatus`). */
  counts: Partial<Record<ConnectionKind | "not-applicable", number>>;
  /** How many reusable-credential lanes cover sources not set up yet. */
  sharedCredential?: SharedCredentialInsight;
  className?: string;
}

/** The register's totals above its grid: one chip per status with a count. */
export function IntegrationSummaryStrip({ counts, sharedCredential, className }: IntegrationSummaryStripProps) {
  const nonZero = ORDER.filter((kind) => (counts[kind] ?? 0) > 0);
  const shared = sharedCredential && sharedCredential.cells > 0 ? sharedCredential : null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-summary-strip>
      {nonZero.map((kind) => (
        <IntegrationStateChip key={kind} state={kind} count={counts[kind]} subject="register:connections" />
      ))}
      {shared ? (
        <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" data-shared-credentials>
          <KeyRound className="size-3.5 shrink-0" aria-hidden />
          {shared.lanes} {shared.lanes === 1 ? "integration connects" : "integrations connect"} once · {siteCount(shared.cells)} waiting
        </span>
      ) : null}
    </div>
  );
}
