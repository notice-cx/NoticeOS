import { useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Circle, CircleCheck, CircleX, TriangleAlert, Unplug, X, type LucideIcon } from "lucide-react";
import { ageMs, formatAge } from "@shared/freshness";
import { cn } from "@/lib/utils";

// How parts connect and which one is broken, drawn so the answer is seen
// rather than read. Nodes are HTML panels (crisp text, focusable, read in
// order); edges are one SVG layer behind them, routed from the nodes'
// measured boxes:
//
//   forward   across: a curve from a node's right side to the next column's left
//   straight  down: bottom to top of the node stacked directly below
//   bypass    down past other nodes: out of the left side, along a gutter lane
//   around    a loop or a back edge: under the graph across, beside it down
//
// The graph lays out across when its own box fits every column at
// `minColumnWidth`, otherwise as one stacked column; never by the viewport.
// A failing node is the loudest mark on it and breaks its outgoing edges
// unless an edge says otherwise. The drawing is aria-hidden: a visually hidden
// list states every edge, and the nodes read as text.

export type FlowState = "ok" | "active" | "warn" | "error" | "idle" | "absent";
export type FlowEdgeState = "flowing" | "idle" | "broken";
export type FlowDirection = "horizontal" | "vertical";

export interface FlowNode {
  id: string;
  /** The part, in the reader's words. Truncates on one line, never mid-word. */
  label: string;
  /** Pins the node to a column; otherwise its longest path from a source
   * decides. Pin a node whose edge would skip a column, so no edge runs
   * behind another node. */
  column?: number;
  /** The live figure, formatted: "31 of 38", "147". */
  value?: string;
  /** What the figure counts and one fact beside it: "sources live · 3 failing". */
  caption?: string;
  state: FlowState;
  /** The state's word where the default does not fit: "Done", "Blocked". */
  stateLabel?: string;
  /** When the current state began (ISO); a failing or at-risk node shows its age. */
  since?: string | null;
  icon?: ComponentType<{ className?: string }>;
  href?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** Without it the source decides: failing breaks the edge, idle or not
   * connected idles it. */
  state?: FlowEdgeState;
  /** A word or two, drawn on the edge where there is room and always read out. */
  label?: string;
  /** A return edge (Learn → Sense): left out of layering, routed around the outside. */
  loop?: boolean;
}

export interface FlowGraphProps {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  /** The clock a node's age is read against. */
  nowMs: number;
  direction?: "auto" | FlowDirection;
  /** The width one column needs across, its share of the gutter included. */
  minColumnWidth?: number;
  /** The surface the graph sits on, so an edge's break mark and label are cut from it. */
  surface?: "card" | "background";
  /** For a band with little height (the TV's loop): each node is two lines,
   * its name with the state's glyph, then the figure beside its caption. */
  dense?: boolean;
  ariaLabel: string;
  className?: string;
}

const STATE: Record<FlowState, { word: string; Glyph: LucideIcon | null; frame: string; rule: string; tile: string; glyph: string; ink: string }> = {
  ok: { word: "Working", Glyph: CircleCheck, frame: "border-border bg-card text-foreground", rule: "bg-healthy/45", tile: "bg-muted text-muted-foreground", glyph: "text-healthy", ink: "text-muted-foreground" },
  active: { word: "Running", Glyph: null, frame: "border-healthy/45 bg-card text-foreground", rule: "bg-healthy", tile: "bg-healthy-soft text-healthy", glyph: "text-healthy", ink: "text-healthy" },
  warn: { word: "At risk", Glyph: TriangleAlert, frame: "border-warn/60 bg-card text-foreground", rule: "bg-warn", tile: "bg-warn-soft text-warn", glyph: "text-warn", ink: "text-warn" },
  error: { word: "Failing", Glyph: CircleX, frame: "border-error bg-error-soft text-foreground shadow-lg shadow-error/25 ring-4 ring-error/15", rule: "bg-error", tile: "bg-error text-error-foreground", glyph: "text-error", ink: "text-error" },
  idle: { word: "Idle", Glyph: Circle, frame: "border-border bg-card text-muted-foreground", rule: "bg-muted-foreground/30", tile: "bg-muted text-muted-foreground", glyph: "text-muted-foreground", ink: "text-muted-foreground" },
  // The hatch is drawn in the frame's ink, so a fainter ink keeps the text
  // legible over it; the label and the state word set their own.
  absent: { word: "Not connected", Glyph: Unplug, frame: "viz-hatch border-dashed border-border bg-background text-muted-foreground/55", rule: "", tile: "bg-muted text-muted-foreground", glyph: "text-muted-foreground", ink: "text-muted-foreground" },
};

