import { useDemoReadonly } from '@/lib/browser-context';
import { showsNightlyReport } from "@noticeos/contract/reporting";
import type { AssetInfo } from "@shared/asset-detail";
import { sourceReadings } from "@shared/connection-status";
import { type AssetIntegrations } from "@shared/integrations";
import { CADENCE_HOURS } from "@shared/wall";
import { AgeBadge, NoNightlyReport } from "@/components/AgeBadge";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { PageHeader } from "@/components/PageHeader";
import { useConnections } from "@/hooks/useConnections";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { StateChip } from "@/components/StateChip";
import { siteHealth } from "@/lib/site-health";
import { useSiteIssues } from "@/hooks/useSiteIssues";
import { Badge } from "@/components/ui/badge";
import { openAlertsLabel } from "@/lib/severity";
import { RangeSelector } from "@/components/surface/RangeSelector";
import { RANGES, useRange, type RangeDays } from "@/routes/asset-detail/useRange";

// --- header ----------------------------------------------------------------
/** Identity and each source's status. Manual lifecycle belongs in Settings;
 * the date control is offered only on the tabs whose charts follow it.
 *
 * THE SOURCES ARE THE WALL CARD'S MARKS, not a word of their own (bead
 * `ro-ujb9.96.7.16`). A one-word verdict ("Receiving data") was a second
 * derivation from the 15-minute runs, and it read green while a source's Data
 * sources row read Failing. The marks read each source through the same model
 * as that row, so the header, Home, the Wall and Integrations agree. */
export function Header({
  asset,
  integrations,
  pulseReceivedAt,
  nowMs,
  lastGood,
  showRange = true,
  rangeLabel = "Traffic period",
}: {
  asset: AssetInfo;
  integrations: AssetIntegrations;
  pulseReceivedAt: string | null;
  nowMs: number;
  lastGood: boolean;
  showRange?: boolean;
  rangeLabel?: string;
}) {
  const demoReadonly = useDemoReadonly();
  const { days, setDays } = useRange();
  const { credentials, items } = useConnections();
  const sources = sourceReadings(asset.id, integrations.sources, { credentials, items }, nowMs);
  const verdict = siteHealth(asset, useSiteIssues());
  // The identity row IS the heading (doc 14: one representation per fact) —
  // the page header renders it inside its `h1` rather than repeating the name
  // above a separate identity strip.
  return (
    <PageHeader
      breadcrumb={[{ label: "Sites", to: "/assets" }]}
      documentTitle={asset.displayName}
      title={
        <>
          <PropertyFavicon
            domain={asset.domain || asset.id}
            displayName={asset.displayName}
            className="size-7"
          />
          {asset.displayName}
          {/* THE VERDICT (D44, doc 21 § Asset · Overview): one word from the
              one derivation Home's sites strip reads (`siteHealth`), in place
              of the bare severity dot — the word says what the dot meant and
              more (Setting up, Monitor only), and its hover keeps the count. */}
          <StateChip
            label={verdict.word}
            tone={verdict.tone}
            subject={`asset:${asset.id}`}
            title={asset.openError + asset.openWarn > 0 ? openAlertsLabel(asset.openError, asset.openWarn) : undefined}
            className="ms-1 align-middle text-xs font-medium normal-case tracking-normal"
          />
          {asset.domain && demoReadonly ? <span className="font-mono text-sm font-normal text-muted-foreground">{asset.domain}</span> : asset.domain ? (
            <a
              href={`https://${asset.domain}`}
              target="_blank"
              rel="noreferrer"
              // The target is CLAIMED rather than added (bead `ro-md80`, the
              // pattern `OwnerChip` uses): the negative margin gives the height
              // back to the header row while the box keeps the thumb floor.
              className="font-mono text-sm font-normal text-muted-foreground underline-offset-4 hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
            >
              {asset.domain}
            </a>
          ) : null}
          {asset.isOs ? (
            <Badge variant="secondary" title="NoticeOS monitoring itself.">
              System
            </Badge>
          ) : null}
          {/* No automation chip (bead `ro-ujb9.135`): "Monitor only" is every
              new site's default and named a concept nothing on this page
              uses. The site's Settings → Automation holds it. */}
        </>
      }
      actions={
        <>
          {/* Beside the heading rather than inside it, so the page's name stays
              the asset's name and each mark keeps its own accessible name. */}
          <DataSourceIcons sources={sources} className="me-1" />
          {/* No report expected — none ever sent (D29 amended, bead
              `ro-ujb9.121`) or declared away (`ro-ujb9.96.8`) — is the Wall
              card's neutral mark, not an amber "never": nothing is owed. */}
          {!showsNightlyReport(asset.noNightlyReport === true, pulseReceivedAt, nowMs) ? (
            <NoNightlyReport />
          ) : (
            <span className="inline-flex items-center gap-2 whitespace-nowrap" data-nightly-report-age>
              <span className="text-xs text-muted-foreground">Nightly report</span>
              <AgeBadge
                iso={pulseReceivedAt}
                cadenceHours={CADENCE_HOURS.pulse}
                nowMs={nowMs}
                lastGood={lastGood}
              />
            </span>
          )}
          {showRange ? <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{rangeLabel}</span>
            <RangeSelector
              label={rangeLabel}
              value={days}
              options={RANGES}
              onChange={(next) => setDays(next as RangeDays)}
            />
          </div> : null}
        </>
      }
    />
  );
}
