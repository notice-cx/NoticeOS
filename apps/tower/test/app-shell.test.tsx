import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";

// The sidebar lists the portfolio (bead `ro-pbzu.9`), so it reads the wall the
// way the palette does. Mocked rather than served through a real QueryClient:
// every assertion here is about what the nav DRAWS from a payload, and the
// `undefined` state — the first poll still in flight — is one of them.
const state = vi.hoisted(() => ({
  assets: undefined as AssetCard[] | undefined,
  credentials: undefined as unknown,
}));

// Tasks is listed once a task source is connected (D32, bead ro-ujb9.143).
// Mocked for the same reason `useWall` is.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data:
      state.assets === undefined
        ? undefined
        : ({ assets: state.assets } as unknown as WallPayload),
    isPending: state.assets === undefined,
    isError: false,
  }),
}));

// The Integrations entry wears a dot when a credential is about to expire (bead
// `ro-vu8d.8`), which means the sidebar now reads the provider payload too.
// Mocked for the same reason `useWall` is: nothing here is about the fetch.
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({
    data: state.credentials,
    isPending: state.credentials === undefined,
    isError: false,
  }),
}));

import { AppShell, NAV_ASSETS_KEY, NAV_ITEMS, Sidebar } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { AliasRedirect } from "@/routes/AliasRedirect";
import { PropertyRedirect } from "@/routes/PropertyRedirect";
import { THEME_STORAGE_KEY } from "@/hooks/useTheme";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";

/** Only the fields the nav reads — the rest of a card is another surface's
 * business, and spelling it out here would age with the payload. */
function asset(id: string, displayName: string, extra: Partial<AssetCard> = {}): AssetCard {
  return {
    id,
    displayName,
    status: "live",
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    // What decides where a row opens (`sitePath`, bead `ro-ujb9.96.7.4`): a
    // site that has reported opens on its Overview.
    ...NOTHING_YET,
    firstReportAt: "2026-09-01T06:00:00.000Z",
    pulseReceivedAt: "2026-09-01T06:00:00.000Z",
    ...extra,
  } as AssetCard;
}

/** A site just added: no number of any kind yet (`siteHasFirstNumber`). */
const NOTHING_YET = { netByMonthCurrency: 'USD',
  activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  firstReportAt: null,
  pulseReceivedAt: null,
  booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  netByMonth: [],
  dataSources: [],
} satisfies Partial<AssetCard>;

const ASSETS: AssetCard[] = [
  asset("meals.example", "Meal Planner"),
  asset("nosh.example", "Nosh", { worstSeverity: "warn", openWarn: 1 }),
  asset("areas.example", "Area Lookup", { status: "baselining" }),
  asset("fees.example", "Fee Codes", { worstSeverity: "info" }),
];

beforeEach(() => {
  state.assets = ASSETS;
  state.credentials = undefined;
  resetTaskSourceMock();
  window.localStorage.clear();
});

// The desk shell (bead `ro-pbzu.1`). Every desk route renders inside it, so
// these are the assertions that used to live in five page headers: where each
// nav item goes, which one is lit, how the small-screen drawer opens and closes,
// and that the theme reaches the document — and only while the shell is mounted,
// because `/wall` renders outside it and its tokens assume dark.

/** The shell needs somewhere to send the Outlet; the page itself is irrelevant
 * to every assertion here, so it is one word. */
function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<p>page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The sidebar alone, for the assertions that do not need the shell's chrome.
 * Rendering it directly also avoids the shell's deliberate second copy (the
 * desktop column and the small-screen top bar are both in the DOM at once). */
function renderSidebar(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar theme="dark" onToggleTheme={() => {}} />
    </MemoryRouter>,
  );
}

