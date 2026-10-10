import { lazy, type ComponentType } from "react";
import { matchRoutes, type RouteObject } from "react-router-dom";
import { RouteLoadFailure, RouteLoading, type RouteSurface } from "@/components/RouteLoading";
import { isChunkLoadError } from "@/lib/chunk-recovery";

/**
 * One screen's code, fetched through react-router's `lazy` when first opened,
 * so the page being left stays on screen until the next one's code arrives. A
 * file that can no longer be fetched resolves to `RouteLoadFailure`; every
 * other error still throws.
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
 * A fetch that fails here is silent and forgotten: the real navigation
 * retries, and `lazyPage` decides what a failure means.
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
 * One part of a screen whose code is fetched when it is first drawn (an asset
 * tab, the command palette). Draw it inside a `<Suspense>` owned by the screen
 * around the slot its parts share, never inside a part, so the part being left
 * stays through the transition. A file that can no longer be fetched resolves
 * to `failure`; `preload` never rejects.
 *
 * Unlike a bare `lazy`, code that has already arrived is handed to React as a
 * synchronously settled thenable, so a part a hover already fetched draws
 * without a loading frame.
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
