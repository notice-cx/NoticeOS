import { Fragment, type ReactNode } from "react";
import type { HomeModuleId } from "@shared/views";

/*
 * Home is a list of modules, not a fixed page, because the person's view
 * (`useView`) decides which of them are drawn and in what order: Everything
 * draws the first eight of `HOME_MODULES` in order, which is the page as it
 * always was, a narrower view draws a few, and a focus pick moves one to the
 * front. Each module keeps its own column span in the twelve-column grid, so
 * an absent module leaves the grid to flow. Problems, Decide and the agents'
 * line stack in one column whenever they come in a run, as they do in
 * Everything; one of them alone still takes that column.
 */

/** The modules that share one stacked column. */
const STACKED: ReadonlySet<HomeModuleId> = new Set(["problems", "decide", "agents"]);

/**
 * The column each module after Everything's eight takes, drawn here around
 * the module's own element so the modules themselves carry no span. The
 * first eight carry their spans in their own elements, as they always have.
 * An eight-column module takes its own content's height (`self-start`), not
 * the height of the stacked column beside it.
 */
export const MODULE_SPAN: Partial<Record<HomeModuleId, string>> = {
  health: "@3xl:col-span-2 @6xl:col-span-12",
  factory: "self-start @3xl:col-span-2 @6xl:col-span-8",
  channels: "self-start @3xl:col-span-2 @6xl:col-span-8",
  gaps: "@3xl:col-span-2 @6xl:col-span-4",
};

/** Whether a list draws any module with a span from `MODULE_SPAN`. Such a
 * list packs the grid densely, so a 4-column module later in the list fills
 * the hole an 8-column one leaves beside the money; Everything's eight never
 * do, and its grid is the one it always was. */
function packsDensely(modules: readonly HomeModuleId[]): boolean {
  return modules.some((module) => MODULE_SPAN[module] !== undefined);
}

export type HomeSlot =
  | { stacked: false; module: HomeModuleId }
  | { stacked: true; modules: HomeModuleId[] };

/** The grid's children, in order: a module alone, or a run of stacked ones. */
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

/**
 * The board's grid, drawing `modules` in order. `draw` returns each module's
 * own element, span classes included; a stacked module returns its content
 * and the column around it is drawn here. Only the listed modules are drawn.
 */
export function HomeModules({ modules, draw }: { modules: readonly HomeModuleId[]; draw: Record<HomeModuleId, () => ReactNode> }) {
  return (
    <div className={packsDensely(modules) ? "grid gap-5 @3xl:grid-cols-2 @6xl:grid-flow-row-dense @6xl:grid-cols-12 [&>*]:min-w-0" : "grid gap-5 @3xl:grid-cols-2 @6xl:grid-cols-12 [&>*]:min-w-0"}>
      {homeSlots(modules).map((slot) =>
        slot.stacked ? (
          <div
            key={slot.modules.join(" ")}
            className="grid content-start items-start gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-4 @6xl:grid-cols-1 [&>*]:min-w-0"
          >
            {slot.modules.map((module) => <Fragment key={module}>{draw[module]()}</Fragment>)}
          </div>
        ) : MODULE_SPAN[slot.module] ? (
          <div key={slot.module} className={MODULE_SPAN[slot.module]} data-home-module={slot.module}>
            {draw[slot.module]()}
          </div>
        ) : (
          <Fragment key={slot.module}>{draw[slot.module]()}</Fragment>
        ),
      )}
    </div>
  );
}
