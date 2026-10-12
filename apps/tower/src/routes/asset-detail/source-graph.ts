import type { FlowEdge, FlowNode, FlowState } from "@/components/viz/FlowGraph";
import type { HealthColumn, HealthRow, HealthState } from "@/components/viz/HealthGrid";

// A site's data sources as the graph its Data sources tab opens on: each
// connected source a node in the state Home's grid gives the same cell, an
// edge from it into the site, the failing one lit where it sits. A source the
// site does not use draws nothing, and one not connected feeds nothing, so it
// is named on one line under the graph rather than drawn as a dead node.

const FLOW: Record<HealthState, FlowState | null> = {
  working: "ok",
  collecting: "active",
  overdue: "warn",
  failing: "error",
  unknown: "idle",
  "not-connected": null,
  "not-using": null,
};

/** The column's name as a node prints it: the nightly report says nothing as
 * its short name alone. */
const nodeLabel = (column: HealthColumn) => (column.id === "nightly-report" ? "Nightly report" : column.short);

export function siteSourceGraph(
  row: HealthRow,
  columns: readonly HealthColumn[],
  site: { id: string; name: string },
): { nodes: FlowNode[]; edges: FlowEdge[]; notConnected: string[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const notConnected: string[] = [];
  for (const column of columns) {
    const cell = row.cells.find((one) => one.column === column.id);
    if (!cell) continue;
    if (cell.state === "not-connected") notConnected.push(nodeLabel(column));
    const state = FLOW[cell.state];
    if (state === null) continue;
    const trouble = cell.state === "failing" || cell.state === "overdue";
    nodes.push({
      id: column.id,
      label: nodeLabel(column),
      column: 0,
      // Only a problem says why on the node; the rows below hold the rest.
      caption: trouble ? (cell.detail ?? undefined) : undefined,
      state,
      stateLabel: cell.label,
      since: trouble ? (cell.since ?? null) : null,
    });
    edges.push({ from: column.id, to: site.id });
  }
  if (nodes.length === 0) return { nodes, edges, notConnected };
  // The site wears the worst of what feeds it; the count is the answer's,
  // above the graph, and is not stated twice.
  const worst = (["error", "warn"] as const).find((state) => nodes.some((node) => node.state === state));
  const live = nodes.some((node) => node.state === "ok" || node.state === "active");
  nodes.push({ id: site.id, label: site.name, column: 1, state: worst ?? (live ? "ok" : "idle") });
  return { nodes, edges, notConnected };
}
