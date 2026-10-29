import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import type { ViewId } from "@shared/views";
import { useView } from "@/hooks/useView";

/** Stable keyed order preserves each section's local selections and unfinished forms. */
export function prioritize<K extends string, T extends { key: K }>(items: readonly T[], priority: readonly K[]): T[] {
  const rank = (key: K) => { const index = priority.indexOf(key); return index < 0 ? priority.length : index; };
  return [...items].sort((a, b) => rank(a.key) - rank(b.key));
}

const SECTIONS: Record<string, Partial<Record<ViewId, readonly string[]>>> = {
  overview: {
    growth: ["setup", "numbers", "lead", "bets", "work", "sources", "verdict", "product", "totals", "findings"],
    revenue: ["setup", "numbers", "verdict", "bets", "work", "sources", "lead", "product", "totals", "findings"],
    delivery: ["setup", "work", "bets", "verdict", "numbers", "sources", "lead", "product", "totals", "findings"],
    reliability: ["setup", "sources", "verdict", "numbers", "work", "bets", "lead", "product", "totals", "findings"],
  },
  growth: {
    revenue: ["product", "journey", "moves", "audience", "search", "panel"],
    delivery: ["journey", "product", "moves", "audience", "search", "panel"],
    reliability: ["journey", "moves", "audience", "search", "product", "panel"],
  },
  financials: {
    growth: ["daily", "month", "ledger"],
    delivery: ["month", "ledger", "daily"],
    reliability: ["ledger", "month", "daily"],
  },
  search: {
    growth: ["analysis", "moves", "panel", "decisions", "context"],
    revenue: ["analysis", "decisions", "moves", "panel", "context"],
    delivery: ["analysis", "decisions", "panel", "moves", "context"],
    reliability: ["analysis", "context", "moves", "panel", "decisions"],
  },
  codebase: {
    delivery: ["hero", "findings", "languages"],
    reliability: ["findings", "hero", "languages"],
  },
  tasks: { delivery: ["board", "decisions"], reliability: ["board", "decisions"] },
  activity: {
    delivery: ["review", "timeline", "reclamation"],
    revenue: ["reclamation", "timeline", "review"],
    reliability: ["review", "timeline", "reclamation"],
  },
  sources: {
    growth: ["paused", "sources", "metrics", "setup", "scheduled", "failures", "health"],
    revenue: ["paused", "sources", "scheduled", "metrics", "setup", "failures", "health"],
    delivery: ["paused", "sources", "setup", "scheduled", "failures", "metrics", "health"],
    reliability: ["paused", "sources", "failures", "health", "scheduled", "setup", "metrics"],
  },
  settings: {
    growth: ["paused", "identity", "panel", "collection", "totals", "lifecycle", "display", "automation", "rules", "archive"],
    revenue: ["paused", "identity", "totals", "panel", "collection", "lifecycle", "display", "automation", "rules", "archive"],
    delivery: ["paused", "identity", "automation", "lifecycle", "collection", "totals", "rules", "panel", "display", "archive"],
    reliability: ["paused", "identity", "collection", "rules", "automation", "lifecycle", "totals", "panel", "display", "archive"],
  },
};

/** Each tab keeps its subject and all of its sections; the view selects what appears first. */
export function PurposeSections({ surface, children, ...props }: ComponentProps<"div"> & { surface: string }) {
  const { view } = useView();
  const sections: { key: string; element: ReactNode }[] = [];
  Children.forEach(children, (element, index) => {
    if (element === null || element === undefined || typeof element === "boolean") return;
    sections.push({ key: isValidElement(element) ? String(element.key) : `text-${index}`, element });
  });
  return <div {...props} data-purpose-view={view.id}>{prioritize(sections, SECTIONS[surface]?.[view.id] ?? []).map((section) => section.element)}</div>;
}

export const MEASURE_PRIORITY: Record<ViewId, readonly ("money" | "people" | "search" | "product")[]> = {
  overview: ["money", "people", "search", "product"],
  growth: ["people", "search", "product", "money"],
  revenue: ["money", "product", "people", "search"],
  delivery: ["product", "people", "money", "search"],
  reliability: ["product", "people", "search", "money"],
};
