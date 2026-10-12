// A flow graph answers "where is it broken and what does that cut off" by
// looking: columns come from the longest path (or a pin), a failing source
// breaks its edges, every state carries a word, and the edges are read out as
// a list. jsdom has no layout, so geometry is checked on the pure router with
// boxes of our own, and the component is checked not to draw from zero boxes.

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FlowGraph,
  flowEdgeState,
  flowLayers,
  flowRoutes,
  type FlowBox,
  type FlowGraphProps,
} from "@/components/viz/FlowGraph";
import {
  FLOW_ABSENT,
  FLOW_DEPENDENCIES,
  FLOW_LOOP,
  FLOW_NOW_MS,
  FLOW_SYSTEM,
  type FlowFixture,
} from "@/components/viz/FlowGraph.fixtures";

function draw(fixture: FlowFixture, over: Partial<FlowGraphProps> = {}) {
  return render(
    <MemoryRouter>
      <FlowGraph nodes={fixture.nodes} edges={fixture.edges} nowMs={FLOW_NOW_MS} ariaLabel={fixture.ariaLabel} {...over} />
    </MemoryRouter>,
  );
}

const node = (id: string) => document.querySelector<HTMLElement>(`[data-flow-node="${id}"]`)!;
const edge = (key: string) => document.querySelector<SVGGElement>(`[data-flow-edge="${key}"]`)!;
const steps = () => [...document.querySelectorAll("[data-flow-steps] li")].map((li) => li.textContent);

describe("flowLayers", () => {
  it("puts each node one column past its deepest predecessor", () => {
    const layers = flowLayers(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "d", to: "c" }],
    );
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  it("leaves a loop edge out, so the loop reads left to right", () => {
    expect([...flowLayers(FLOW_LOOP.nodes, FLOW_LOOP.edges).values()]).toEqual([0, 1, 2, 3, 4]);
  });

  it("lays out the system by depth: sources, collectors, store, then what reads it", () => {
    const layers = flowLayers(FLOW_SYSTEM.nodes, FLOW_SYSTEM.edges);
    expect(["search-console", "bing", "ga4", "uptime", "mediavine"].map((id) => layers.get(id))).toEqual([0, 0, 0, 0, 0]);
    expect(layers.get("collectors")).toBe(1);
    expect(layers.get("store")).toBe(2);
    expect([layers.get("tower"), layers.get("runner")]).toEqual([3, 3]);
    expect(layers.get("backups")).toBe(4);
  });

  it("honours a pinned column and builds on it", () => {
    const layers = flowLayers(FLOW_DEPENDENCIES.nodes, FLOW_DEPENDENCIES.edges);
    expect(Object.fromEntries(layers)).toEqual({ headline: 0, variant: 1, access: 1, launch: 2, read: 3 });
  });

  it("numbers columns densely whatever the pins", () => {
    const layers = flowLayers([{ id: "a", column: 4 }, { id: "b", column: 10 }, { id: "c" }], [{ from: "b", to: "c" }]);
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("survives an unmarked cycle, a self edge and an edge to nowhere", () => {
    const layers = flowLayers(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "b", to: "b" }, { from: "ghost", to: "a" }],
    );
    expect(layers.size).toBe(3);
    expect(new Set(layers.values()).size).toBe(3);
  });
});

describe("flowEdgeState", () => {
  it("takes an edge's own state first", () => {
    expect(flowEdgeState({ state: "idle" }, { state: "error" }, { state: "ok" })).toBe("idle");
  });

  it("breaks the edges out of a failing node", () => {
    expect(flowEdgeState({}, { state: "error" }, { state: "ok" })).toBe("broken");
  });

  it("idles edges out of an idle or unconnected node and into an unconnected one", () => {
    expect(flowEdgeState({}, { state: "idle" }, { state: "ok" })).toBe("idle");
    expect(flowEdgeState({}, { state: "absent" }, { state: "ok" })).toBe("idle");
    expect(flowEdgeState({}, { state: "ok" }, { state: "absent" })).toBe("idle");
  });

  it("lets everything else flow, an at-risk source included", () => {
    for (const state of ["ok", "active", "warn"] as const) expect(flowEdgeState({}, { state }, { state: "ok" })).toBe("flowing");
  });
});