const EDGE_WORD: Record<FlowEdgeState, string> = { flowing: "flowing", idle: "idle", broken: "broken" };

// Kept out of `cn`: tailwind-merge reads an unknown `text-*` step as a colour
// and would drop the size beside one.
const AGE_BADGE: Partial<Record<FlowState, string>> = {
  error: "shrink-0 rounded-full bg-error px-1.5 text-micro font-semibold tabular-nums text-error-foreground",
  warn: "shrink-0 rounded-full border border-warn/50 px-1.5 text-micro font-medium tabular-nums text-warn",
};

const SURFACE = {
  card: { fill: "fill-card", bg: "bg-card" },
  background: { fill: "fill-background", bg: "bg-background" },
} as const;

/** The edge's state when it does not state one: the source speaks for it. */
export function flowEdgeState(
  edge: Pick<FlowEdge, "state">,
  from: Pick<FlowNode, "state">,
  to: Pick<FlowNode, "state">,
): FlowEdgeState {
  if (edge.state) return edge.state;
  if (from.state === "error") return "broken";
  if (from.state === "idle" || from.state === "absent" || to.state === "absent") return "idle";
  return "flowing";
}

/**
 * Each node's column, numbered densely from 0: its pinned `column`, or one
 * past its deepest predecessor. Loop edges and edges to unknown nodes are left
 * out, and an unmarked cycle is cut where it is found, so any graph lays out.
 */
export function flowLayers(
  nodes: readonly Pick<FlowNode, "id" | "column">[],
  edges: readonly Pick<FlowEdge, "from" | "to" | "loop">[],
): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const pinned = new Map<string, number>();
  for (const node of nodes) if (node.column !== undefined && Number.isFinite(node.column)) pinned.set(node.id, node.column);
  const before = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.loop || edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    before.set(edge.to, [...(before.get(edge.to) ?? []), edge.from]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const measure = (id: string): number => {
    const known = depth.get(id) ?? pinned.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let deepest = 0;
    for (const from of before.get(id) ?? []) if (!visiting.has(from)) deepest = Math.max(deepest, measure(from) + 1);
    visiting.delete(id);
    depth.set(id, deepest);
    return deepest;
  };
  const raw = nodes.map((node) => [node.id, measure(node.id)] as const);
  const rank = new Map([...new Set(raw.map(([, d]) => d))].sort((a, b) => a - b).map((d, i) => [d, i]));
  return new Map(raw.map(([id, d]) => [id, rank.get(d)!]));
}

type RouteKind = "forward" | "straight" | "bypass" | "around";

interface PlannedEdge {
  key: string;
  edge: FlowEdge;
  from: FlowNode;
  to: FlowNode;
  state: FlowEdgeState;
  kind: RouteKind;
  /** The gutter lane (bypass) or ring (around) the edge runs in, 0 innermost. */
  track: number;
}

interface FlowPlan {
  direction: FlowDirection;
  layers: FlowNode[][];
  edges: PlannedEdge[];
  lanes: number;
  arounds: number;
}

function planFlow(nodes: readonly FlowNode[], edges: readonly FlowEdge[], columns: Map<string, number>, direction: FlowDirection): FlowPlan {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const layers: FlowNode[][] = [];
  for (const node of nodes) (layers[columns.get(node.id)!] ??= []).push(node);
  const stacked = new Map(layers.flat().map((node, i) => [node.id, i]));
  const planned: PlannedEdge[] = [];
  edges.forEach((edge, i) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;
    const back = edge.loop === true || columns.get(to.id)! <= columns.get(from.id)!;
    const kind: RouteKind = back ? "around"
      : direction === "horizontal" ? "forward"
        : stacked.get(to.id) === stacked.get(from.id)! + 1 ? "straight" : "bypass";
    planned.push({ key: `${edge.from}->${edge.to}:${i}`, edge, from, to, state: flowEdgeState(edge, from, to), kind, track: 0 });
  });
  const span = (e: PlannedEdge) => {
    const a = stacked.get(e.from.id)!;
    const b = stacked.get(e.to.id)!;
    return [Math.min(a, b), Math.max(a, b)] as const;
  };
  const shortestFirst = (a: PlannedEdge, b: PlannedEdge) => (span(a)[1] - span(a)[0]) - (span(b)[1] - span(b)[0]);
  // Shorter lanes sit inside longer ones, so overlapping lanes nest rather than cross.
  const taken: { lo: number; hi: number; track: number }[] = [];
  for (const e of planned.filter((p) => p.kind === "bypass").sort(shortestFirst)) {
    const [lo, hi] = span(e);
    while (taken.some((t) => t.track === e.track && t.lo <= hi && lo <= t.hi)) e.track += 1;
    taken.push({ lo, hi, track: e.track });
  }
  const around = planned.filter((p) => p.kind === "around").sort(shortestFirst);
  around.forEach((e, i) => { e.track = i; });
  return {
    direction,
    layers,
    edges: planned,
    lanes: taken.length ? Math.max(...taken.map((t) => t.track)) + 1 : 0,
    arounds: around.length,
  };
}

