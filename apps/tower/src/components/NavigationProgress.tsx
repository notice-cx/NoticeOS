import { useCallback, useSyncExternalStore } from "react";
import { useLoadingIndicator } from "@/lib/loading-indicator";
import { cn } from "@/lib/utils";

/**
 * A thin line across the top of the window while a navigation is under way.
 * The page being left stays on screen until the next page's code has arrived
 * (react-router's `lazy`), and this line shows the click was taken: nothing
 * for the first 150 ms, at least 300 ms once drawn, then it fills and fades
 * (`useLoadingIndicator`). In the muted ink, never a state colour.
 */
export function NavigationProgress({ busy, className }: { busy: boolean; className?: string }) {
  const phase = useLoadingIndicator(busy);
  if (phase === "hidden") return null;
  return (
    <div
      aria-hidden
      data-navigation-progress={phase}
      className={cn("nav-progress pointer-events-none fixed inset-x-0 top-0 z-40 h-0.5", className)}
    >
      <div className="nav-progress-bar h-full bg-muted-foreground" />
    </div>
  );
}

/** The part of the app's data router the line reads. */
export interface NavigatingRouter {
  subscribe(onChange: () => void): () => void;
  state: { navigation: { state: string } };
}

/** `NavigationProgress` for the app's router: busy while a navigation loads. */
export function RouterNavigationProgress({ router }: { router: NavigatingRouter }) {
  const subscribe = useCallback((onChange: () => void) => router.subscribe(() => onChange()), [router]);
  const busy = useSyncExternalStore(subscribe, () => router.state.navigation.state !== "idle");
  return <NavigationProgress busy={busy} />;
}
