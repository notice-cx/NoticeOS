import type { ReactNode } from "react";
import type { StatusSubject } from "@/components/StateChip";
import { cn } from "@/lib/utils";

/**
 * One block standing in for content that has not arrived: the size and place
 * of what will be drawn there, in the empty-track colour, with one faint
 * highlight passing across the window (`.skeleton` in index.css). It never
 * holds a digit, a state colour or a mark, so it cannot pass for a reading.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-md", className)} />;
}

/**
 * Blocks laid out as the content they stand in for. Hidden from screen
 * readers (the status around them says loading), and drawn only after
 * 180 ms (`.skeleton-group`), so a fast load goes straight to the content.
 */
export function SkeletonGroup({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div aria-hidden data-skeleton="" className={cn("skeleton-group flex flex-col", className)}>
      {children}
    </div>
  );
}

/** The shape of what a page's first read will draw. */
export type PageSkeletonShape = "board" | "list" | "form";

/**
 * The body of a page whose first read has not answered, under the page's own
 * header: `board` a summary line over a main chart and modules (Home, the TV
 * layout), `list` a summary line over rows (Sites, Alerts, Tasks), `form`
 * labelled fields (Settings). The words are for screen readers; the blocks
 * are drawn in the space the content will take, so nothing moves when it
 * arrives.
 */
export function PageSkeleton({
  subject,
  shape = "board",
  label = "Loading…",
  className,
}: {
  /** The read it waits for: the same subject as the page's `ReadFailed`. */
  subject: StatusSubject;
  shape?: PageSkeletonShape;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" data-status-for={subject} className={cn("flex min-h-[40vh] flex-1 flex-col", className)}>
      <span className="sr-only">{label}</span>
      <SkeletonGroup className="gap-5">
        {shape === "form" ? <FormBlocks /> : <AnswerBlocks />}
        {shape === "board" ? <BoardBlocks /> : null}
        {shape === "list" ? <ListBlocks /> : null}
      </SkeletonGroup>
    </div>
  );
}

/** A page's summary: one sentence at the display size and a muted line. */
export function AnswerBlocks() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-48 max-w-full" />
      <Skeleton className="h-8 w-[36rem] max-w-full" />
    </div>
  );
}

/** A main chart beside a module, over a row of modules. */
export function BoardBlocks() {
  return (
    <div className="grid gap-5 md:grid-cols-12">
      <Skeleton className="h-64 rounded-lg md:col-span-8" />
      <Skeleton className="h-64 rounded-lg md:col-span-4" />
      <Skeleton className="h-40 rounded-lg md:col-span-4" />
      <Skeleton className="h-40 rounded-lg md:col-span-4" />
      <Skeleton className="h-40 rounded-lg md:col-span-4" />
    </div>
  );
}

/** A row of filters over a panel of rows. */
function ListBlocks() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-14 rounded-none" />
        ))}
      </div>
    </div>
  );
}

/** Labelled fields in one readable column. */
function FormBlocks() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      {[0, 1, 2, 3].map((field) => (
        <div key={field} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10" />
        </div>
      ))}
    </div>
  );
}