/** A node's box inside the graph, in CSS pixels from its top-left corner. */
export interface FlowBox { x: number; y: number; w: number; h: number }
interface Point { x: number; y: number }
export interface FlowRoute {
  d: string;
  arrow: string;
  /** Where a break mark sits. */
  mid: Point;
  /** Where a label pill sits, or null where the route has no room for one. */
  label: (Point & { beside: boolean }) | null;
}

// Geometry in CSS pixels: the SVG layer is drawn 1:1 over the graph's box.
const ARROW = 6;
const ARROW_HALF = 3.5;
const TIP_GAP = 2;
const PORT_GAP = 8;
const RADIUS = 10;
const LANE_INSET = 8;
const LANE_GAP = 6;
const AROUND_INSET = 16;
const AROUND_GAP = 8;

type Side = "left" | "right" | "top" | "bottom";

function sides(kind: RouteKind, direction: FlowDirection): readonly [Side, Side] {
  if (kind === "forward") return ["right", "left"];
  if (kind === "straight") return ["bottom", "top"];
  if (kind === "bypass") return ["left", "left"];
  return direction === "horizontal" ? ["bottom", "bottom"] : ["right", "right"];
}

const midX = (b: FlowBox) => b.x + b.w / 2;
const midY = (b: FlowBox) => b.y + b.h / 2;
const num = (v: number) => String(Math.round(v * 10) / 10);
const pt = (p: Point) => `${num(p.x)} ${num(p.y)}`;

/**
 * Edges meeting one side of a node spread along it, ordered by where their
 * other end lies so they do not cross on arrival. On a lane side, arrivals sit
 * above departures and the outer lanes take the outer ports.
 */
function assignPorts(plan: FlowPlan, drawn: readonly PlannedEdge[], boxes: ReadonlyMap<string, FlowBox>): Map<string, Point> {
  type End = { id: string; outgoing: boolean; other: FlowBox };
  const slots = new Map<string, Map<Side, End[]>>();
  const add = (node: string, side: Side, end: End) => {
    const bySide = slots.get(node) ?? new Map<Side, End[]>();
    bySide.set(side, [...(bySide.get(side) ?? []), end]);
    slots.set(node, bySide);
  };
  for (const e of drawn) {
    const [exit, enter] = sides(e.kind, plan.direction);
    add(e.from.id, exit, { id: `${e.key}:from`, outgoing: true, other: boxes.get(e.to.id)! });
    add(e.to.id, enter, { id: `${e.key}:to`, outgoing: false, other: boxes.get(e.from.id)! });
  }
  const ports = new Map<string, Point>();
  for (const [node, bySide] of slots) {
    const box = boxes.get(node)!;
    for (const [side, ends] of bySide) {
      const across = side === "left" || side === "right";
      const lane = side === "left" && plan.direction === "vertical";
      ends.sort((p, q) => lane
        ? Number(p.outgoing) - Number(q.outgoing) || midY(q.other) - midY(p.other)
        : across ? midY(p.other) - midY(q.other) : midX(p.other) - midX(q.other));
      const length = across ? box.h : box.w;
      const step = ends.length > 1 ? Math.min(PORT_GAP, (length * 0.6) / (ends.length - 1)) : 0;
      ends.forEach((end, i) => {
        const offset = (i - (ends.length - 1) / 2) * step;
        ports.set(end.id, side === "left" ? { x: box.x, y: midY(box) + offset }
          : side === "right" ? { x: box.x + box.w, y: midY(box) + offset }
            : side === "top" ? { x: midX(box) + offset, y: box.y }
              : { x: midX(box) + offset, y: box.y + box.h });
      });
    }
  }
  return ports;
}

