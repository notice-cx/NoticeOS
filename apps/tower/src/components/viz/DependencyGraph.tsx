import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FlowEdgePath, flowRoutes, type FlowBox, type FlowEdge, type FlowEdgeState, type FlowNode } from "@/components/viz/FlowGraph";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

// One item and its neighbours in a chain of work: what it waits on to its
// left, what waits on it to its right, each a card that opens its own page,
// and an arrow along every edge drawn the way the board's Epic graph draws it.
// Narrower than three cards across, the same nodes stack in one column, the
// item between the two lists. The drawing is aria-hidden; a visually hidden
// list states every edge.

export interface DependencyNode {
  id: string;
  title: string | null;
  /** The item's state mark (the board's status glyph). */
  mark: ReactNode;
  /** The state and holder in words, the card's description. */
  said?: string;
  href?: string;
  /** The edge between this node and the subject, as its source leaves it. */
  edge: FlowEdgeState;
}

export interface DependencyGraphProps {
  /** The item itself; its title is left out where the page already heads with it. */
  subject: { id: string; title?: string; mark: ReactNode; caption: string };
  /** What the subject waits on. */
  before: readonly DependencyNode[];
  /** What waits on the subject. */
  after: readonly DependencyNode[];
  beforeLabel: string;
  afterLabel: string;
  ariaLabel: string;
  className?: string;
}

/** The width one column needs across before the graph stacks. */
const COLUMN_PX = 170;
const EDGE_WORD: Record<FlowEdgeState, string> = { flowing: "moving", idle: "waiting", broken: "held" };

export function DependencyGraph({ subject, before, after, beforeLabel, afterLabel, ariaLabel, className }: DependencyGraphProps) {
  const root = useRef<HTMLElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [width, setWidth] = useState(0);
  const [boxes, setBoxes] = useState<Map<string, FlowBox>>(new Map());
  const columns = (before.length > 0 ? 1 : 0) + 1 + (after.length > 0 ? 1 : 0);
  const across = width === 0 || width >= columns * COLUMN_PX;
  const direction = across ? "horizontal" : "vertical";

  // Keys are prefixed by side: a task can sit on both sides of a cycle.
  const key = (side: "b" | "a", id: string) => `${side}:${id}`;
  const SUBJECT = "s:";
  const nodes = useMemo<FlowNode[]>(() => [
    ...before.map((node) => ({ id: key("b", node.id), label: node.title ?? node.id, state: "idle" as const, column: 0 })),
    { id: SUBJECT, label: subject.title ?? subject.id, state: "idle" as const, column: before.length > 0 ? 1 : 0 },
    ...after.map((node) => ({ id: key("a", node.id), label: node.title ?? node.id, state: "idle" as const, column: before.length > 0 ? 2 : 1 })),
  ], [before, after, subject.title, subject.id]);
  const edges = useMemo<FlowEdge[]>(() => [
    ...before.map((node) => ({ from: key("b", node.id), to: SUBJECT, state: node.edge })),
    ...after.map((node) => ({ from: SUBJECT, to: key("a", node.id), state: node.edge })),
  ], [before, after]);
  const routes = useMemo(() => (boxes.size === nodes.length ? flowRoutes(nodes, edges, direction, boxes) : new Map()), [nodes, edges, direction, boxes]);
  const nodeKey = nodes.map((node) => node.id).join("\n");

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const next = new Map<string, FlowBox>();
      for (const [id, card] of cards.current) {
        if (card.isConnected) next.set(id, boxWithin(card, element));
      }
      setWidth(element.clientWidth);
      setBoxes((current) => (sameBoxes(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const card of cards.current.values()) observer.observe(card);
    return () => observer.disconnect();
  }, [nodeKey, direction]);

  const register = (id: string) => (element: HTMLElement | null) => {
    if (element) cards.current.set(id, element);
    else cards.current.delete(id);
  };

  const column = (label: string | null, side: "b" | "a", items: readonly DependencyNode[], index: number) => (
    <div className={cn("flex min-w-0 flex-col gap-2", across && "flex-1 basis-0")} data-dependency-column={side === "b" ? "before" : "after"}>
      {label ? <h3 className={cn("m-0", eyebrowClass)}>{label}</h3> : null}
      {items.map((node, i) => (
        <NodeCard key={node.id} node={node} register={register(key(side, node.id))} index={index + i} />
      ))}
    </div>
  );

  return (
    <figure ref={root} aria-label={ariaLabel} data-dependency-graph="" data-direction={direction} className={cn("relative m-0 w-full", className)}>
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {edges.map((edge) => {
          const route = routes.get(`${edge.from}->${edge.to}:${edges.indexOf(edge)}`);
          return route ? (
            <g key={`${edge.from}->${edge.to}`} data-dependency-edge={`${edge.from}->${edge.to}`} data-state={edge.state}>
              <FlowEdgePath state={edge.state ?? "idle"} route={route} />
            </g>
          ) : null;
        })}
      </svg>
      <div className={cn("relative flex", across ? "items-center gap-x-10" : "flex-col gap-6 pl-8")}>
        {before.length > 0 ? column(beforeLabel, "b", before, 0) : null}
        <div className={cn("flex min-w-0 flex-col justify-center", across && "flex-1 basis-0")} data-dependency-column="subject">
          <div
            ref={register(SUBJECT)}
            data-dependency-subject={subject.id}
            className="viz-arrive relative flex min-w-0 flex-col gap-1 rounded-lg border border-foreground/25 bg-muted/60 px-3 py-2.5 shadow-raised"
            style={{ "--viz-i": before.length } as CSSProperties}
          >
            <span className={eyebrowClass}>{subject.caption}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="flex shrink-0">{subject.mark}</span>
              <span className="font-mono text-xs text-muted-foreground">{subject.id}</span>
            </span>
            {subject.title ? <span className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{subject.title}</span> : null}
          </div>
        </div>
        {after.length > 0 ? column(afterLabel, "a", after, before.length + 1) : null}
      </div>
      <ol className="sr-only">
        {before.map((node) => <li key={`b${node.id}`}>{node.id} → {subject.id} ({EDGE_WORD[node.edge]})</li>)}
        {after.map((node) => <li key={`a${node.id}`}>{subject.id} → {node.id} ({EDGE_WORD[node.edge]})</li>)}
      </ol>
    </figure>
  );
}