describe("FlowGraph", () => {
  it("is a named figure whose edges are read out in order", () => {
    draw(FLOW_LOOP);
    expect(screen.getByRole("figure", { name: FLOW_LOOP.ariaLabel })).toHaveAttribute("data-flow-graph");
    expect(steps()).toEqual([
      "Sense → Attribute (flowing)",
      "Attribute → Decide (flowing)",
      "Decide → Act (flowing)",
      "Act → Learn (flowing)",
      "Learn → Sense (flowing, loops back), next round",
    ]);
  });

  it("draws each stage with its figure, caption and state word", () => {
    draw(FLOW_LOOP);
    const sense = node("sense");
    expect(sense).toHaveAttribute("data-state", "warn");
    expect(sense).toHaveTextContent("31 of 38");
    expect(sense).toHaveTextContent("sources live · 3 failing");
    expect(within(sense).getByText("At risk")).toBeInTheDocument();
    expect(within(node("act")).getByText("Running")).toBeInTheDocument();
    expect(within(node("learn")).getByText("Working")).toBeInTheDocument();
    expect(node("act").querySelector(".viz-breathe")).not.toBeNull();
  });

  it("routes the return edge around and the rest forward", () => {
    draw(FLOW_LOOP, { direction: "horizontal" });
    expect(edge("learn->sense")).toHaveAttribute("data-route", "around");
    expect(edge("sense->attribute")).toHaveAttribute("data-route", "forward");
    expect(edge("sense->attribute")).toHaveAttribute("data-state", "flowing");
  });

  it("gives a chain's nodes one height across, and centres uneven columns instead", () => {
    draw(FLOW_LOOP, { direction: "horizontal" });
    expect(node("learn")).toHaveClass("grow");
    draw(FLOW_SYSTEM, { direction: "horizontal" });
    expect(node("store")).not.toHaveClass("grow");
  });

  it("lights a failing node with its age and breaks its edge", () => {
    draw(FLOW_SYSTEM);
    const bing = node("bing");
    expect(bing).toHaveAttribute("data-state", "error");
    expect(bing.querySelector("[data-flow-age]")).toHaveTextContent("6h");
    expect(bing).toHaveTextContent("Failing, for 6h");
    expect(edge("bing->collectors")).toHaveAttribute("data-state", "broken");
    expect(node("uptime").querySelector("[data-flow-age]")).toHaveTextContent("37m");
    // Uptime states no edge state: its failure breaks the edge.
    expect(edge("uptime->collectors")).toHaveAttribute("data-state", "broken");
    expect(edge("ga4->collectors")).toHaveAttribute("data-state", "flowing");
    expect(node("backups")).toHaveTextContent("Failed, for 6h");
    expect(steps()).toContain("Job runner → Backups (broken)");
  });

  it("shows no age where none is known, and none on a healthy node", () => {
    draw({ ...FLOW_SYSTEM, nodes: FLOW_SYSTEM.nodes.map((n) => (n.id === "bing" ? { ...n, since: null } : n)) });
    expect(node("store").querySelector("[data-flow-age]")).toBeNull();
    expect(node("bing").querySelector("[data-flow-age]")).toBeNull();
    expect(node("bing")).not.toHaveTextContent("—");
    expect(node("bing")).toHaveTextContent("Failing");
  });

  it("names an unconnected part rather than drawing a zero", () => {
    draw(FLOW_ABSENT);
    const ads = node("ads");
    expect(ads).toHaveAttribute("data-state", "absent");
    expect(ads).toHaveClass("viz-hatch", "border-dashed");
    expect(ads).toHaveTextContent("Not connected");
    expect(ads).not.toHaveTextContent("0");
    expect(edge("ads->store")).toHaveAttribute("data-state", "idle");
  });

  it("speaks a task's own state words and marks the blocked edge", () => {
    draw(FLOW_DEPENDENCIES);
    expect(within(node("access")).getByText("Blocked")).toBeInTheDocument();
    expect(within(node("headline")).getByText("Done")).toBeInTheDocument();
    expect(node("access")).toHaveAttribute("data-column", "1");
    expect(edge("access->launch")).toHaveAttribute("data-state", "broken");
    expect(edge("launch->read")).toHaveAttribute("data-state", "idle");
  });

  it("makes a node with a destination a link, and leaves the rest as text", () => {
    draw(FLOW_SYSTEM);
    const link = screen.getByRole("link", { name: /Bing/ });
    expect(link).toHaveAttribute("href", "/integrations?provider=bing");
    expect(link).toHaveAttribute("data-flow-node", "bing");
    expect(link.className).toContain("focus-visible:ring-2");
    expect(node("store").tagName).toBe("DIV");
  });

  it("never cuts a name: a long label wraps between whole words and keeps its full text", () => {
    draw(FLOW_DEPENDENCIES);
    const label = within(node("access")).getByText("Grant analytics access");
    expect(label).not.toHaveClass("line-clamp-2");
    expect(label).not.toHaveClass("truncate");
    expect(label).toHaveAttribute("title", "Grant analytics access");
  });

  it("stacks into one column down, with lanes for the edges that pass other nodes", () => {
    draw(FLOW_SYSTEM, { direction: "vertical" });
    expect(screen.getByRole("figure")).toHaveAttribute("data-direction", "vertical");
    expect(edge("mediavine->collectors")).toHaveAttribute("data-route", "straight");
    expect(edge("bing->collectors")).toHaveAttribute("data-route", "bypass");
    expect(edge("store->tower")).toHaveAttribute("data-route", "straight");
    expect(edge("store->runner")).toHaveAttribute("data-route", "bypass");
    expect(edge("runner->backups")).toHaveAttribute("data-route", "straight");
  });

  it("chooses its direction by its own width, not the window's", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-flow-graph") ? 420 : 0;
    });
    try {
      draw(FLOW_LOOP);
      expect(screen.getByRole("figure")).toHaveAttribute("data-direction", "vertical");
    } finally {
      width.mockRestore();
    }
  });

  it("draws nothing from boxes it could not measure", () => {
    draw(FLOW_SYSTEM);
    expect(document.querySelectorAll("[data-flow-edge]")).toHaveLength(FLOW_SYSTEM.edges.length);
    expect(document.querySelectorAll("[data-flow-edge] path")).toHaveLength(0);
  });
});