const HEADING: Record<"right" | "left" | "down" | "up", readonly [number, number]> = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };

function arrowHead(tip: Point, heading: keyof typeof HEADING): string {
  const [ux, uy] = HEADING[heading];
  const base = { x: tip.x - ux * ARROW, y: tip.y - uy * ARROW };
  const side = { x: -uy * ARROW_HALF, y: ux * ARROW_HALF };
  return `M${pt({ x: base.x + side.x, y: base.y + side.y })} L${pt(tip)} L${pt({ x: base.x - side.x, y: base.y - side.y })}Z`;
}

function cubic(a: Point, c1: Point, c2: Point, b: Point): { d: string; mid: Point } {
  return {
    d: `M${pt(a)} C${pt(c1)} ${pt(c2)} ${pt(b)}`,
    mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 },
  };
}

interface Frame { direction: FlowDirection; left: number; right: number; bottom: number; laneStep: number }

function routeEdge(e: PlannedEdge, a: Point, b: Point, f: Frame): FlowRoute {
  if (e.kind === "forward") {
    const tip = { x: b.x - TIP_GAP, y: b.y };
    const end = { x: tip.x - ARROW, y: tip.y };
    const dx = Math.max(12, (end.x - a.x) / 2);
    const { d, mid } = cubic(a, { x: a.x + dx, y: a.y }, { x: end.x - dx, y: end.y }, end);
    return { d, arrow: arrowHead(tip, "right"), mid, label: { ...mid, beside: false } };
  }
  if (e.kind === "straight") {
    const tip = { x: b.x, y: b.y - TIP_GAP };
    const end = { x: tip.x, y: tip.y - ARROW };
    const dy = Math.max(8, (end.y - a.y) / 2);
    const { d, mid } = cubic(a, { x: a.x, y: a.y + dy }, { x: end.x, y: end.y - dy }, end);
    return { d, arrow: arrowHead(tip, "down"), mid, label: { ...mid, beside: true } };
  }
  if (e.kind === "bypass") {
    const x = f.left - LANE_INSET - e.track * f.laneStep;
    const tip = { x: b.x - TIP_GAP, y: b.y };
    const end = { x: tip.x - ARROW, y: tip.y };
    const s = Math.sign(end.y - a.y) || 1;
    const r = Math.max(0, Math.min(RADIUS, Math.abs(end.y - a.y) / 2, a.x - x, end.x - x));
    const d = `M${pt(a)} H${num(x + r)} Q${num(x)} ${num(a.y)} ${num(x)} ${num(a.y + r * s)} V${num(end.y - r * s)} Q${num(x)} ${num(end.y)} ${num(x + r)} ${num(end.y)} H${num(end.x)}`;
    return { d, arrow: arrowHead(tip, "right"), mid: { x, y: (a.y + end.y) / 2 }, label: null };
  }
  if (f.direction === "horizontal") {
    const y = f.bottom + AROUND_INSET + e.track * AROUND_GAP;
    const tip = { x: b.x, y: b.y + TIP_GAP };
    const end = { x: tip.x, y: tip.y + ARROW };
    const s = Math.sign(end.x - a.x) || -1;
    const r = Math.max(0, Math.min(RADIUS, Math.abs(end.x - a.x) / 2, y - a.y, y - end.y));
    const d = `M${pt(a)} V${num(y - r)} Q${num(a.x)} ${num(y)} ${num(a.x + r * s)} ${num(y)} H${num(end.x - r * s)} Q${num(end.x)} ${num(y)} ${num(end.x)} ${num(y - r)} V${num(end.y)}`;
    const mid = { x: (a.x + end.x) / 2, y };
    return { d, arrow: arrowHead(tip, "up"), mid, label: { ...mid, beside: false } };
  }
  const x = f.right + AROUND_INSET + e.track * AROUND_GAP;
  const tip = { x: b.x + TIP_GAP, y: b.y };
  const end = { x: tip.x + ARROW, y: tip.y };
  const s = Math.sign(end.y - a.y) || -1;
  const r = Math.max(0, Math.min(RADIUS, Math.abs(end.y - a.y) / 2, x - a.x, x - end.x));
  const d = `M${pt(a)} H${num(x - r)} Q${num(x)} ${num(a.y)} ${num(x)} ${num(a.y + r * s)} V${num(end.y - r * s)} Q${num(x)} ${num(end.y)} ${num(x - r)} ${num(end.y)} H${num(end.x)}`;
  return { d, arrow: arrowHead(tip, "left"), mid: { x, y: (a.y + end.y) / 2 }, label: null };
}

