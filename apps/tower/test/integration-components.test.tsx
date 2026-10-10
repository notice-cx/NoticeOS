import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DerivedLaneRow,
  IntegrationCatalogRow,
  IntegrationCell,
  IntegrationsMatrix,
} from "@shared/integrations";
import {
  EGRESS_LANE_ID,
  NIGHTLY_REPORT_LANE_ID,
  emptyIntegrationsHistory,
  summarize,
} from "@shared/integrations";
import { IntegrationMatrix } from "@/components/IntegrationMatrix";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { IntegrationSummaryStrip } from "@/components/IntegrationSummaryStrip";
vi.mock("@/hooks/useWorkflows", () => ({ useWorkflows: () => ({ data: undefined, isError: false }) }));
import { HealthRoute } from "@/routes/HealthRoute";

const COUNTS = { "not-connected": 31, "not-using": 1, "not-applicable": 26 } as const;

describe("IntegrationSummaryStrip — shared-credential insight line", () => {
  it("describes reusable-credential lanes without pretending the lane count is an account count", () => {
    const { container } = render(
      <IntegrationSummaryStrip counts={COUNTS} sharedCredential={{ lanes: 8, cells: 31 }} />,
    );
    expect(container.textContent).toContain("8 integrations connect once · 31 sites waiting");
    expect(container.textContent).not.toContain("8 shared credentials");
  });

  it("omits the insight line when no shared-credential cells are unresolved", () => {
    const { container } = render(
      <IntegrationSummaryStrip counts={COUNTS} sharedCredential={{ lanes: 0, cells: 0 }} />,
    );
    expect(container.querySelector("[data-shared-credentials]")).toBeNull();
  });

  it("singularizes a single reusable-credential integration", () => {
    const { container } = render(
      <IntegrationSummaryStrip counts={COUNTS} sharedCredential={{ lanes: 1, cells: 4 }} />,
    );
    expect(container.textContent).toContain("1 integration connects once · 4 sites waiting");
    expect(container.textContent).toContain("Not connected · 31");
    expect(container.textContent).toContain("Not using · 1");
    expect(container.textContent).not.toContain("1 integrations");
  });
});

const CATALOG_LANE: IntegrationCatalogRow = {
  id: "gsc",
  label: "Google Search Console",
  docRef: "docs/11-integrations.md#the-catalog",
  scope: "property",
  layer: "provider",
  usage: { cost: "free" as const },
  onFailure: "keeps-last-data" as const,
  credential: "per-property",
  derived: false,
};

const DERIVED_LANE: DerivedLaneRow = {
  catalog: {
    ...CATALOG_LANE,
    id: NIGHTLY_REPORT_LANE_ID,
    label: "Nightly report",
    // The nightly report is the asset's own plumbing, so it groups with the
    // asset layer, not GSC's.
    layer: "property",
    onFailure: "raises-alert",
    derived: true,
  },
  cells: {
    "meadow.example": {
      assetId: "meadow.example",
      laneId: NIGHTLY_REPORT_LANE_ID,
      effective: "live",
      evidence: [
        {
          polarity: "supporting",
          source: "Last nightly report accepted",
          detail: "The store accepted a report within the nightly cadence.",
          at: "2026-07-05T08:00:00.000Z",
          verification: { kind: "collection-success", laneId: NIGHTLY_REPORT_LANE_ID },
        },
      ],
    },
  },
};

/** The L0 row as the worker builds it: one real cell on the OS's own column,
 * the scope rule's N/A on every content asset. */
const EGRESS_LANE: DerivedLaneRow = {
  catalog: {
    ...CATALOG_LANE,
    id: EGRESS_LANE_ID,
    label: "The OS's own internet connection",
    layer: "os",
    scope: "portfolio",
    derived: true,
  },
  cells: {
    "root-os": {
      assetId: "root-os",
      laneId: EGRESS_LANE_ID,
      effective: "live",
      evidence: [
        {
          polarity: "supporting",
          source: "No lane has ever had to ask",
          detail: "Nothing has come back without a status, so the connection was never in question.",
          at: null,
        },
      ],
    },
    "meadow.example": {
      assetId: "meadow.example",
      laneId: EGRESS_LANE_ID,
      effective: "not-applicable",
      evidence: [],
    },
  },
};

const DECLARED_CELL: IntegrationCell = {
  assetId: "meadow.example",
  laneId: "gsc",
  declared: "needs-setup",
  effective: "needs-setup",
  evidence: [],
  note: "",
  ref: null,
  since: "2026-07-06",
};

