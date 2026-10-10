import { demoVisitBase } from "@/lib/demo-visit";
import { Navigate, type RouteObject, createBrowserRouter } from "react-router-dom";
import { lazyPage, prefetchRoute } from "@/lib/lazy-route";
import { AliasRedirect } from "@/routes/AliasRedirect";
import { PropertyRedirect } from "@/routes/PropertyRedirect";

/**
 * Every desk route, rendered inside `AppShell`. Each screen is its own file:
 * a route names the module that draws it through `lazyPage`, so the first
 * load of an address downloads the shell plus that one screen. A static
 * import of a route module here puts that screen back into every page's
 * first download, which `test/route-split.test.ts` refuses. Exported so a
 * test can address the desk table directly.
 */
export const deskRoutes: RouteObject[] = [
  { path: "/", ...lazyPage(() => import("@/routes/HomeRoute")) },
  { path: "/workflows/:id?", ...lazyPage(() => import("@/routes/WorkflowsRoute")) },
  // `/assets` is canonical; `/properties` is an older spelling kept as an
  // alias so every deep link ever emitted still lands.
  { path: "/assets", ...lazyPage(() => import("@/routes/AssetsRoute")) },
  // Add an asset: a static segment, so `/assets/new` can never be read as an
  // asset called "new" (react-router ranks a static segment above a dynamic
  // one; `test/asset-new-route.test.tsx` asserts it).
  { path: "/assets/new", ...lazyPage(() => import("@/routes/AssetNewRoute")) },
  // The asset page is tabbed and the tab is the URL: `/assets/:id` is
  // Overview (`AssetTabs.tsx` names the rest). One route with an optional
  // segment, so switching tabs changes a param instead of remounting the
  // page; the outcome-check seed a row hands to the Activity composer has to
  // survive the switch. An unrecognized tab falls back to Overview.
  { path: "/assets/:id/:tab?", ...lazyPage(() => import("@/routes/AssetDetailRoute")) },
  { path: "/properties", element: <AliasRedirect to="/assets" /> },
  { path: "/properties/:id/:tab?", element: <PropertyRedirect /> },
  // Alerts is tabbed on the same contract: `/alerts` is Open and
  // `/alerts/history` is the settled archive. An unrecognized tab falls back
  // to Open.
  { path: "/alerts/:tab?", ...lazyPage(() => import("@/routes/AlertsRoute")) },
  // `/tasks` is canonical; `/work` is an older address kept as an alias that
  // keeps the query and the hash, so `/work?status=blocked` is still that view.
  { path: "/tasks", ...lazyPage(() => import("@/routes/TasksRoute")) },
  // One task, whole: the page every task id in the Tower points at. Registered
  // independently of the index so a deep link to a task never depends on the
  // board.
  { path: "/tasks/:id", ...lazyPage(() => import("@/routes/TaskRoute")) },
  { path: "/work", element: <AliasRedirect to="/tasks" /> },
  { path: "/financials", ...lazyPage(() => import("@/routes/FinancialsRoute")) },
  { path: "/health", ...lazyPage(() => import("@/routes/HealthRoute")) },
  {
    path: "/health/operations/:id?",
    ...lazyPage(() => import("@/routes/WorkflowsRoute"), { props: { surface: "system" } }),
  },
  // `/integrations` connects, tests and disconnects a provider's credential;
  // `/health` is the observed matrix.
  { path: "/integrations", ...lazyPage(() => import("@/routes/IntegrationsRoute")) },
  { path: "/settings", ...lazyPage(() => import("@/routes/SettingsRoute")) },
  // The television's layout is edited on the desk, never on the television:
  // `/wall/edit` is a shell page, and `/wall` below stays outside the shell
  // with no edit affordance anywhere on it.
  { path: "/wall/edit", ...lazyPage(() => import("@/routes/WallEditRoute")) },
];

export const routes: RouteObject[] = [
  // The desk shell is its own file too: the sidebar, the command palette and
  // the dialog machinery under it are desk chrome, and the TV below renders
  // outside the shell, so a first load of `/wall` must not pay for them. The
  // shell and the page are fetched side by side, and neither is drawn until
  // both are here. The shell is handed the prefetcher rather than importing
  // this table: this file names the shell, so a sidebar reaching back up for
  // the table would be a cycle.
  {
    ...lazyPage(() => import("@/components/AppShell"), { props: { onPrefetch: prefetch } }),
    children: deskRoutes,
  },
  // The TV stays OUTSIDE the shell: it is read-only, it has no navigation, and
  // its tokens assume the dark emissive palette the theme toggle must not reach.
  // Its loading frame is the TV's own true black, never the desk's canvas.
  { path: "/wall", ...lazyPage(() => import("@/routes/WallRoute"), { surface: "wall" }) },
  { path: "*", element: <Navigate to="/" replace /> },
];

/** Fetch the code behind a link the operator is about to use. */
function prefetch(to: string): void {
  prefetchRoute(routes, to);
}

// Dev-only: visual galleries and their code-split chunks exist only in dev.
// The dynamic imports live inside this DEV guard so production dead-code-
// eliminates them entirely and no fixture data ships.
if (import.meta.env.DEV) {
  deskRoutes.push(
    { path: "/dev/kitchen-sink", ...lazyPage(() => import("@/routes/KitchenSinkRoute")) },
  );
}

export function createTowerRouter() {
  return createBrowserRouter(routes, { basename: demoVisitBase() });
}
