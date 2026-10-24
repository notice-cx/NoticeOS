import { useSyncExternalStore } from "react";
import { wallViewportScreen, type WallViewportScreen } from "@/lib/wall-screen";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The window's size as one string, so an unchanged size is an unchanged
 * snapshot and nothing redraws. */
function size(): string {
  return `${window.innerWidth}x${window.innerHeight}`;
}

/** Which Wall this screen gets (`wallScreen`), kept current as the window is
 * resized or a tablet turns. */
export function useWallScreen(): WallViewportScreen {
  const [width, height] = useSyncExternalStore(subscribe, size, () => "1920x1080").split("x").map(Number);
  return wallViewportScreen(width!, height!);
}