function routeFlow(plan: FlowPlan, boxes: ReadonlyMap<string, FlowBox>): Map<string, FlowRoute> {
  const routes = new Map<string, FlowRoute>();
  const placed = plan.layers.flat().flatMap((node) => boxes.get(node.id) ?? []);
  const drawn = plan.edges.filter((e) => boxes.has(e.from.id) && boxes.has(e.to.id));
  if (!placed.length || !drawn.length) return routes;
  const left = Math.min(...placed.map((b) => b.x));
  const frame: Frame = {
    direction: plan.direction,
    left,
    right: Math.max(...placed.map((b) => b.x + b.w)),
    bottom: Math.max(...placed.map((b) => b.y + b.h)),
    laneStep: plan.lanes > 1 ? Math.max(3, Math.min(LANE_GAP, (left - LANE_INSET - 2) / (plan.lanes - 1))) : 0,
  };
  const ports = assignPorts(plan, drawn, boxes);
  for (const e of drawn) routes.set(e.key, routeEdge(e, ports.get(`${e.key}:from`)!, ports.get(`${e.key}:to`)!, frame));
  return routes;
}

/** Every edge's route for nodes at these boxes, keyed `from->to:index`.
 * Pure: the component measures, this draws. */
export function flowRoutes(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  direction: FlowDirection,
  boxes: ReadonlyMap<string, FlowBox>,
): Map<string, FlowRoute> {
  return routeFlow(planFlow(nodes, edges, flowLayers(nodes, edges), direction), boxes);
}

interface Measured { width: number; boxes: Map<string, FlowBox> }
const UNMEASURED: Measured = { width: 0, boxes: new Map() };

/** Layout offsets rather than client rects: an arriving node's transform and a
 * scaled preview's zoom would otherwise bend every edge. */
