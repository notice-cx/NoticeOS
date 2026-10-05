import type { ComponentType } from "react";
import type { RouteObject } from "react-router-dom";

/**
 * The component a route in `App.tsx`'s table draws.
 *
 * Since the route split (bead `ro-82x`) a screen's route names its module
 * through react-router's `lazy` rather than holding an element, so "which page
 * answers at this address" is a question with an `await` in it. This resolves
 * the module exactly the way the router does on a first visit.
 */
export async function componentAt(
  table: RouteObject[],
  path: string,
): Promise<ComponentType | null | undefined> {
  const route = table.find((candidate) => candidate.path === path);
  if (!route) return undefined;
  if (typeof route.lazy === "function") return (await route.lazy()).Component;
  return route.Component;
}
