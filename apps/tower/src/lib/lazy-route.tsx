import { lazy, type ComponentType } from "react";
import { matchRoutes, type RouteObject } from "react-router-dom";
import { RouteLoadFailure, RouteLoading, type RouteSurface } from "@/components/RouteLoading";
import { isChunkLoadError } from "@/lib/chunk-recovery";

/**
 * One screen's code, fetched when the screen is first opened (bead `ro-82x`).
 *
 * Until this split `App.tsx` imported every screen, so opening the TV downloaded
 * the task board, the settings forms and the asset page too — 1.5 MB of
 * JavaScript before anything drew, on every address. A route built from this
 * uses react-router's own `lazy` instead: the router fetches the file as part
 * of matching the address, which means
 *
 *  - on the FIRST load the fetch starts while the router is being created,
 *    before React has drawn anything, and `RouteLoading` stands in for the
 *    screen until it lands (`hydrateFallbackElement`);
 *  - on a later NAVIGATION the page being left stays on screen until the next
 *    one's code has arrived — no placeholder flashes between two desk pages;
 *  - a file that can no longer be fetched resolves to `RouteLoadFailure`
 *    instead of throwing, offering an explicit new-tab action. Every other
 *    error still throws, and still reaches whatever handled it before.
 *
 * `props` exists for the two routes that take one: the workflow list, which is
 * also the System operations list at a second address, and the desk shell,
 * which is handed the prefetcher below. Every other route passes nothing and
 * gets the module's own export.
 */
export function lazyPage<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  { surface = "desk", props }: { surface?: RouteSurface; props?: P } = {},
): Pick<RouteObject, "lazy" | "hydrateFallbackElement"> {
  return {
    hydrateFallbackElement: <RouteLoading surface={surface} />,
    lazy: async () => {
      try {
        const Page = (await load()).default;
        if (!props) return { Component: Page as ComponentType };
        return { Component: () => <Page {...props} /> };
      } catch (error) {
        if (!isChunkLoadError(error)) throw error;
        return { Component: () => <RouteLoadFailure surface={surface} /> };
      }
    },
  };
}

const prefetched = new WeakSet<object>();

/**
 * Start fetching the code behind an address without going there — the sidebar
 * calls this when a pointer rests on a link or the keyboard focuses it, so the
 * click that follows usually finds the file already downloaded.
 *
 * It only ever fetches what one address needs; nothing preloads every screen,
 * which would be the monolithic download again with extra steps. A fetch that
 * fails here is silent and forgotten: the real navigation retries, and the
 * recovery above is the one place that decides what a failure means.
 */
export function prefetchRoute(routes: RouteObject[], to: string): void {
  for (const match of matchRoutes(routes, to) ?? []) {
    const lazy = match.route.lazy;
    if (typeof lazy !== "function" || prefetched.has(lazy)) continue;
    prefetched.add(lazy);
    lazy().catch(() => prefetched.delete(lazy));
  }
}

/**
 * One PART of a screen whose code is fetched when it is first drawn (bead
 * `ro-ujb9.84`): an asset tab, the command palette.
 *
 * The route split (`lazyPage` above) made every address download the shell
 * plus its own screen. The asset page then still carried all nine of its tabs
 * in its one file, and every desk page carried cmdk and the palette before
 * anyone pressed ⌘K. A part built from this is React's own `lazy`, drawn inside
 * a `<Suspense>` whose fallback is `RouteLoading` — the same frame, the same
 * recovery and the same rule as a screen:
 *
 *  - the `<Suspense>` belongs to the SCREEN, around the slot its parts take
 *    turns in (the asset page's tab panel), never inside a part. The router
 *    moves between tabs in a transition, and React keeps an already-drawn
 *    boundary on screen during a transition, so the tab being left stays until
 *    the next one's code has arrived — no placeholder flashes between tabs, as
 *    none flashes between pages;
 *  - a file that can no longer be fetched resolves to `failure` instead of
 *    throwing — by default `RouteLoadFailure` in the panel's frame, which
 *    offers an explicit new-tab action — and every other error still throws;
 *  - `preload` starts the fetch early (a pointer resting on a tab, the page
 *    about to show one) and never rejects: a failed prefetch is forgotten, and
 *    the real render tries again and decides what the failure means.
 *
 * ONE DIFFERENCE FROM A BARE `lazy`, and the reason this is a helper: code that
 * has ALREADY arrived — prefetched, or drawn before — is handed to React as a
 * thenable that settles synchronously, which `lazy` reads as loaded on that
 * very render (React's `lazyInitializer` checks the status straight after
 * calling `then`). A bare `lazy` suspends once on its first render however long
 * ago the file landed, which would draw the loading frame for a tick after a
 * hover had already fetched the tab.
 */
export interface LazyPart<P extends object> {
  /** Draw inside a `<Suspense>` owned by the screen. */
  Component: ComponentType<P>;
  /** Fetch the code without drawing it: true once it is here, false if it
   * could not be fetched. Never rejects. */
  preload: () => Promise<boolean>;
}

/** An asset tab's frame for code that is gone: the tab's own panel. */
function PanelLoadFailure() {
  return <RouteLoadFailure surface="panel" />;
}

/** A thenable that calls back at once — `lazy`'s "already loaded". Typed as the
 * promise `lazy` asks for, because `lazy` only ever calls its `then`. */
function arrivedAlready<T>(value: T): Promise<T> {
  const thenable = {
    then(onFulfilled: (value: T) => unknown) {
      onFulfilled(value);
      return thenable;
    },
  };
  return thenable as unknown as Promise<T>;
}

export function lazyPart<P extends object>(
  load: () => Promise<ComponentType<P>>,
  { failure = PanelLoadFailure as ComponentType<P> }: { failure?: ComponentType<P> } = {},
): LazyPart<P> {
  let arrived: ComponentType<P> | null = null;
  let inflight: Promise<ComponentType<P>> | null = null;

  function fetchCode(): Promise<ComponentType<P>> {
    inflight ??= load().then(
      (Part) => (arrived = Part),
      (error: unknown) => {
        // Forget the attempt, so the next render or hover asks again.
        inflight = null;
        throw error;
      },
    );
    return inflight;
  }

  const Component = lazy(() => {
    if (arrived) return arrivedAlready({ default: arrived });
    return fetchCode().then(
      (Part) => ({ default: Part }),
      (error: unknown) => {
        if (!isChunkLoadError(error)) throw error;
        return { default: failure };
      },
    );
  });

  return {
    Component,
    preload: () =>
      fetchCode().then(
        () => true,
        () => false,
      ),
  };
}
