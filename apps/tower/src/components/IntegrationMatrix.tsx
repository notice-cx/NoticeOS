import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import type {
  IntegrationAssetRef,
  IntegrationCatalogRow,
  IntegrationCellBase,
  IntegrationLayer,
  IntegrationsMatrix,
} from "@shared/integrations";
import { INTEGRATION_LAYERS, collectionCadenceHours, integrationLabel, unusedWithoutConnectPath } from "@shared/integrations";
import { laneFacts } from "@shared/lane-facts";
import { registerKind, type ConnectionKind } from "@shared/connection-status";
import { EmptyState } from "@/components/EmptyState";
import { EvidencePopover } from "@/components/EvidencePopover";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface IntegrationMatrixProps {
  matrix: IntegrationsMatrix;
  nowMs: number;
  /** Each cell's status in the connection vocabulary (`laneStatus`), so a cell
   * reads exactly what the asset's Data sources row and the provider's page
   * read. Without it a cell reads its register state alone. */
  statusOf?: (cell: IntegrationCellBase) => CellKind;
  className?: string;
}

type CellKind = ConnectionKind | "not-applicable";

/**
 * The portfolio integration register as a grid: rows are lanes, columns are
 * assets, cells the effective state. Not-applicable cells are a muted dash.
 * Declared cells link to the asset's integrations section; derived cells have
 * nothing to edit and do not link. Rows group by layer, OS → provider →
 * property, because an OS connection failing explains every row under it;
 * within a layer the derived lanes lead, then the catalog in file order.
 */