describe("the sidebar is the desk's only navigation", () => {
  it("points every item at its own route", () => {
    renderSidebar("/");

    const expected: [string, string][] = [
      ["Home", "/"],
      ["Workflows", "/workflows"],
      ["Sites", "/assets"],
      ["Alerts", "/alerts"],
      ["Tasks", "/tasks"],
      ["Financials", "/financials"],
      ["System health", "/health"],
      // Integrations is its own noun since bead `ro-vu8d.2` — it used to be an
      // alias for Health, which put the page you go to in order to MAKE a
      // connection at the address of the page that can only observe one.
      ["Integrations", "/integrations"],
      ["Settings", "/settings"],
      ["TV dashboard", "/wall"],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
    // Order is the operator's, not the data model's, and it is spatial memory:
    // a reshuffle moves every target under their cursor.
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(
      expected.slice(0, NAV_ITEMS.length).map(([label]) => label),
    );
  });

  it("keeps every core page, including Tasks, while hub availability is unknown", () => {
    taskSourceMock.connected = null;
    renderSidebar("/");
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent?.trim()).filter((name) =>
      NAV_ITEMS.some((item) => item.label === name))).toEqual(NAV_ITEMS.map((item) => item.label));
  });

  it("keeps Tasks in the fixture sidebar without a hub health read", () => {
    render(<MemoryRouter><Sidebar theme="dark" onToggleTheme={() => {}} assets={[]} credentials={null} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
  });

  it("marks the current page, and only it", () => {
    renderSidebar("/tasks");

    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(
      document.querySelectorAll("[data-app-sidebar] a[aria-current='page']"),
    ).toHaveLength(1);
  });

  it("lights Sites on a site page, because a site page IS a site", () => {
    renderSidebar("/assets/meals.example");

    expect(screen.getByRole("link", { name: "Sites" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Home carries `end` for exactly this reason: without it, `/` matches every
    // path and nothing else could ever be the current page.
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  // Arranging the TV is Edit → move → Save from here (bead ro-ujb9.96.7.12),
  // not Settings → TV dashboard → Edit layout: the edit sits beside the entry.
  it("puts the TV layout's Edit beside the TV dashboard entry, which still opens the TV", () => {
    renderSidebar("/");
    expect(screen.getByRole("link", { name: "TV dashboard" })).toHaveAttribute("href", "/wall");
    expect(screen.getByRole("link", { name: "Edit the TV layout" })).toHaveAttribute("href", "/wall/edit");
  });

  it("lights the Edit, and only it, while the TV layout is being arranged", () => {
    renderSidebar("/wall/edit");
    expect(screen.getByRole("link", { name: "Edit the TV layout" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "TV dashboard" })).not.toHaveAttribute("aria-current");
    expect(document.querySelectorAll("[data-app-sidebar] a[aria-current='page']")).toHaveLength(1);
  });
});

/** The asset rows currently drawn, in DOM order, from the FIRST sidebar in the
 * document — the shell keeps two (the desk column and, while open, the drawer),
 * so a bare query would count each row twice. */
function assetRows(scope: HTMLElement = document.body): HTMLAnchorElement[] {
  const sidebar = scope.querySelector("[data-app-sidebar]");
  return [...(sidebar?.querySelectorAll<HTMLAnchorElement>("a[data-nav-asset]") ?? [])];
}

function assetNames(scope?: HTMLElement): string[] {
  return assetRows(scope).map((row) => row.dataset.navAsset ?? "");
}

describe("the sidebar lists the sites under Sites", () => {
  it("draws one row per asset, pointing at its page", () => {
    renderSidebar("/");

    expect(assetNames()).toEqual(["meals.example", "nosh.example", "areas.example", "fees.example"]);
    const row = assetRows()[0]!;
    expect(row).toHaveAttribute("href", "/assets/meals.example");
    // Identity is the favicon plus the display name — the same pair the cards
    // and the palette carry, never the raw id.
    expect(within(row).getByText("Meal Planner")).toBeInTheDocument();
    expect(row.querySelector("[data-property-favicon='meals.example']")).not.toBeNull();
  });

  // `ro-hou2`: the favicon's wrapper used to carry `title="Meal Planner favicon"`,
  // and a titled element with no text joins the accessible NAME of whatever it
  // sits inside (accname step 2I) — so this row announced as "Meal Planner favicon
  // Meal Planner". Nothing was wrong on screen, which is why it survived until this
  // suite had to query rows by a data attribute because `getByRole('link',
  // {name})` could not name them.
  // Bead ro-ujb9.13: a truncated name told a thumb nothing, and a phone has no
  // hover to read the rest in. A long name wraps to a second line instead.
  it("lets a long site name wrap to two lines rather than cutting it off", () => {
    state.assets = [asset("long.example", "The Very Long Name Of A Recipe And Meal Planning Site")];
    renderSidebar("/");

    const name = within(assetRows()[0]!).getByText("The Very Long Name Of A Recipe And Meal Planning Site");
    expect(name).toHaveClass("line-clamp-2", "break-words");
    expect(name).not.toHaveClass("truncate");
  });

  it("names an asset row by the asset, not by its favicon", () => {
    renderSidebar("/");

    const row = screen.getByRole("link", { name: "Meal Planner" });
    expect(row).toHaveAttribute("href", "/assets/meals.example");
    expect(screen.queryByTitle(/favicon/i)).toBeNull();
  });

  it("marks only the assets with an open warning or error", () => {
    renderSidebar("/");

    // `worstSeverity: "warn"` earns a dot; `info` and a clean asset do not —
    // healthy identity is the favicon (doc 10 principle 3). The dot names its
    // subject, open alerts, and their count (bead ro-32ry).
    expect(within(assetRows()[1]!).getByRole("img", { name: "1 open warning alert" })).toBeInTheDocument();
    expect(within(assetRows()[0]!).queryByRole("img", { name: /warn|error/i })).toBeNull();
    expect(within(assetRows()[3]!).queryByRole("img", { name: /warn|error/i })).toBeNull();
  });

  it("does not present manual setup stages as navigation health", () => {
    renderSidebar("/");

    expect(
      within(assetRows()[2]!).queryByRole("img", { name: /stage/ }),
    ).toBeNull();
    // Live is the ordinary case: a mark on every row would spend the glance on
    // the assets that are fine.
    expect(within(assetRows()[0]!).queryByRole("img", { name: /stage/ })).toBeNull();
  });

  it("sinks retired assets to the foot and marks them switched off", () => {
    state.assets = [
      asset("gone.example", "Gone", { status: "retired" }),
      asset("meals.example", "Meal Planner"),
    ];
    renderSidebar("/");

    expect(assetNames()).toEqual(["meals.example", "gone.example"]);
    expect(within(assetRows()[1]!).getByRole("img", { name: "Retired" })).toBeInTheDocument();
  });

  it("lights the row on any tab of that asset, and Sites with it", () => {
    renderSidebar("/assets/nosh.example/signals");

    expect(assetRows()[1]).toHaveAttribute("aria-current", "page");
    expect(assetRows()[0]).not.toHaveAttribute("aria-current");
    // An asset page IS an asset, so the entry above lights too — the row says
    // WHICH one, the entry says where in the product you are.
    expect(screen.getByRole("link", { name: "Sites" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  // Bead `ro-ujb9.96.7.4` (the UX audit's "While setup is unfinished, the
  // asset opens on Data sources"): before its first number a site's Overview
  // has nothing to show, and its next action is on Data sources.
  it("opens a site with no number yet on its Data sources, and one that has reported on its Overview", () => {
    state.assets = [asset("new.example", "New Site", NOTHING_YET), asset("meals.example", "Meal Planner")];
    renderSidebar("/");

    expect(assetRows()[0]).toHaveAttribute("href", "/assets/new.example/sources");
    expect(assetRows()[1]).toHaveAttribute("href", "/assets/meals.example");
  });

  it("still lights a new site's row on its Overview, which is not where the row opens", () => {
    state.assets = [asset("new.example", "New Site", NOTHING_YET), asset("meals.example", "Meal Planner")];
    renderSidebar("/assets/new.example");

    expect(assetRows()[0]).toHaveAttribute("aria-current", "page");
    expect(assetRows()[1]).not.toHaveAttribute("aria-current");
  });

  it("does not light a site whose id merely starts with the current one's", () => {
    state.assets = [asset("meals.example", "Meal Planner"), asset("meals.example.org", "Meal Planner Org")];
    renderSidebar("/assets/meals.example/growth");

    expect(assetRows()[0]).toHaveAttribute("aria-current", "page");
    expect(assetRows()[1]).not.toHaveAttribute("aria-current");
  });

  it("closes the list with Add a site, which is an address of its own", () => {
    renderSidebar("/assets/new");

    const newAsset = screen.getByRole("link", { name: "Add a site" });
    expect(newAsset).toHaveAttribute("href", "/assets/new");
    expect(newAsset).toHaveAttribute("aria-current", "page");
    // It sits below the last asset, not above the first: it is what you do
    // AFTER reading the list, and the wizard is one keystroke from the foot.
    const list = newAsset.closest("ul")!;
    expect(list.lastElementChild).toBe(newAsset.parentElement);
  });

  it("shows only Add a site before the first asset exists", () => {
    state.assets = [];
    renderSidebar("/");

    expect(assetRows()).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Add a site" })).toBeInTheDocument();
    // A first-run nav states the one thing there is to do; it does not explain
    // itself in a paragraph inside the chrome.
    expect(screen.queryByText(/no assets/i)).toBeNull();
  });

  it("caps the list at twelve and points the rest at the index", () => {
    state.assets = Array.from({ length: 14 }, (_, i) => asset(`a${i}.example`, `Asset ${i}`));
    renderSidebar("/");

    expect(assetRows()).toHaveLength(12);
    expect(assetNames()[11]).toBe("a11.example");
    expect(screen.getByRole("link", { name: "All sites…" })).toHaveAttribute(
      "href",
      "/assets",
    );
    // It goes where the Assets entry already goes, so it must not claim to be a
    // second current page.
    expect(screen.getByRole("link", { name: "All sites…" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("has no overflow row while the portfolio fits", () => {
    renderSidebar("/");
    expect(screen.queryByRole("link", { name: "All sites…" })).toBeNull();
  });

  it("draws no asset row, and no placeholder name, before the first read lands", () => {
    state.assets = undefined;
    renderSidebar("/");

    expect(assetRows()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("undefined");
    // Add a site is not data — it is there from the first frame.
    expect(screen.getByRole("link", { name: "Add a site" })).toBeInTheDocument();
  });

  it("reserves the height it drew last time, so the nav below does not jump", () => {
    window.localStorage.setItem(NAV_ASSETS_KEY, JSON.stringify({ open: true, seen: 4 }));
    state.assets = undefined;
    renderSidebar("/");

    expect(
      document.querySelectorAll("[data-app-sidebar] li[aria-hidden='true']"),
    ).toHaveLength(4);
  });

  it("records the row count, and records no preference nobody expressed", () => {
    renderSidebar("/");

    // `open` is deliberately absent: the desk column's default is the SURFACE's,
    // and writing it down would hand the drawer — which defaults the other way —
    // a choice the operator never made.
    expect(JSON.parse(window.localStorage.getItem(NAV_ASSETS_KEY) ?? "{}")).toEqual({
      seen: 4,
    });
  });
});

describe("the asset list remembers whether it is open", () => {
  it("collapses on the chevron and hides every row", () => {
    renderSidebar("/");
    expect(assetRows()).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Collapse the site list" }));

    expect(assetRows()).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Add a site" })).toBeNull();
    // Assets itself is untouched: collapsing the list is not leaving the index.
    expect(screen.getByRole("link", { name: "Sites" })).toHaveAttribute("href", "/assets");
    expect(
      JSON.parse(window.localStorage.getItem(NAV_ASSETS_KEY) ?? "{}").open,
    ).toBe(false);
  });

  it("starts collapsed on the next mount when that is what was stored", () => {
    window.localStorage.setItem(NAV_ASSETS_KEY, JSON.stringify({ open: false, seen: 4 }));
    renderSidebar("/");

    expect(assetRows()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand the site list" }));
    expect(assetRows()).toHaveLength(4);
  });

  it("ignores a stored value it cannot read, rather than failing to render", () => {
    window.localStorage.setItem(NAV_ASSETS_KEY, "{not json");
    renderSidebar("/");

    expect(assetRows()).toHaveLength(4);
  });

  it("still works when the browser refuses storage entirely", () => {
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });

    try {
      renderSidebar("/");
      // The default stands, and toggling it neither throws nor blanks the nav.
      expect(assetRows()).toHaveLength(4);
      fireEvent.click(screen.getByRole("button", { name: "Collapse the site list" }));
      expect(assetRows()).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Expand the site list" }));
      expect(assetRows()).toHaveLength(4);
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("starts collapsed in the small-screen drawer, where the list is in the way", () => {
    renderShell("/");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(assetRows(drawer)).toHaveLength(0);
    expect(
      within(drawer).getByRole("button", { name: "Expand the site list" }),
    ).toBeInTheDocument();
    // The desk column beside it is unaffected — only the DEFAULT differs.
    expect(assetRows()).toHaveLength(4);
  });
});

describe("the small-screen drawer", () => {
  it("opens from the menu button and closes on Escape", () => {
    renderShell("/");

    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("link", { name: "Financials" })).toHaveAttribute(
      "href",
      "/financials",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });

  it("closes on the backdrop and on any navigation, so it is never a dead end", () => {
    renderShell("/");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("link", { name: "Tasks" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });
});

describe("the theme toggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("light");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("light");
  });

  it("flips the document class and remembers the choice", () => {
    const view = renderShell("/");

    expect(document.documentElement.classList.contains("light")).toBe(false);

    // Two toggles are in the DOM at once by design (the desktop column and the
    // small-screen drawer's source); either one is the same state.
    fireEvent.click(screen.getAllByRole("button", { name: "Switch to light theme" })[0]!);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    fireEvent.click(screen.getAllByRole("button", { name: "Switch to dark theme" })[0]!);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // The class comes OFF with the shell: `/wall` renders outside it and the TV's
    // tokens assume the dark emissive palette.
    fireEvent.click(screen.getAllByRole("button", { name: "Switch to light theme" })[0]!);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    view.unmount();
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("restores the stored choice on the next mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderShell("/");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});

/** The one path in the app that answers by moving. */
function CurrentPath() {
  const { pathname, hash } = useLocation();
  return <span data-testid="path">{`${pathname}${hash}`}</span>;
}

describe("/properties is the older spelling of /assets", () => {
  // `/assets` is canonical and the UI says Assets too (D20, bead `ro-pbzu.6`).
  // `/properties` is the spelling doc 17 asked for until that decision, and it
  // stays an alias so no link written either way can ever 404.
  it("redirects an asset page and keeps the deep link's hash", () => {
    render(
      <MemoryRouter initialEntries={["/properties/meals.example#timeline"]}>
        <Routes>
          <Route path="/properties/:id" element={<PropertyRedirect />} />
          <Route path="/assets/:id" element={<CurrentPath />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MemoryRouter>,
    );

    // The hash is the whole point of those links: an alert's change chip lands
    // on #timeline and a matrix cell on #integrations.
    expect(screen.getByTestId("path")).toHaveTextContent("/assets/meals.example#timeline");
  });

  it("redirects the index too", () => {
    render(
      <MemoryRouter initialEntries={["/properties"]}>
        <Routes>
          <Route path="/properties" element={<AliasRedirect to="/assets" />} />
          <Route path="/assets" element={<CurrentPath />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("path")).toHaveTextContent("/assets");
  });
});

describe("PageHeader", () => {
  it("renders the title as the page's one h1, with its breadcrumb, meta, and actions", () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="Financials"
          description="What the portfolio earned."
          breadcrumb={[{ label: "Sites", to: "/assets" }]}
          meta={<span>2026-08</span>}
          actions={<button type="button">Export</button>}
        >
          <p>tabs go here</p>
        </PageHeader>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Financials" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sites" })).toHaveAttribute(
      "href",
      "/assets",
    );
    expect(screen.getByText("What the portfolio earned.")).toBeInTheDocument();
    expect(screen.getByText("2026-08")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByText("tabs go here")).toBeInTheDocument();
  });

  it("draws no breadcrumb nav when there is nowhere above the page", () => {
    render(
      <MemoryRouter>
        <PageHeader title="Home" />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });
});

/**
 * `ro-vu8d.19`. The decision was that the provider card plus the sidebar's
 * expiry dot is the CEILING for an expiring shared credential — the Wall
 * carries nothing (a television nobody can reconnect from, and D15 gives the
 * fact to the action list), and Home carries nothing extra (Home is a desk page,
 * so the sidebar is already on it).
 *
 * The one hole that left is the small screen, where the sidebar is behind a
 * Menu button. A ceiling the operator cannot see on their phone is not a
 * ceiling, so the mark travels to the bar — same predicate, same sentence.
 */
describe("the small-screen bar carries the nav's own mark", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const providers = (expiresAt: string | null) => ({
    providers: [
      {
        provider: { id: "dataforseo", label: "DataForSEO" },
        credential: {
          metadata: {
            account: null,
            scopes: [],
            connectedAt: null,
            expiresAt,
            expirySource: "operator",
          },
        },
      },
    ],
  });

  it("says nothing while no credential is close", () => {
    state.credentials = providers(new Date(Date.now() + 90 * DAY).toISOString());
    const { container } = renderShell("/");
    expect(container.querySelector("[data-nav-alarm]")).toBeNull();
  });

  it("wears the same dot and the same sentence the hidden sidebar would have", () => {
    // A minute past nine whole days, so the countdown's floor reads 9 rather
    // than losing one to the clock ticking between the fixture and the render.
    state.credentials = providers(new Date(Date.now() + 9 * DAY + 60_000).toISOString());
    const { container } = renderShell("/");

    const alarm = container.querySelector("[data-nav-alarm]") as HTMLElement;
    expect(alarm.getAttribute("data-nav-alarm")).toBe("warn");
    expect(alarm.getAttribute("title")).toBe("DataForSEO — expires in 9 days");
    // The sidebar rendered beside it in the same DOM says exactly the same
    // thing: one predicate, one sentence, two places (doc 14).
    expect(
      within(
        container.querySelector("[data-app-sidebar]") as HTMLElement,
      ).getByTitle("DataForSEO — expires in 9 days"),
    ).toBeTruthy();
  });

  it("escalates with the credential rather than inventing a scale of its own", () => {
    state.credentials = providers(new Date(Date.now() - DAY).toISOString());
    const { container } = renderShell("/");
    expect(
      container.querySelector("[data-nav-alarm]")?.getAttribute("data-nav-alarm"),
    ).toBe("error");
  });

  it("adds no second control — the button under it is still the whole target", () => {
    state.credentials = providers(new Date(Date.now() + 3 * DAY).toISOString());
    const { container } = renderShell("/");
    expect(container.querySelector("[data-nav-alarm]")?.className).toMatch(
      /pointer-events-none/,
    );
    // And nothing else in the bar became pressable.
    expect(screen.getAllByRole("button", { name: "Open navigation" })).toHaveLength(1);
  });
  /**
   * THE WORDMARK IS A THUMB TARGET (bead `ro-9smi`). This bar is the phone's
   * whole navigation chrome, and its Home link was a 20px line floating in a
   * 48px row — the one control under the 40px floor on EVERY desk route, which
   * is how it survived both `ro-md80`'s sweep and `ro-khoy`'s. The height is
   * claimed from the row it was already centred in, so nothing moves.
   */
  it("gives the wordmark the height of the row it sits in", () => {
    state.credentials = providers(null);
    renderShell("/");
    const home = screen
      .getAllByRole("link", { name: "NoticeOS" })
      .filter((link) => !link.closest("[data-app-sidebar]"));
    // The drawer is closed, so outside the desk's sidebar the only one is this bar's.
    expect(home).toHaveLength(1);
    expect(home[0]?.className).toContain("min-h-11");
    // Claimed, not added: the bar is unchanged and still sets the height.
    expect(home[0]?.parentElement?.className).toContain("h-12");
  });
});

// ── fetching a screen's code before the click (bead `ro-82x`) ────────────────
//
// Every screen is its own file since the route split, so a click on a page not
// yet visited waits for it. The nav asks for that file when a pointer rests on a
// link or the keyboard reaches it — the moment before the click — through the
// prefetcher `App.tsx` hands the shell. It never asks for anything the operator
// has not pointed at: preloading every screen would be the monolith again.
describe("the nav fetches a page's code before it is clicked", () => {
  function renderWithPrefetch(path: string) {
    const onPrefetch = vi.fn();
    const { container } = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell onPrefetch={onPrefetch} />}>
            <Route path="*" element={<p>page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const column = container.querySelector<HTMLElement>("[data-app-sidebar]");
    if (!column) throw new Error("no sidebar");
    return { onPrefetch, nav: within(column) };
  }

  it("asks for the page a pointer rests on, and nothing else", () => {
    const { onPrefetch, nav } = renderWithPrefetch("/");
    expect(onPrefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(nav.getByRole("link", { name: "Alerts" }));
    expect(onPrefetch).toHaveBeenCalledTimes(1);
    expect(onPrefetch).toHaveBeenLastCalledWith("/alerts");

    fireEvent.pointerEnter(nav.getByRole("link", { name: "Sites" }));
    expect(onPrefetch).toHaveBeenLastCalledWith("/assets");
    fireEvent.pointerEnter(nav.getByRole("link", { name: "Meal Planner" }));
    expect(onPrefetch).toHaveBeenLastCalledWith("/assets/meals.example");
    fireEvent.pointerEnter(nav.getByRole("link", { name: "Add a site" }));
    expect(onPrefetch).toHaveBeenLastCalledWith("/assets/new");
    fireEvent.pointerEnter(nav.getByRole("link", { name: "TV dashboard" }));
    expect(onPrefetch).toHaveBeenLastCalledWith("/wall");
  });

  it("asks when the keyboard focuses a link, so Tab-then-Enter is fast too", () => {
    const { onPrefetch, nav } = renderWithPrefetch("/");
    fireEvent.focus(nav.getByRole("link", { name: "Integrations" }));
    expect(onPrefetch).toHaveBeenLastCalledWith("/integrations");
    fireEvent.focus(nav.getByRole("link", { name: "Settings" }));
    expect(onPrefetch).toHaveBeenLastCalledWith("/settings");
  });

  it("does nothing, and breaks nothing, for the gallery's standalone sidebar", () => {
    renderSidebar("/");
    expect(() =>
      fireEvent.pointerEnter(screen.getByRole("link", { name: "Alerts" })),
    ).not.toThrow();
  });
});
