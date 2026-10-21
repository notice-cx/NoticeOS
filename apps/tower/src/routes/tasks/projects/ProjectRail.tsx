import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { ProgressRing } from "@/components/ProgressRing";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { KindIcon, PROJECT_STATE_TONE, SiteMark, TONE_TEXT, projectStateLine } from "./project-face";
import type { ProjectRecord } from "./project-model";

export interface RailItem {
  record: ProjectRecord;
  /** All-time progress, when a rollup carries it; else the record's own count. */
  progress?: { closed: number; total: number } | null;
}

/**
 * The projects as one row of compact cards to pick from, the picked one
 * outlined in the accent. A radio group: the arrow keys move the pick, Home
 * and End go to the ends. The row scrolls sideways, snapping to a card, with
 * a fade and a More projects button while more lie to the right.
 */
export function ProjectRail({ items, selected, onSelect, label = "Projects" }: {
  items: readonly RailItem[];
  selected: string;
  onSelect: (id: string) => void;
  label?: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    const measure = () => setMore(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [items.length]);

  function pick(index: number) {
    const item = items[index];
    if (!item) return;
    onSelect(item.record.id);
    const button = [...(rail.current?.querySelectorAll<HTMLButtonElement>("[data-rail-item]") ?? [])]
      .find((node) => node.dataset.railItem === item.record.id);
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = items.findIndex((item) => item.record.id === selected);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      pick((Math.max(0, at) + step + items.length) % items.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      pick(event.key === "Home" ? 0 : items.length - 1);
    }
  }

  const focusable = items.some((item) => item.record.id === selected) ? selected : items[0]?.record.id;
  return (
    <div className="relative min-w-0" data-project-rail={items.length}>
      <div
        ref={rail}
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain scroll-smooth pb-1 motion-reduce:scroll-auto"
      >
        {items.map(({ record, progress }) => {
          const checked = record.id === selected;
          const done = progress ?? { closed: record.closed, total: record.total };
          return (
            <button
              key={record.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={record.id === focusable ? 0 : -1}
              onClick={() => onSelect(record.id)}
              className={cn(
                "flex w-60 shrink-0 snap-start flex-col gap-2 rounded-lg border bg-card p-3 text-start outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring motion-reduce:transition-none",
                checked ? "border-primary ring-1 ring-primary" : "border-border hover:bg-muted/40",
              )}
              data-rail-item={record.id}
            >
              <span className="flex items-start gap-2">
                <KindIcon record={record} />
                <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{record.title}</span>
                <ProgressRing size="md" done={done.closed} total={Math.max(1, done.total)} title={`${formatInt(done.closed)} of ${formatInt(done.total)} done`} />
              </span>
              <span className={cn("text-xs font-medium tabular-nums", TONE_TEXT[PROJECT_STATE_TONE[record.state]])} data-rail-state={record.state}>
                {projectStateLine(record)}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <SiteMark asset={record.site.asset} name={record.site.name} className="size-4" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{record.site.name}</span>
              </span>
            </button>
          );
        })}
      </div>
      {more ? (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-linear-to-l from-card to-transparent" />
          <button
            type="button"
            aria-label="More projects"
            title="More projects"
            onClick={() => rail.current?.scrollBy({ left: rail.current.clientWidth, behavior: "smooth" })}
            className="absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-border bg-card text-foreground shadow-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring"
            data-rail-more=""
          >
            <ChevronRight aria-hidden className="size-4" />
          </button>
        </>
      ) : null}
    </div>
  );
}
