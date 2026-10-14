import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnswerBlocks, BoardBlocks, Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dismissBootSplash } from "@/lib/boot-splash";

/**
 * Which frame the missing code is drawn in: a whole desk page inside the shell,
 * the whole TV, an asset tab's panel (`panel`), or the command palette's box
 * over the page (`palette`).
 */
export type RouteSurface = "desk" | "wall" | "panel" | "palette";

/**
 * What stands in for a screen while its code is still arriving: the screen's
 * shape in skeleton blocks, in the space the screen will take, and its words
 * for screen readers. Blocks only, never a digit, a chart mark or a state
 * colour, because a placeholder must never pass for a reading. The blocks wait
 * before they show (`SkeletonGroup`) so a fast load does not flash; a screen
 * reader gets the words at once. The palette draws nothing, since an empty
 * search box would be a control that does not work.
 */
export function RouteLoading({ surface = "desk" }: { surface?: RouteSurface }) {
  if (surface === "palette") return null;
  if (surface === "panel") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-route-loading="panel"
        data-status-for="route:panel"
        className="flex min-h-[50vh] w-full flex-col"
      >
        <span className="sr-only">Loading this section…</span>
        <SkeletonGroup className="gap-5">
          <BoardBlocks />
        </SkeletonGroup>
      </div>
    );
  }
  if (surface === "wall") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-route-loading="wall"
        data-status-for="route:wall"
        className="wall-root flex min-h-screen flex-col bg-background p-2 md:px-wall-inset-x md:py-wall-inset-y"
      >
        <span className="sr-only">Loading the Wall…</span>
        <SkeletonGroup className="flex-1 gap-wall-region">
          <WallBlocks />
        </SkeletonGroup>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      data-route-loading="desk"
      data-status-for="route:desk"
      className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-[1400px] flex-col p-4 md:min-h-screen md:p-6"
    >
      <span className="sr-only">Loading this page…</span>
      <SkeletonGroup className="gap-5">
        <Skeleton className="h-7 w-40" />
        <AnswerBlocks />
        <BoardBlocks />
      </SkeletonGroup>
    </div>
  );
}

/** The TV's frame: the strip, then the money band and the site rows beside
 * the feed, at the Wall's own gaps. */
function WallBlocks() {
  return (
    <>
      <Skeleton className="h-24 rounded-lg" />
      <div className="grid flex-1 gap-wall-region md:grid-cols-12 md:gap-wall-region-x">
        <div className="flex flex-col gap-wall-region md:col-span-8">
          <Skeleton className="h-wall-band rounded-lg" />
          <Skeleton className="min-h-48 flex-1 rounded-lg" />
        </div>
        <Skeleton className="min-h-48 rounded-lg md:col-span-4" />
      </div>
    </>
  );
}

export interface RouteLoadFailureProps {
  surface?: RouteSurface;
  /** Explicit navigation only; existing forms stay in this document. */
  openUpdated?: () => void;
  onDismiss?: () => void;
}

/** What each frame says when its code is gone. The explanation is shared: the
 * cause is the same whichever part of the page asked for the missing file. */
const FAILURE_TITLE: Record<RouteSurface, string> = {
  desk: "This page didn't load",
  wall: "The Wall didn't load",
  panel: "This section didn't load",
  palette: "Search didn't load",
};

function openUpdatedApp() {
  window.open(window.location.href, '_blank', 'noopener,noreferrer');
}

/** A missing chunk never reloads the document or discards another editor;
 * the operator opens the current app in a new tab. */
export function RouteLoadFailure({
  surface = "desk",
  openUpdated = openUpdatedApp,
  onDismiss,
}: RouteLoadFailureProps) {
  // A screen that cannot draw shows that at once, never behind the boot splash.
  useEffect(() => dismissBootSplash(), []);

  // The palette's box closes on Escape like the palette it stands in for.
  useEffect(() => {
    if (surface !== "palette" || !onDismiss) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [surface, onDismiss]);

  const wall = surface === "wall";
  // A whole screen's message is that screen's heading; a part's message sits
  // under the page heading that did load, so it is one level down.
  const Heading = surface === "desk" || wall ? "h1" : "h2";
  const message = (
    <div
      role="alert"
      data-route-load-failure={surface}
      className={cn(
        wall
          ? "wall-root grid min-h-screen place-items-center bg-background p-6 text-center"
          : surface === "desk"
            ? "mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-[1400px] flex-col p-4 md:min-h-screen md:p-6"
            : surface === "panel"
              ? "flex min-h-[50vh] w-full flex-col"
              : "relative w-full max-w-xl rounded-xl border border-border bg-card p-4 shadow-xl",
      )}
    >
      <div className={cn("flex max-w-prose flex-col gap-2", wall ? "items-center" : "items-start")}>
        <Heading
          className={cn("font-semibold text-foreground", wall ? "text-2xl" : surface === "desk" ? "text-xl" : "text-base")}
        >
          {FAILURE_TITLE[surface]}
        </Heading>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={wall ? "ghost" : "outline"}
            size="sm"
            onClick={openUpdated}
          >
            Open app in new tab
          </Button>
          {surface === "palette" && onDismiss ? (
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              Close
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );

  if (surface !== "palette") return message;
  // Where the palette's own box would have been, over the same backdrop
  // (`ui/command`'s `CommandDialog`), which cannot be reused here because it
  // lives beside cmdk — the very code that did not arrive.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]">
      <button
        type="button"
        aria-label="Close search"
        onClick={onDismiss}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      {message}
    </div>,
    document.body,
  );
}
