import { Fragment, type ReactNode } from "react";
import type { HomeModuleId } from "@shared/views";

/*
 * Home draws each purpose's modules in order, with personal focus picks first.
 * Overview uses a twelve-column grid with a shared group for its small cards.
 * Other purposes use content-height column stacks between full-width modules.
 */

/** The overview cards that share a two-column group in Overview. */
const STACKED: ReadonlySet<HomeModuleId> = new Set(["problems", "decide", "agents", "yesterday"]);

/** Full-width modules form their own rows; other modules stack in an
 * eight-column section or a four-column section beside it. */
export const MODULE_WIDTH: Record<HomeModuleId, "full" | "wide" | "narrow"> = {
  health: "full",
  sites: "full",
  timeline: "full",
  money: "wide",
  factory: "wide",
  channels: "wide",
  problems: "wide",
  gaps: "wide",
  decide: "narrow",
  agents: "narrow",
  yesterday: "narrow",
};

export type HomeSlot =
  | { stacked: false; module: HomeModuleId }
  | { stacked: true; modules: HomeModuleId[] };

/** Overview's grid children, in order: a module alone, or a run of stacked ones. */
export function homeSlots(modules: readonly HomeModuleId[]): HomeSlot[] {
  const slots: HomeSlot[] = [];
  for (const module of modules) {
    const last = slots.at(-1);
    if (!STACKED.has(module)) slots.push({ stacked: false, module });
    else if (last?.stacked) last.modules.push(module);
    else slots.push({ stacked: true, modules: [module] });
  }
  return slots;
}

export type HomeRow =
  | { full: true; module: HomeModuleId }
  | { full: false; wide: HomeModuleId[]; narrow: HomeModuleId[] };

/**
 * The rows of every purpose but Overview: a full-width module is a row of its
 * own; the modules between two full-width ones form one row whose wide
 * modules stack in the left column and narrow ones in the right, each in the
 * list's order.
 */
export function homeRows(modules: readonly HomeModuleId[]): HomeRow[] {
  const rows: HomeRow[] = [];
  for (const module of modules) {
    const width = MODULE_WIDTH[module];
    if (width === "full") {
      rows.push({ full: true, module });
      continue;
    }
    let last = rows.at(-1);
    if (!last || last.full) {
      last = { full: false, wide: [], narrow: [] };
      rows.push(last);
    }
    last[width].push(module);
  }
  return rows;
}

/** One module in a stack, at its own content's height. */
function Stacked({ module, draw }: { module: HomeModuleId; draw: Record<HomeModuleId, () => ReactNode> }) {
  return (
    <div className="min-w-0" data-home-module={module}>
      {draw[module]()}
    </div>
  );
}

/**
 * The board, drawing `modules` in order. `draw` returns each module's own
 * element. In the `grid` layout (Overview) that element carries its span
 * and a stacked module's column is drawn here; in the `stacks` layout each
 * row is two flex columns that fall back to one, in the list's order, below
 * the twelve-column width. Only the listed modules are drawn.
 */
export function HomeModules({
  modules,
  draw,
  layout = "grid",
}: {
  modules: readonly HomeModuleId[];
  draw: Record<HomeModuleId, () => ReactNode>;
  layout?: "grid" | "stacks";
}) {
  if (layout === "stacks") {
    return (
      <div className="flex flex-col gap-5" data-home-layout="stacks">
        {homeRows(modules).map((row) =>
          row.full ? (
            <Stacked key={row.module} module={row.module} draw={draw} />
          ) : (
            <div key={[...row.wide, ...row.narrow].join(" ")} className="grid items-start gap-5 @6xl:grid-cols-12 [&>*]:min-w-0" data-home-row="">
              {row.wide.length > 0 ? (
                <div className="flex flex-col gap-5 @6xl:col-span-8" data-home-stack="wide">
                  {row.wide.map((module) => <Stacked key={module} module={module} draw={draw} />)}
                </div>
              ) : null}
              {row.narrow.length > 0 ? (
                <div className={row.wide.length > 0 ? "flex flex-col gap-5 @6xl:col-span-4" : "flex flex-col gap-5 @6xl:col-span-4 @6xl:col-start-9"} data-home-stack="narrow">
                  {row.narrow.map((module) => <Stacked key={module} module={module} draw={draw} />)}
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-5 @3xl:grid-cols-2 @6xl:grid-cols-12 [&>*]:min-w-0">
      {homeSlots(modules).map((slot) =>
        slot.stacked ? (
          <div
            key={slot.modules.join(" ")}
            className="grid content-start items-start gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-12 [&>*]:min-w-0"
            data-home-overview=""
          >
            {slot.modules.map((module) => <Fragment key={module}>{draw[module]()}</Fragment>)}
          </div>
        ) : (
          <Fragment key={slot.module}>{draw[slot.module]()}</Fragment>
        ),
      )}
    </div>
  );
}
