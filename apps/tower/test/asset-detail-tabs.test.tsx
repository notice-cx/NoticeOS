import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetDetailRoute, ASSET_TABS, type AssetTab } from "@/routes/AssetDetailRoute";
import { everyTabPayload as payload } from "./asset-detail-fixture";
import { loadAssetTabs } from "./lazy-code";
import { stubJsonFetch } from "./stub-fetch";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

// The clock and the calendar are pinned before anything imports a formatter,
// so the recorded DOM is the same everywhere. `vi.hoisted` is the only place
// that runs early enough to matter for `process.env.TZ`.
vi.hoisted(() => {
  process.env.TZ = "UTC";
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The moment every age badge on the page is measured from. Stubbed rather than
 * faked with timers, because TanStack Query and Testing Library's `waitFor` both
 * want a real event loop. */
const NOW = Date.parse("2026-07-05T14:00:00.000Z");

/**
 * This suite records the rendered DOM of every tab for one payload that has
 * something on all of them, so a diff says exactly which tab a change
 * reached: a redesign updates the recorded DOM deliberately (`vitest -u`),
 * an accident does not.
 */
function testClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
}

/**
 * React and Radix mint an id per mount, so two runs of the same tree differ in
 * `:r3:` and `radix-:r7:` alone. `_r_N_` is React 19's form of the same thing
 * and it is counted: adding a `useId` anywhere earlier in the tree renumbers
 * every one after it, so the pin has to be blind to that. One element per
 * line, because the whole value of this file is the diff.
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
        initialEntries={[`/assets/meadow.example${tab === "overview" ? "" : `/${tab}`}`]}
      >
        <Routes>
          <Route path="/assets/:id/:tab?" element={<AssetDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

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
      await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
      expect(normalise(container.innerHTML)).toMatchSnapshot();
    });
  }
});