export function IntegrationMatrix({ matrix, nowMs, statusOf, className }: IntegrationMatrixProps) {
  const kindOf = statusOf ?? ((cell: IntegrationCellBase) => registerKind(cell, nowMs));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { catalog, derivedLanes, assets, cells } = matrix;
  const lanes: MatrixLane[] = [
    ...derivedLanes.map((row) => ({
      lane: row.catalog,
      cellFor: (assetId: string) => row.cells[assetId],
    })),
    ...catalog.map((lane, index) => ({
      lane,
      cellFor: (assetId: string) => cells[assetId]?.[index],
    }))
      // A source nothing on Integrations connects gets no row while no site
      // uses it: Not connected with no way to connect is a dead end.
      .filter(({ cellFor }) => {
        const laneCells = assets.flatMap((asset) => cellFor(asset.id) ?? []);
        return !(laneCells.some(unusedWithoutConnectPath)
          && laneCells.every((cell) => unusedWithoutConnectPath(cell) || cell.effective === "not-applicable"));
      }),
  ];
  // An empty layer renders nothing: a heading over no rows says nothing.
  const layers = INTEGRATION_LAYERS.map((layer) => ({
    layer,
    lanes: lanes.filter((entry) => entry.lane.layer === layer),
  })).filter((group) => group.lanes.length > 0);

  function toggle(laneId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  }

  if (assets.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        hint="Add a site to see its sources."
      />
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-col gap-2 md:hidden">
        {assets.map((asset) => (
          <PropertySources
            key={asset.id}
            asset={asset}
            lanes={lanes}
            openLanes={expanded}
            onToggleLane={toggle}
            nowMs={nowMs}
            kindOf={kindOf}
            defaultOpen={
              asset.id ===
              (assets.find((candidate) => !candidate.isOs)?.id ?? assets[0]?.id)
            }
          />
        ))}
      </div>
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            {/* "Connection", not "Data source": the first row is the OS's own
                uplink, a dependency rather than a source. */}
            <TableHead className="sticky left-0 z-10 bg-background">
              Connection
            </TableHead>
            {assets.map((a) => (
              <TableHead key={a.id} className="whitespace-nowrap text-center">
                {/* The asset's name is its single label; the db display_name
                    already identifies the System asset, so no second marker. */}
                <span className="text-foreground">{a.displayName}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        {/* One tbody per layer — the grouping is table structure, not a styled
            row, so the heading is a `th scope="rowgroup"` a screen reader reads
            as the group it heads. */}
        {layers.map((group) => (
          <TableBody key={group.layer}>
            <LayerHeadingRow layer={group.layer} span={assets.length + 1} />
            {group.lanes.map(({ lane, cellFor }) => (
              <LaneRow
                key={lane.id}
                lane={lane}
                assets={assets}
                cellFor={cellFor}
                open={expanded.has(lane.id)}
                onToggle={toggle}
                nowMs={nowMs}
                kindOf={kindOf}
              />
            ))}
          </TableBody>
        ))}
      </Table>
    </div>
  );
}

interface MatrixLane {
  lane: IntegrationCatalogRow;
  cellFor: (assetId: string) => IntegrationCellBase | undefined;
}

/** What each layer is, in the operator's words: the grouping itself says whose
 * failure the rows below it report, read top down. */
const LAYER_HEADINGS: Record<IntegrationLayer, string> = {
  os: "The OS itself",
  provider: "Provider accounts",
  property: "The site's own wiring",
};

function LayerHeadingRow({ layer, span }: { layer: IntegrationLayer; span: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableHead scope="rowgroup" colSpan={span} className="bg-muted/40 text-foreground">
        {LAYER_HEADINGS[layer]}
      </TableHead>
    </TableRow>
  );
}

const MOBILE_STATE_ORDER: Record<CellKind, number> = {
  failing: 0, overdue: 1, unknown: 2, "not-checked": 3, "not-connected": 4, collecting: 5,
  "key-accepted": 6, working: 7, "not-using": 8, "not-applicable": 9,
};

function PropertySources({
  asset,
  lanes,
  openLanes,
  onToggleLane,
  nowMs,
  kindOf,
  defaultOpen,
}: {
  asset: IntegrationAssetRef;
  lanes: MatrixLane[];
  openLanes: Set<string>;
  onToggleLane: (laneId: string) => void;
  nowMs: number;
  kindOf: (cell: IntegrationCellBase) => CellKind;
  defaultOpen: boolean;
}) {
  const [propertyOpen, setPropertyOpen] = useState(defaultOpen);
  const applicable = lanes
    .flatMap(({ lane, cellFor }) => {
      const cell = cellFor(asset.id);
      const kind = cell ? kindOf(cell) : "not-applicable";
      return cell && kind !== "not-applicable" ? [{ lane, cell, kind }] : [];
    })
    .sort((left, right) => MOBILE_STATE_ORDER[left.kind] - MOBILE_STATE_ORDER[right.kind]);
  const tally = (kind: CellKind) => applicable.filter((entry) => entry.kind === kind).length;
  const summary = ([["failing", "failing"], ["working", "working"], ["not-connected", "not connected"]] as const)
    .filter(([kind]) => tally(kind) > 0).map(([kind, word]) => `${tally(kind)} ${word}`).join(" · ");

  return (
    <details
      className="rounded-lg border border-border bg-background/40"
      open={propertyOpen}
      onToggle={(event) => setPropertyOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none p-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <span className="font-medium text-foreground">
            {asset.displayName}
          </span>
          <span className="text-right text-xs tabular-nums text-muted-foreground">
            {summary}
          </span>
        </div>
      </summary>
      <div className="border-t border-border">
        {applicable.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No data sources apply yet.
          </p>
        ) : (
          applicable.map(({ lane, cell, kind }) => {
            const open = openLanes.has(lane.id);
            return (
              <div
                key={lane.id}
                className="border-b border-border last:border-b-0"
              >
                {/* The padding sits in the targets, not the wrapper, so each
                    target fills the 44px row without adding height. */}
                <div className="flex items-stretch justify-between gap-2 px-3">
                  <button
                    type="button"
                    onClick={() => onToggleLane(lane.id)}
                    aria-expanded={open}
                    title={lane.label}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-1 py-2 text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {open ? (
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <ChevronRight
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0">{shortLaneLabel(lane)}</span>
                  </button>
                  <MatrixCell
                    cell={cell}
                    kind={kind}
                    laneLabel={lane.label}
                    derived={lane.derived}
                    nowMs={nowMs}
                  />
                </div>
                {open ? (
                  <div className="border-t border-border bg-muted/20 px-3 py-2">
                    <LaneExplainer lane={lane} />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}

function LaneRow({
  lane,
  assets,
  cellFor,
  open,
  onToggle,
  nowMs,
  kindOf,
}: {
  lane: IntegrationCatalogRow;
  assets: IntegrationAssetRef[];
  cellFor: (assetId: string) => IntegrationCellBase | undefined;
  open: boolean;
  onToggle: (laneId: string) => void;
  nowMs: number;
  kindOf: (cell: IntegrationCellBase) => CellKind;
}) {
  return (
    <Fragment>
      <TableRow>
        <TableCell className="sticky left-0 z-10 bg-background">
          <button
            type="button"
            onClick={() => onToggle(lane.id)}
            aria-expanded={open}
            title={lane.label}
            className="flex items-center gap-1 text-left text-sm font-medium text-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            {shortLaneLabel(lane)}
          </button>
        </TableCell>
        {assets.map((a) => (
          <TableCell key={a.id} className="text-center">
            <MatrixCell
              cell={cellFor(a.id)}
              kind={(() => { const cell = cellFor(a.id); return cell ? kindOf(cell) : "not-applicable"; })()}
              laneLabel={lane.label}
              derived={lane.derived}
              nowMs={nowMs}
            />
          </TableCell>
        ))}
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={assets.length + 1} className="bg-muted/30">
            <LaneExplainer lane={lane} />
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

function MatrixCell({
  cell,
  kind,
  laneLabel,
  derived,
  nowMs,
}: {
  cell: IntegrationCellBase | undefined;
  kind: CellKind;
  laneLabel: string;
  derived: boolean;
  nowMs: number;
}) {
  if (!cell) return <span className="text-muted-foreground/50">—</span>;

  // Not-applicable: visually quiet (a muted dash) so it never competes with the
  // states that actually want the operator's eye.
  if (kind === "not-applicable") {
    return (
      <span aria-label="Doesn't apply" className="text-sm text-muted-foreground/40">
        —
      </span>
    );
  }

  // The `max-md:` half of every rule below is the phone accordion's alone (the
  // matrix table is `hidden md:table`), so a thumb target never loosens the
  // desk grid. The chip keeps its drawn size; the box around it grows.
  return (
    <div className="inline-flex items-center gap-1 max-md:gap-0">
      {derived ? (
        <span title="Read from the store — there is no declared value to change.">
          <IntegrationStateChip state={kind} lane={cell.laneId} subject={`source:${cell.assetId}:${cell.laneId}`} />
        </span>
      ) : (
        <Link
          to={`/assets/${encodeURIComponent(cell.assetId)}/sources`}
          title={`Open ${cell.assetId} connection details`}
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:px-1"
        >
          <IntegrationStateChip state={kind} lane={cell.laneId} subject={`source:${cell.assetId}:${cell.laneId}`} />
        </Link>
      )}
      {cell.evidence.length > 0 ? (
        <EvidencePopover
          evidence={cell.evidence}
          nowMs={nowMs}
          contextLabel={`${laneLabel} · ${cell.assetId}`}
          className="max-md:size-11"
        />
      ) : null}
    </div>
  );
}

/**
 * An opened source: its facts first (cost, when it runs, its limit, what
 * happens while it fails) as values.
 */
function LaneExplainer({ lane }: { lane: IntegrationCatalogRow }) {
  return (
    <div className="flex flex-col gap-1.5 py-1 text-xs">
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1" data-lane-facts={lane.id}>
        {laneFacts(lane, collectionCadenceHours(lane.id)).map((fact) => (
          <div key={fact.key} className="flex items-baseline gap-1.5" data-lane-fact={fact.key}>
            <dt className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">{fact.name}</dt>
            <dd className="font-medium tabular-nums text-foreground">{fact.value}</dd>
          </div>
        ))}
        {/* Whose account unlocks it, only where a provider credential is involved. */}
        {lane.layer === "provider" ? (
          <div className="flex items-baseline gap-1.5" data-lane-fact="credential">
            <dt className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">Credential</dt>
            <dd className="font-medium text-foreground">{lane.credential === "shared" ? "Shared" : "Per site"}</dd>
          </div>
        ) : null}
      </dl>
      <span className="font-mono text-[11px] text-muted-foreground">{lane.docRef}</span>
    </div>
  );
}

const SHORT_LANE_LABELS: Record<string, string> = {
  // The layer heading above this row already says "the OS itself", so the row
  // says only what the lane is.
  egress: "Internet connection",
  gsc: "Google Search Console",
  "bing-webmaster": "Bing Webmaster Tools",
  ga4: "Google Analytics",
  clarity: "Microsoft Clarity",
  posthog: "PostHog",
  dataforseo: "Search intelligence",
  uptime: "Uptime monitoring",
  "ad-network": "Ad revenue",
  "affiliate-cj": "CJ affiliate revenue",
  "affiliate-amazon": "Amazon affiliate revenue",
  "deploy-annotations": "Deploy history",
  "github-app": "GitHub",
  "discord-webhooks": "Operator notifications",
};

function shortLaneLabel(lane: IntegrationCatalogRow): string {
  return SHORT_LANE_LABELS[lane.id] ?? integrationLabel(lane.id, lane.label);
}