const MATRIX: IntegrationsMatrix = {
  generatedAt: "2026-07-05T12:00:00.000Z",
  owner: "config/integrations.json",
  history: emptyIntegrationsHistory(),
  catalog: [CATALOG_LANE],
  undeclared: [],
  derivedLanes: [DERIVED_LANE],
  assets: [{ id: "meadow.example", displayName: "Meadow Board", isOs: false }],
  cells: { "meadow.example": [DECLARED_CELL] },
  summary: summarize([DECLARED_CELL, DERIVED_LANE.cells["meadow.example"]!]),
  sharedCredential: { lanes: 0, cells: 0 },
  dataSpend: {
    period: "2026-07",
    spentUsd: 0, unknownPrices: 0,
    capUsd: 25,
    unattributedUsd: 0, unattributedUnknownPrices: 0,
    byAsset: [],
  },
};

describe("IntegrationMatrix — the derived lane leads and reads as derived", () => {
  function renderMatrix() {
    return render(
      <MemoryRouter>
        <IntegrationMatrix matrix={MATRIX} nowMs={Date.parse("2026-07-05T12:00:00.000Z")} />
      </MemoryRouter>,
    );
  }

  it("renders each layer's derived row FIRST, above that layer's declared catalog", () => {
    // This fixture's GSC lane is a provider account and the nightly report is the
    // asset's own wiring, so they land in different layers.
    const { container } = renderMatrix();
    const groups = [...container.querySelectorAll("tbody")].map((body) => ({
      heading: body.querySelector('th[scope="rowgroup"]')?.textContent ?? "",
      lanes: [...body.querySelectorAll("tr td:first-child button")].map((b) => b.textContent),
    }));
    expect(groups.map((g) => g.lanes[0])).toEqual([
      "Google Search Console",
      "Nightly report",
    ]);
    expect(groups[0]!.heading).toContain("Provider accounts");
    expect(groups[1]!.heading).toContain("The site's own wiring");
  });

  it("gives the derived cell no edit link — there is no declared value to change", () => {
    const { container } = renderMatrix();
    const table = container.querySelector("table")!;
    const links = [...table.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/assets/meadow.example/sources"]);
    expect(within(table).getByText("Working").closest("a")).toBeNull();
  });

  it("expands to the lane's facts", () => {
    const { container } = renderMatrix();
    const table = container.querySelector("table")!;
    fireEvent.click(within(table).getByText("Nightly report"));
    const facts = container.querySelector(`[data-lane-facts="${NIGHTLY_REPORT_LANE_ID}"]`)!;
    const fact = (key: string) => facts.querySelector(`[data-lane-fact="${key}"] dd`)?.textContent;
    expect(fact("cost")).toBe("Free");
    expect(fact("runs")).toBe("Daily");
    expect(fact("on-failure")).toBe("Raises an alert");
    expect(facts.querySelector('[data-lane-fact="limit"]')).toBeNull();
    for (const retired of ["State from:", "Usage limits:", "On failure:"]) {
      expect(container.textContent).not.toContain(retired);
    }
  });

  it("keeps the OS's own lane off the asset cards on mobile", () => {
    // The narrow view groups by asset, not by layer, so the L0 row stays out
    // of an asset's card through the same N/A drop every portfolio-scope lane
    // relies on.
    const { container } = render(
      <MemoryRouter>
        <IntegrationMatrix
          matrix={{
            ...MATRIX,
            assets: [
              { id: "root-os", displayName: "NoticeOS", isOs: true },
              { id: "meadow.example", displayName: "Meadow Board", isOs: false },
            ],
            cells: { "root-os": [], "meadow.example": [DECLARED_CELL] },
            derivedLanes: [...MATRIX.derivedLanes, EGRESS_LANE],
          }}
          nowMs={Date.parse("2026-07-05T12:00:00.000Z")}
        />
      </MemoryRouter>,
    );

    const cards = [...container.querySelectorAll("details")];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Internet connection");
    expect(cards[1]!.textContent).not.toContain("Internet connection");
    const osGroup = container.querySelector("table tbody")!;
    expect(osGroup.querySelector('th[scope="rowgroup"]')!.textContent).toContain(
      "The OS itself",
    );
    expect(osGroup.textContent).toContain("Internet connection");
  });

  // jsdom has no layout, so the classes are what is pinned.
  it("gives a phone the whole row to hit, and never widens the desk grid", () => {
    const { container } = renderMatrix();
    const accordion = container.querySelector("div.md\\:hidden")!;

    // The source-name toggles, which are the ones carrying a label; the
    // evidence glyph is also `aria-expanded` and is checked on its own below.
    const toggles = [...accordion.querySelectorAll("button[aria-expanded]")].filter(
      (button) => (button.textContent ?? "").trim().length > 0,
    );
    expect(toggles.length).toBeGreaterThan(0);

    const rowWrapper = toggles[0]!.parentElement!;
    expect(rowWrapper.className).toContain("px-3");
    expect(rowWrapper.className.split(/\s+/)).not.toContain("p-3");

    for (const toggle of toggles) {
      expect(toggle.className).toContain("min-h-11");
    }

    for (const link of accordion.querySelectorAll("a[href]")) {
      expect(link.className).toContain("max-md:min-h-11");
    }
    for (const glyph of accordion.querySelectorAll('button[aria-label^="Why this state"]')) {
      expect(glyph.className).toContain("max-md:size-11");
    }

    // None of it reaches the grid beside it: `MatrixCell` is shared, so every
    // rule is variant-prefixed and cannot apply at a width where the grid is
    // the visible view.
    const table = container.querySelector("table")!;
    for (const el of table.querySelectorAll("a[href], button")) {
      const bare = el.className.split(/\s+/);
      expect(bare).not.toContain("min-h-11");
      expect(bare).not.toContain("size-11");
    }
  });

  it("says the evidence IS the state, not a merge over a declared value", () => {
    const { container } = renderMatrix();
    const table = container.querySelector("table")!;
    fireEvent.click(within(table).getByLabelText(/Why this state/));
    expect(container.querySelector('[title^="Read from the store"]')).not.toBeNull();
    expect(within(document.body).getByRole("dialog").querySelector("p")).toBeNull();
    expect(container.textContent).not.toContain("merged over the declared value");
  });
});

describe("HealthRoute — month-to-date data spend", () => {
  function renderRoute(matrix: IntegrationsMatrix) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(matrix), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <HealthRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The panel mounts its body only when open. */
  function openSpend(): HTMLElement {
    const panel = document.querySelector('[data-panel="spend"]');
    if (!(panel instanceof HTMLElement)) throw new Error("no spend panel");
    if (!panel.hasAttribute("data-panel-open")) {
      fireEvent.click(panel.querySelector("button")!);
    }
    return panel;
  }

  it("states the month's metered spend against the cap that stops it", async () => {
    const { container, findByText, findByRole } = renderRoute({
      ...MATRIX,
      dataSpend: {
        period: "2026-07",
        spentUsd: 8.4, unknownPrices: 0,
        capUsd: 25,
        unattributedUsd: 0, unattributedUnknownPrices: 0,
        byAsset: [
          { asset: "meadow.example", spentUsd: 6.2, unknownPrices: 0 },
          { asset: "northwind.example", spentUsd: 2.2, unknownPrices: 0 },
        ],
      },
    });

    await findByRole("button", { name: /Credential expiry and data costs/ });
    openSpend();
    await findByText("$8.40");
    expect(container.textContent).toContain("of $25 in Jul");
    const bar = container
      .querySelector('[data-kpi="Data spend"]')!
      .querySelector("[data-composition]")!;
    expect(bar).toHaveAttribute(
      "aria-label",
      "$8.40 of the $25 monthly cap is spent",
    );

    expect(container.querySelector("[data-about]")).toBeNull();
  });

  it("says which asset the month's data budget went on", async () => {
    // The cap is portfolio-wide, but the decision it feeds is per-asset.
    const { container, findByText, findByRole } = renderRoute({
      ...MATRIX,
      assets: [
        { id: "meadow.example", displayName: "Meadow Board", isOs: false },
        { id: "northwind.example", displayName: "Northwind", isOs: false },
      ],
      dataSpend: {
        period: "2026-07",
        spentUsd: 8.4, unknownPrices: 0,
        capUsd: 25,
        unattributedUsd: 0, unattributedUnknownPrices: 0,
        byAsset: [
          { asset: "meadow.example", spentUsd: 6.2, unknownPrices: 0 },
          { asset: "northwind.example", spentUsd: 2.2, unknownPrices: 0 },
        ],
      },
    });

    await findByRole("button", { name: /Credential expiry and data costs/ });
    openSpend();
    await findByText("$8.40");
    const rows = [...openSpend().querySelectorAll("[data-spend-asset]")];
    expect(rows.map((row) => row.textContent)).toEqual(["Meadow Board$6.20", "Northwind$2.20"]);
    expect(container.textContent).toContain("of $25 in Jul");
  });

  // Research bought about no single property is real money on the same
  // account and the cap gate counts it, so the split has to reach the headline.
  it("names the research that belongs to no one asset, so the split adds up", async () => {
    const { container, findByText, findByRole } = renderRoute({
      ...MATRIX,
      assets: [{ id: "meadow.example", displayName: "Meadow Board", isOs: false }],
      dataSpend: {
        period: "2026-07",
        spentUsd: 6.5, unknownPrices: 0,
        capUsd: 25,
        unattributedUsd: 0.3, unattributedUnknownPrices: 0,
        byAsset: [{ asset: "meadow.example", spentUsd: 6.2, unknownPrices: 0 }],
      },
    });

    await findByRole("button", { name: /Credential expiry and data costs/ });
    openSpend();
    await findByText("$6.50");
    expect(
      openSpend().querySelector("[data-spend-unattributed]")?.textContent,
    ).toBe("Research, not tied to a site$0.30");
    expect(container.textContent).toContain("of $25 in Jul");

  });

  it("shows no split at all in a month nothing has been spent in", async () => {
    const { container, findByText, findByRole } = renderRoute({
      ...MATRIX,
      dataSpend: {
        period: "2026-07",
        spentUsd: 0, unknownPrices: 0,
        capUsd: 25,
        unattributedUsd: 0, unattributedUnknownPrices: 0,
        byAsset: [],
      },
    });

    await findByRole("button", { name: /Credential expiry and data costs/ });
    openSpend();
    await findByText("$0.00");
    expect(openSpend().querySelector("[data-data-spend-by-asset]")).toBeNull();
    expect(container.textContent).toContain("Nothing metered has been bought");
  });

  it("says the pulls are paused once the cap is reached", async () => {
    const { findByRole } = renderRoute({
      ...MATRIX,
      dataSpend: {
        period: "2026-07",
        spentUsd: 25, unknownPrices: 0,
        capUsd: 25,
        unattributedUsd: 0, unattributedUnknownPrices: 0,
        byAsset: [{ asset: "meadow.example", spentUsd: 25, unknownPrices: 0 }],
      },
    });

    await findByRole("button", { name: /Credential expiry and data costs/ });
    openSpend();
    expect(openSpend().querySelector('[data-kpi="Data spend"]')).toHaveTextContent("$25.00");
    expect(openSpend().textContent).toContain("paused until next month");
  });
});

describe("IntegrationStateChip — state → palette + affordance", () => {
  it("draws every connection status with its tone and glyph (color by meaning, never alone)", () => {
    const { getByText } = render(
      <>
        <IntegrationStateChip subject="integration:working" state="working" />
        <IntegrationStateChip subject="integration:failing" state="failing" />
        <IntegrationStateChip subject="integration:overdue" state="overdue" />
        <IntegrationStateChip subject="integration:collecting" state="collecting" />
        <IntegrationStateChip subject="integration:not-connected" state="not-connected" />
        <IntegrationStateChip subject="integration:not-using" state="not-using" />
        <IntegrationStateChip subject="integration:not-applicable" state="not-applicable" />
        <IntegrationStateChip subject="integration:key-accepted" state="key-accepted" accepted="sign-in" />
      </>,
    );
    expect(getByText("Working").className).toContain("text-connected");
    expect(getByText("Failing").className).toContain("text-error");
    expect(getByText("Overdue").className).toContain("text-warn");
    expect(getByText("Collecting").className).toContain("text-foreground");
    expect(getByText("Not connected").className).toContain("text-muted-foreground");
    expect(getByText("Not using").className).toContain("text-info");
    expect(getByText("Doesn't apply").className).toContain("text-muted-foreground");
    expect(getByText("Signed in").className).toContain("text-connected");
  });

  it("reads a register cell's recorded state in the same vocabulary", () => {
    const { getByText } = render(
      <>
        <IntegrationStateChip subject="integration:live" state="live" />
        <IntegrationStateChip subject="integration:degraded" state="degraded" />
        <IntegrationStateChip subject="integration:needs-setup" state="needs-setup" />
        <IntegrationStateChip subject="integration:skipped" state="skipped" />
      </>,
    );
    for (const word of ["Working", "Failing", "Not connected", "Not using"]) expect(getByText(word)).toBeInTheDocument();
  });

  it("tells declined from not-connected by a hollow notch in its own tone", () => {
    const declined = render(<IntegrationStateChip subject="integration:not-using" state="not-using" />);
    expect(declined.container.querySelector("[aria-hidden]")?.className).toContain("border-current");
  });

  it("appends a count for the summary strip", () => {
    const { getByText } = render(<IntegrationStateChip subject="integration:not-connected" state="not-connected" count={4} />);
    expect(getByText("Not connected · 4")).toBeInTheDocument();
  });
});
