import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Which frame the missing code is drawn in: a whole desk page inside the shell,
 * the whole TV, or — since bead `ro-ujb9.84` split them off their screens — one
 * PART of a page: an asset tab's panel (`panel`), or the command palette's box
 * over the page (`palette`).
 */
export type RouteSurface = "desk" | "wall" | "panel" | "palette";

/**
 * What stands in for a screen while its code is still arriving (bead `ro-82x`).
 *
 * Since the route split, the code for each screen is its own file, fetched the
 * first time that screen is opened. This is drawn in the space the screen will
 * take — the desk page's column, or the whole TV — and it says one thing:
 * loading. No number, no chart outline, no status colour and no page-shaped
 * skeleton, because anything that looks like data can be read as data, and a
 * placeholder must never pass for a reading of how an asset is doing.
 *
 * The line waits before it shows (`.route-loading-label`): the code usually
 * arrives faster than anyone could read the word, and a word that flashes on
 * every page load is noise. A screen reader gets it at once through the polite
 * status region. The box keeps the page's own width, padding and a full
 * viewport of height, so the page arriving does not move the column or add a
 * scrollbar to a page that had none.
 *
 * The Wall's version is the TV's true black (`.wall-root`), with the same words
 * the Wall shows while its first data poll is out, so code loading and data
 * loading read as one continuous state rather than two flashes.
 *
 * AN ASSET TAB'S version (`panel`, bead `ro-ujb9.84`) sits inside the page the
 * header and tab bar already drew, so it takes the panel's width and a half
 * viewport of height rather than a page's padding: the section is about to fill
 * it, and the footer should not jump up and back down. It is only ever seen on
 * a first load, and then only if the tab's code is slower than the asset's own
 * report; a tab switch keeps the previous tab on screen until the next one's
 * code is here, exactly as a page switch does.
 *
 * THE PALETTE draws nothing while its code arrives (`palette`): it is a box the
 * operator summoned with a key, it appears the moment its code is here, and an
 * empty search box in the meantime would be a control that does not work.
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
        <span className="route-loading-label flex min-h-7 items-center text-sm text-muted-foreground">
          Loading this section…
        </span>
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
        className="wall-root grid min-h-screen place-items-center bg-background text-muted-foreground"
      >
        <span className="route-loading-label">Loading the Wall…</span>
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
      <span className="route-loading-label flex min-h-7 items-center text-sm text-muted-foreground">
        Loading this page…
      </span>
    </div>
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

/** A missing chunk never reloads the document or discards another editor.
 * The operator opens the current app in a new tab (D41). */
export function RouteLoadFailure({
  surface = "desk",
  openUpdated = openUpdatedApp,
  onDismiss,
}: RouteLoadFailureProps) {
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