describe("FlowGraph drawn from measured boxes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws every edge once the nodes have boxes", () => {
    const at = new Map<string, number>(FLOW_LOOP.nodes.map((n, i) => [n.id, i]));
    const place = (el: HTMLElement, axis: "x" | "y" | "w" | "h") => {
      if (el.hasAttribute("data-flow-graph")) return axis === "w" ? 1200 : 0;
      const id = el.getAttribute("data-flow-node");
      if (id === null) return 0;
      return { x: at.get(id)! * 240, y: 20, w: 200, h: 120 }[axis];
    };
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return place(this, "w"); });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return place(this, "x"); });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return place(this, "y"); });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return place(this, "w"); });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return place(this, "h"); });
    draw(FLOW_LOOP);
    expect(screen.getByRole("figure")).toHaveAttribute("data-direction", "horizontal");
    for (const e of FLOW_LOOP.edges) {
      const d = edge(`${e.from}->${e.to}`).querySelector("path")?.getAttribute("d") ?? "";
      expect(d).toMatch(/^M/);
      expect(d).not.toContain("NaN");
    }
    expect(document.querySelector('[data-flow-edge-label="learn->sense"]')).toHaveTextContent("next round");
  });
});

describe("flowRoutes", () => {
  const row = (ids: string[], y = 0): Map<string, FlowBox> => new Map(ids.map((id, i) => [id, { x: i * 240, y, w: 200, h: 100 }]));

  it("does not crash or invent coordinates on zero boxes", () => {
    const zero = new Map(FLOW_SYSTEM.nodes.map((n) => [n.id, { x: 0, y: 0, w: 0, h: 0 }]));
    for (const direction of ["horizontal", "vertical"] as const) {
      const routes = flowRoutes(FLOW_SYSTEM.nodes, FLOW_SYSTEM.edges, direction, zero);
      expect(routes.size).toBe(FLOW_SYSTEM.edges.length);
      for (const route of routes.values()) expect(`${route.d}${route.arrow}`).not.toContain("NaN");
    }
    expect(flowRoutes(FLOW_SYSTEM.nodes, FLOW_SYSTEM.edges, "horizontal", new Map()).size).toBe(0);
  });

  it("runs a loop under every node and a forward edge between its columns", () => {
    const boxes = row(FLOW_LOOP.nodes.map((n) => n.id));
    const routes = flowRoutes(FLOW_LOOP.nodes, FLOW_LOOP.edges, "horizontal", boxes);
    const loop = routes.get("learn->sense:4")!;
    expect(loop.mid.y).toBeGreaterThan(100);
    expect(loop.label).not.toBeNull();
    const forward = routes.get("sense->attribute:0")!;
    expect(forward.mid.x).toBeGreaterThan(200);
    expect(forward.mid.x).toBeLessThan(240);
    expect(forward.d.startsWith("M200 50")).toBe(true);
  });

  it("spreads the edges arriving on one side so none share a point", () => {
    const boxes = new Map<string, FlowBox>(FLOW_SYSTEM.nodes.map((n, i) => [n.id, { x: i < 5 ? 0 : (i - 4) * 240, y: i < 5 ? i * 80 : 160, w: 200, h: 64 }]));
    const routes = flowRoutes(FLOW_SYSTEM.nodes, FLOW_SYSTEM.edges, "horizontal", boxes);
    const arrows = FLOW_SYSTEM.edges.flatMap((e, i) => (e.to === "collectors" ? [routes.get(`${e.from}->collectors:${i}`)!.arrow] : []));
    expect(arrows).toHaveLength(5);
    expect(new Set(arrows).size).toBe(5);
  });

  it("keeps lanes beside the stacked column and loops beside it on the other side", () => {
    const boxes = new Map<string, FlowBox>(FLOW_LOOP.nodes.map((n, i) => [n.id, { x: 32, y: i * 140, w: 300, h: 100 }]));
    const routes = flowRoutes(FLOW_LOOP.nodes, FLOW_LOOP.edges, "vertical", boxes);
    expect(routes.get("learn->sense:4")!.mid.x).toBeGreaterThan(332);
    expect(routes.get("learn->sense:4")!.label).toBeNull();
    const deps = new Map<string, FlowBox>(["headline", "variant", "access", "launch", "read"].map((id, i) => [id, { x: 32, y: i * 140, w: 300, h: 100 }]));
    const lane = flowRoutes(FLOW_DEPENDENCIES.nodes, FLOW_DEPENDENCIES.edges, "vertical", deps).get("variant->launch:1")!;
    expect(lane.mid.x).toBeLessThan(32);
  });
});
