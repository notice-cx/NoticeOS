import { Fragment, type ReactNode } from "react";
import type { HomeModuleId } from "@shared/views";

/*
 * Home is a list of modules, not a fixed page, because the person's view
 * (`useView`) decides which of them are drawn and in what order: Everything
 * draws the first eight of `HOME_MODULES` in order, which is the page as it
 * always was, a narrower view draws a few, and a focus pick moves one to the
 * front. Everything keeps its twelve-column grid, each module carrying its own
 * span, with Problems, Decide and the agents' line stacked in one column
 * whenever they come in a run. Every other view is drawn as rows of column
 * stacks (`homeRows`), so no module is stretched to the height of the one
 * beside it.
 */

/** The modules that share one stacked column in Everything's grid. */
const STACKED: ReadonlySet<HomeModuleId> = new Set(["problems", "decide", "agents"]);

/** How wide a module is drawn outside Everything: a row of its own, the
 * left column of a row (eight of twelve) or the right one (four). */
export const MODULE_WIDTH: Record<HomeModuleId, "full" | "wide" | "narrow"> = {
  health: "full",
  sites: "full",
  timeline: "full",
  money: "wide",
  factory: "wide",
  channels: "wide",
  sources: "wide",
  gaps: "narrow",
  problems: "narrow",
  decide: "narrow",
  agents: "narrow",
  yesterday: "narrow",
};

export type HomeSlot =
  | { stacked: false; module: HomeModuleId }
  | { stacked: true; modules: HomeModuleId[] };

/** Everything's grid children, in order: a module alone, or a run of stacked ones. */
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
 * The rows of every view but Everything: a full-width module is a row of its
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
 * element. In the `grid` layout (Everything) that element carries its span
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
            className="grid content-start items-start gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-4 @6xl:grid-cols-1 [&>*]:min-w-0"
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