function boxWithin(el: HTMLElement, root: HTMLElement): FlowBox {
  let x = 0;
  let y = 0;
  for (let at: Element | null = el; at instanceof HTMLElement && at !== root; at = at.offsetParent) {
    x += at.offsetLeft;
    y += at.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function sameMeasure(a: Measured, b: Measured): boolean {
  if (a.width !== b.width || a.boxes.size !== b.boxes.size) return false;
  for (const [id, box] of a.boxes) {
    const other = b.boxes.get(id);
    if (!other || other.x !== box.x || other.y !== box.y || other.w !== box.w || other.h !== box.h) return false;
  }
  return true;
}

function edgeSentence(e: PlannedEdge): string {
  const how = `${EDGE_WORD[e.state]}${e.kind === "around" ? ", loops back" : ""}`;
  return `${e.from.label} → ${e.to.label} (${how})${e.edge.label ? `, ${e.edge.label}` : ""}`;
}

export function FlowGraph({
  nodes,
  edges,
  nowMs,
  direction = "auto",
  minColumnWidth = 184,
  surface = "card",
  dense = false,
  ariaLabel,
  className,
}: FlowGraphProps) {
  const rootRef = useRef<HTMLElement>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const [measured, setMeasured] = useState<Measured>(UNMEASURED);
  const columns = useMemo(() => flowLayers(nodes, edges), [nodes, edges]);
  const columnCount = Math.max(0, ...columns.values()) + 1;
  // Unmeasured (first pass, or no layout at all) lays out across; the
  // measurement that follows settles it before paint.
  const resolved: FlowDirection = direction !== "auto" ? direction
    : measured.width === 0 || measured.width >= columnCount * minColumnWidth ? "horizontal" : "vertical";
  const plan = useMemo(() => planFlow(nodes, edges, columns, resolved), [nodes, edges, columns, resolved]);
  const routes = useMemo(() => (measured.width > 0 ? routeFlow(plan, measured.boxes) : new Map<string, FlowRoute>()), [plan, measured]);
  const nodeKey = nodes.map((node) => node.id).join("\n");
  const horizontal = resolved === "horizontal";
  // Where every column holds as many nodes, they share rows: equal heights, aligned tops.
  const rows = horizontal && plan.layers.every((layer) => layer.length === plan.layers[0]!.length);
  // Room to spare widens the gutters, so edges fanning into one node stay apart.
  const pitch = measured.width / columnCount;
  const gutter = !horizontal ? "flex-col gap-10" : pitch >= 260 ? "gap-x-16" : pitch >= 220 ? "gap-x-14" : "gap-x-10";

  // Nodes are watched for size; a new direction, gutter or row sharing moves
  // them without resizing them, so each of those re-measures too.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ids = nodeKey.split("\n");
    const measure = () => {
      const boxes = new Map<string, FlowBox>();
      for (const id of ids) {
        const el = nodeEls.current.get(id);
        if (el?.isConnected) boxes.set(id, boxWithin(el, root));
      }
      const next = { width: root.clientWidth, boxes };
      setMeasured((current) => (sameMeasure(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const id of ids) {
      const el = nodeEls.current.get(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [resolved, nodeKey, gutter, rows]);

  const cut = SURFACE[surface];
  return (
    <figure
      ref={rootRef}
      aria-label={ariaLabel}
      data-flow-graph
      data-direction={resolved}
      className={cn("relative m-0 w-full", className)}
    >
      <svg aria-hidden data-flow-edges className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {plan.edges.map((e) => (
          <EdgeMark key={e.key} edge={e} route={routes.get(e.key) ?? null} fill={cut.fill} />
        ))}
      </svg>
      <div
        className={cn(
          "relative flex",
          horizontal && "items-stretch",
          gutter,
          horizontal && plan.arounds > 0 && (dense ? "pb-8" : "pb-12"),
          !horizontal && plan.lanes > 0 && "pl-8",
          !horizontal && plan.arounds > 0 && "pr-8",
        )}
      >
        {plan.layers.map((layer, column) => (
          <div
            key={column}
            data-flow-column={column}
            className={horizontal ? "flex min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-3 *:max-w-72" : "flex flex-col gap-3"}
          >
            {layer.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                nowMs={nowMs}
                column={column}
                grow={rows}
                dense={dense}
                register={(el) => { if (el) nodeEls.current.set(node.id, el); }}
              />
            ))}
          </div>
        ))}
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {plan.edges.map((e) => {
          const at = routes.get(e.key)?.label;
          if (!at || !e.edge.label) return null;
          const broken = e.state === "broken";
          return (
            <span
              key={e.key}
              data-flow-edge-label={`${e.from.id}->${e.to.id}`}
              style={{ left: at.x, top: at.y }}
              className={cn(
                "absolute inline-flex -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium",
                at.beside ? "translate-x-2" : "-translate-x-1/2",
                cut.bg,
                broken ? "border-error/60 text-error" : "border-border text-muted-foreground",
              )}
            >
              {broken ? <X className="size-3 shrink-0" /> : null}
              <span className="text-micro">{e.edge.label}</span>
            </span>
          );
        })}
      </div>
      {plan.edges.length ? (
        <ol className="sr-only" data-flow-steps>
          {plan.edges.map((e) => <li key={e.key}>{edgeSentence(e)}</li>)}
        </ol>
      ) : null}
    </figure>
  );
}

function EdgeMark({ edge, route, fill }: { edge: PlannedEdge; route: FlowRoute | null; fill: string }) {
  const flowing = edge.state === "flowing";
  return (
    <g data-flow-edge={`${edge.from.id}->${edge.to.id}`} data-state={edge.state} data-route={edge.kind}>
      {route === null ? null : edge.state === "broken" ? (
        <>
          <path d={route.d} fill="none" className="stroke-error" strokeWidth={1.75} strokeDasharray="5 4" strokeLinecap="round" />
          <path d={route.arrow} className="fill-error" />
          {route.label && edge.edge.label ? null : (
            <g transform={`translate(${pt(route.mid)})`} data-flow-break>
              <circle r={6.5} strokeWidth={1.5} className={cn(fill, "stroke-error")} />
              <path d="M-2.3 -2.3 L2.3 2.3 M2.3 -2.3 L-2.3 2.3" strokeWidth={1.75} strokeLinecap="round" className="stroke-error" />
            </g>
          )}
        </>
      ) : (
        <>
          <path
            d={route.d}
            pathLength={1}
            fill="none"
            strokeWidth={flowing ? 1.5 : 1}
            className={cn("viz-draw", flowing ? "stroke-muted-foreground/35" : "stroke-muted-foreground/30")}
          />
          {flowing ? <path d={route.d} fill="none" strokeWidth={2} strokeLinecap="round" className="viz-flow stroke-muted-foreground" /> : null}
          <path d={route.arrow} className={flowing ? "fill-muted-foreground" : "fill-muted-foreground/45"} />
        </>
      )}
    </g>
  );
}

function StateGlyph({ state }: { state: FlowState }) {
  const { Glyph, glyph } = STATE[state];
  if (Glyph) return <Glyph aria-hidden className={cn("size-3.5 shrink-0", glyph)} />;
  return (
    <span aria-hidden className={cn("grid size-3.5 shrink-0 place-items-center", glyph)}>
      <span className="viz-breathe size-2 rounded-full bg-current" />
    </span>
  );
}

function NodeCard({ node, nowMs, column, grow, dense, register }: { node: FlowNode; nowMs: number; column: number; grow: boolean; dense: boolean; register: (el: HTMLElement | null) => void }) {
  const spec = STATE[node.state];
  const age = node.state === "error" || node.state === "warn" ? ageMs(nowMs, node.since) : null;
  const ageText = age === null ? null : formatAge(age);
  const Icon = node.icon;
  const className = cn(
    "viz-arrive relative flex w-full min-w-0 flex-col gap-1 rounded-lg border pr-3 pl-4 text-left",
    dense ? "py-2" : "py-3",
    spec.frame,
    grow && "grow",
    node.href && "outline-none transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
  );
  const style = { "--viz-i": column } as CSSProperties;
  const word = node.stateLabel ?? spec.word;
  const content = (
    <>
      {spec.rule ? <span aria-hidden className={cn("absolute left-1 w-1 rounded-full", dense ? "inset-y-2" : "inset-y-3", spec.rule)} /> : null}
      <span className="flex min-w-0 items-center gap-2">
        {Icon ? (
          <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-md", spec.tile)}>
            <Icon className="size-3.5" />
          </span>
        ) : null}
        {/* A name wraps between its words on the desk rather than losing its
            end; the TV's dense graph keeps one line to hold its height. */}
        <span className={cn("min-w-0 flex-1 text-sm font-medium", dense ? "truncate" : "leading-snug", node.state === "absent" && "text-muted-foreground")} title={node.label}>{node.label}</span>
        {ageText ? <span aria-hidden data-flow-age className={AGE_BADGE[node.state]}>{ageText}</span> : null}
        {dense ? (
          <span className={cn("flex shrink-0 items-center", spec.ink)} data-flow-state-word title={word}>
            <StateGlyph state={node.state} />
            <span className="sr-only">{word}{ageText ? `, for ${ageText}` : ""}</span>
          </span>
        ) : null}
      </span>
      {dense ? (
        <span className="flex min-w-0 items-baseline gap-2">
          {node.value ? <span className="shrink-0 text-figure-sm tabular-nums">{node.value}</span> : null}
          {node.caption ? <span className="min-w-0 truncate text-xs text-muted-foreground" title={node.caption}>{node.caption}</span> : null}
        </span>
      ) : (
        <>
          {node.value ? <span className="mt-0.5 truncate text-figure-sm tabular-nums" title={node.value}>{node.value}</span> : null}
          {node.caption ? <span className="text-xs text-muted-foreground">{node.caption}</span> : null}
          <span className={cn("mt-auto flex min-w-0 items-center gap-1.5 pt-1 text-xs font-medium", spec.ink)} data-flow-state-word>
            <StateGlyph state={node.state} />
            <span className="truncate">{word}</span>
            {ageText ? <span className="sr-only">{`, for ${ageText}`}</span> : null}
          </span>
        </>
      )}
    </>
  );
  const data = { "data-flow-node": node.id, "data-state": node.state, "data-column": column };
  if (!node.href) return <div ref={register} className={className} style={style} {...data}>{content}</div>;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(node.href)) {
    return <a ref={register} href={node.href} className={className} style={style} {...data}>{content}</a>;
  }
  return <Link ref={register} to={node.href} className={className} style={style} {...data}>{content}</Link>;
}