/** A neighbour as one target: the whole card opens its page, named by its id
 * and title. */
function NodeCard({ node, register, index }: { node: DependencyNode; register: (element: HTMLElement | null) => void; index: number }) {
  const ids = useId();
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="flex shrink-0">{node.mark}</span>
        <span id={`${ids}-id`} className="font-mono text-xs text-muted-foreground group-hover:text-foreground motion-safe:transition-colors">{node.id}</span>
      </span>
      {node.title ? <span id={`${ids}-title`} className="text-sm text-foreground [overflow-wrap:anywhere]">{node.title}</span> : null}
      {node.said ? <span id={`${ids}-said`} hidden>{node.said}</span> : null}
    </>
  );
  const frame = "viz-arrive group relative flex min-h-11 min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2 text-left";
  const style = { "--viz-i": index } as CSSProperties;
  if (!node.href) {
    return <div ref={register} className={frame} style={style} data-dependency={node.id}>{content}</div>;
  }
  return (
    <Link
      ref={register}
      to={node.href}
      aria-labelledby={node.title ? `${ids}-id ${ids}-title` : `${ids}-id`}
      aria-describedby={node.said ? `${ids}-said` : undefined}
      data-dependency={node.id}
      className={cn(
        frame,
        "outline-none hover:border-foreground/35 hover:bg-muted/50 active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring",
        "motion-safe:transition-[background-color,border-color,transform] motion-safe:active:scale-[0.98]",
      )}
      style={style}
    >
      {content}
    </Link>
  );
}

/** Layout offsets, not client rects: a card arriving on a transform would
 * otherwise bend its edge. */
function boxWithin(element: HTMLElement, root: HTMLElement): FlowBox {
  let x = 0;
  let y = 0;
  for (let at: Element | null = element; at instanceof HTMLElement && at !== root; at = at.offsetParent) {
    x += at.offsetLeft;
    y += at.offsetTop;
  }
  return { x, y, w: element.offsetWidth, h: element.offsetHeight };
}

function sameBoxes(a: Map<string, FlowBox>, b: Map<string, FlowBox>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, box] of a) {
    const other = b.get(id);
    if (!other || Math.abs(other.x - box.x) > 0.5 || Math.abs(other.y - box.y) > 0.5 || Math.abs(other.w - box.w) > 0.5 || Math.abs(other.h - box.h) > 0.5) return false;
  }
  return true;
}
