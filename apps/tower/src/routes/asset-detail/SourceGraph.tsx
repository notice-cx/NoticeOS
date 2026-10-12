import type { AssetIntegrations } from "@shared/integrations";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { FlowGraph } from "@/components/viz/FlowGraph";
import { useConnections } from "@/hooks/useConnections";
import { siteHealthRow, sourceColumns } from "@/lib/viz-adapters";
import { cn } from "@/lib/utils";
import { siteSourceGraph } from "@/routes/asset-detail/source-graph";

/**
 * Where this site's numbers come from, as a picture: every source it uses
 * feeding the site, each in the state Home's grid gives the same source, a
 * failing one lit and its edge broken where it sits. The rows under it are
 * where each one is connected or fixed.
 */
export function SourceGraph({
  asset,
  integrations,
  nowMs,
}: {
  asset: { id: string; displayName: string };
  integrations: AssetIntegrations;
  nowMs: number;
}) {
  const connections = useConnections();
  const card = { id: asset.id, displayName: asset.displayName, dataSources: integrations.sources };
  const graph = siteSourceGraph(siteHealthRow(card, connections, nowMs), sourceColumns([card]), { id: asset.id, name: asset.displayName });
  if (graph.nodes.length < 2) return null;
  return (
    <section aria-label="How this site's data arrives" data-source-graph="" className="rounded-xl bg-card px-5 pb-4 pt-4 ring-1 ring-border/70">
      <h2 className={cn("m-0 pb-3", eyebrowClass)}>How the data arrives</h2>
      {/* Dense: each node's state is its glyph and ink, so the word stays on
          the source's own row below, its one status on this screen. */}
      <FlowGraph
        nodes={graph.nodes}
        edges={graph.edges}
        nowMs={nowMs}
        dense
        ariaLabel={`${asset.displayName}'s data sources, each feeding the site`}
      />
      {graph.notConnected.length > 0 ? (
        <p className="m-0 mt-3 text-xs text-muted-foreground" data-source-graph-not-connected="">
          Not connected: {graph.notConnected.join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
