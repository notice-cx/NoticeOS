import { demoVisitBase } from "@/lib/demo-visit";
import { Navigate, type RouteObject, createBrowserRouter } from "react-router-dom";
import { lazyPage, prefetchRoute } from "@/lib/lazy-route";
import { AliasRedirect } from "@/routes/AliasRedirect";
import { PropertyRedirect } from "@/routes/PropertyRedirect";

/**
 * Every desk route, rendered inside `AppShell` (bead `ro-pbzu.1`) — one left
 * sidebar and one page header, so navigation does not depend on which page the
 * operator is standing on.
 *
 * EACH SCREEN IS ITS OWN FILE (bead `ro-82x`). A route here names the module
 * that draws it through `lazyPage` instead of importing it, so the first load of
 * an address downloads the shell plus that one screen, and the rest arrive when
 * somebody goes there. The redirects stay plain elements: they are a few lines
 * each, and an alias should answer without a round trip. Adding a screen means
 * adding a `lazyPage(() => import(...))` line — a static import of a route
 * module here puts that screen back into every page's first download, which
 * `test/route-split.test.ts` refuses.
 *
 * Exported so a test can address the desk table directly: the shell is a layout
 * route with no path of its own, so `routes` no longer lists a desk page.
 */
export const deskRoutes: RouteObject[] = [
  { path: "/", ...lazyPage(() => import("@/routes/HomeRoute")) },
  { path: "/workflows/:id?", ...lazyPage(() => import("@/routes/WorkflowsRoute")) },
  // `/assets` is CANONICAL, and since D20 the UI says Assets too — one noun in
  // the label, the URL, the API and the ids. `/properties` is the older
  // spelling and stays an alias, so every deep link the Tower has ever emitted
  // still lands where it aimed.
  { path: "/assets", ...lazyPage(() => import("@/routes/AssetsRoute")) },
  // ADD AN ASSET (bead `ro-qsoo`). It is registered BEFORE the asset page and is
  // a STATIC segment, so `/assets/new` can never be read as an asset called
  // "new": react-router ranks a static segment above a dynamic one whatever the
  // order, and the order here says the same thing to a reader. `apps/tower/
  // test/asset-new-route.test.tsx` asserts the ranking rather than trusting it.
  { path: "/assets/new", ...lazyPage(() => import("@/routes/AssetNewRoute")) },
  // The asset page is tabbed and the tab is the URL (bead `ro-pbzu.4`):
  // `/assets/:id` is Overview. The remaining tabs are growth, financials,
  // search, alerts, tasks, activity, sources and settings (`AssetTabs.tsx`).
  // `tasks` was added by `ro-l1ed.5`, the Tasks
  // index pinned to this asset's project. ONE route with an optional segment,
  // so switching tabs changes a param instead of remounting the page — the
  // outcome-check seed a Growth row hands to the Activity composer has to
  // survive the switch. An unrecognized tab falls back to Overview rather than
  // 404ing: a mistyped tab is still an asset the operator asked for.
  { path: "/assets/:id/:tab?", ...lazyPage(() => import("@/routes/AssetDetailRoute")) },
  { path: "/properties", element: <AliasRedirect to="/assets" /> },
  { path: "/properties/:id/:tab?", element: <PropertyRedirect /> },
  // Alerts is tabbed on the same contract the asset page uses (bead `ro-ju7f`):
  // `/alerts` IS Open and `/alerts/history` is the settled archive, one route
  // with an optional segment. An unrecognized tab falls back to Open rather
  // than 404ing.
  { path: "/alerts/:tab?", ...lazyPage(() => import("@/routes/AlertsRoute")) },
  // `/tasks` is CANONICAL since D19 (bead `ro-l1ed.2`): the board is a task
  // index you can act on, and label, URL and lexicon now say one noun. `/work`
  // is the address it answered at from 2026-08-01 and stays an alias — it is in
  // notes, commit messages and every Home tile emitted before the rename, and a
  // 404 on a path that used to answer is worse than two paths for one page. It
  // keeps the query and the hash, so `/work?status=blocked` is still that view.
  { path: "/tasks", ...lazyPage(() => import("@/routes/TasksRoute")) },
  // One bead, whole (D19, bead `ro-l1ed.3`) — the page every monospace bead id
  // in the Tower now points at. The index above and this detail are registered
  // independently so a deep link to a task never depends on the board.
  { path: "/tasks/:id", ...lazyPage(() => import("@/routes/TaskRoute")) },
  { path: "/work", element: <AliasRedirect to="/tasks" /> },
  { path: "/financials", ...lazyPage(() => import("@/routes/FinancialsRoute")) },
  { path: "/health", ...lazyPage(() => import("@/routes/HealthRoute")) },
  {
    path: "/health/operations/:id?",
    ...lazyPage(() => import("@/routes/WorkflowsRoute"), { props: { surface: "system" } }),
  },
  // `/integrations` IS ITS OWN PAGE since bead `ro-vu8d.2` — connect, test and
  // disconnect a provider's credential. It was an alias for `/health` from bead
  // `ro-034` until then, which put a page that can only OBSERVE connections at
  // the address an operator goes to in order to MAKE one. The alias is
  // deliberately not kept: unlike `/properties` and `/work`, this path did not
  // move — it stayed, and what answers on it grew the actions its name always
  // promised. `/health` keeps every link that ever pointed at the matrix.
  { path: "/integrations", ...lazyPage(() => import("@/routes/IntegrationsRoute")) },
  { path: "/settings", ...lazyPage(() => import("@/routes/SettingsRoute")) },
  // THE TELEVISION'S LAYOUT IS EDITED ON THE DESK, NEVER ON THE TELEVISION
  // (docs/15 flow D, bead `ro-lzmq.2`): `/wall/edit` is a shell page like every
  // other, and `/wall` below stays outside the shell with no edit affordance
  // anywhere on it. The two addresses are one segment apart on purpose — the
  // operator arranges the television here and then opens it — and the editor is
  // reached from Settings and the palette, never from the TV.
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

/** Fetch the code behind a link the operator is about to use (bead `ro-82x`). */
function prefetch(to: string): void {
  prefetchRoute(routes, to);
}

// Dev-only: visual galleries and their code-split chunks exist only in dev.
// The dynamic imports live inside this DEV guard so production dead-code-
// eliminates them entirely — no fixture data ships to the CDN (doc 14).
if (import.meta.env.DEV) {
  deskRoutes.push(
    { path: "/dev/kitchen-sink", ...lazyPage(() => import("@/routes/KitchenSinkRoute")) },
  );
}

export function createTowerRouter() {
  return createBrowserRouter(routes, { basename: demoVisitBase() });
}
