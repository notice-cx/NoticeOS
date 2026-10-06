import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetDetailRoute, ASSET_TABS, type AssetTab } from "@/routes/AssetDetailRoute";
import { everyTabPayload as payload } from "./asset-detail-fixture";
import { loadAssetTabs } from "./lazy-code";
import { stubJsonFetch } from "./stub-fetch";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

// The clock and the calendar are pinned before anything imports a formatter, so
// the recorded DOM is the same on the office Mac and in CI. `vi.hoisted` is the
// only place that runs early enough to matter for `process.env.TZ`.
vi.hoisted(() => {
  process.env.TZ = "UTC";
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The moment every age badge on the page is measured from. Stubbed rather than
 * faked with timers, because TanStack Query and Testing Library's `waitFor` both
 * want a real event loop. */
const NOW = Date.parse("2026-07-05T14:00:00.000Z");

/**
 * THE PIN FOR THE PER-TAB SPLIT (bead `ro-78qo.2`).
 *
 * `AssetDetailRoute.tsx` was one 5,796-line file holding every tab; it is now a
 * route that composes eight tab files. That move had to be invisible, so this
 * suite records the rendered DOM of every tab for one payload that has something
 * on all of them, and the snapshot taken before the move is the snapshot after
 * it.
 *
 * It keeps earning its place afterwards: doc 21 rebuilds these tabs one at a
 * time, and a diff here says exactly which tab a change reached — a redesign
 * updates the recorded DOM deliberately (`vitest -u`), an accident does not.
 *
 * RE-RECORDED ON PURPOSE, 2026-09-05 (`ro-78qo.4`): the Growth tab became four
 * charts and three strips, a Search tab joined the bar after it, and every tab's
 * snapshot moved because the bar itself gained an entry. The Growth diff is the
 * redesign; the Search entry is new; the other six differ by exactly one tab
 * link, and a seventh line of difference in any of them is the accident this
 * file exists to catch.
 */
function testClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
}

/**
 * React and Radix mint an id per mount, so two runs of the same tree differ in
 * `:r3:` and `radix-:r7:` alone. Those are identity, not content.
 *
 * `_r_N_` is React 19's own form of the same thing, and it is COUNTED: adding a
 * `useId` anywhere earlier in the tree renumbers every one after it, so a
 * change on Overview was renaming labels on Settings (bead `ro-78qo.3`). A pin
 * that reports which tab a change reached has to be blind to that, or the next
 * agent reads six false positives.
 *
 * One element per line, because a recorded page on a single 100KB line is a
 * diff nobody can read — and the whole value of this file is the diff.
 */
function normalise(html: string): string {
  return html
    .replaceAll(/«r[0-9a-z]+»/g, "«rID»")
    .replaceAll(/:r[0-9a-z]+:/g, ":rID:")
    .replaceAll(/_r_[0-9a-z]+_/g, "_rID_")
    .replaceAll(/radix-[0-9a-z-]+/g, "radix-ID")
    .replaceAll("><", ">\n<");
}

function renderTab(tab: AssetTab) {
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter
        initialEntries={[`/assets/meals.example${tab === "overview" ? "" : `/${tab}`}`]}
      >
        <Routes>
          <Route path="/assets/:id/:tab?" element={<AssetDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Each tab's code arrives when the tab is opened (bead `ro-ujb9.84`). The DOM
// recorded here is the tab once it has — the same DOM as before that split, which
// is what an unchanged snapshot proves.
beforeAll(loadAssetTabs);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stubJsonFetch(payload());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("AssetDetailRoute — every tab renders the DOM the split found", () => {
  for (const tab of ASSET_TABS) {
    it(`renders the ${tab} tab unchanged`, async () => {
      const { container } = renderTab(tab);
      // The page is a spinner until the payload lands; the tab bar is the first
      // thing that exists once it has.
      await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
      expect(normalise(container.innerHTML)).toMatchSnapshot();
    });
  }
});
