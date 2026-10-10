import { integrationStatus } from '@shared/integration-status';
import { fireEvent, render } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  DerivedLaneRow,
  IntegrationCatalogRow,
  IntegrationCell,
  IntegrationLayer,
  IntegrationsMatrix,
} from "@shared/integrations";
import { emptyIntegrationsHistory, summarize } from "@shared/integrations";
import { integrationProvider } from "@noticeos/contract";

// /health opens on what to unblock next; the matrix is the audit view
// underneath, and it reads in layers: the OS's own connection, then provider
// accounts, then each asset's own wiring. `/integrations` is its own page:
// this one observes connections, that one makes them.

const state = vi.hoisted(() => ({
  data: null as IntegrationsMatrix | null,
  /** The credential summaries this page also reads, so it can say which
   * providers are still on the environment file. */
  providers: null as { providers: { provider: unknown; credential: Record<string, unknown> }[] } | null,
}));

vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: () => ({ data: undefined, isError: false }) }));
// System health names the OS's own problems from the Wall's read; these cases
// are about the workflow and connection reads, so the Wall has none.
vi.mock('@/hooks/useWall', () => ({ useWall: () => ({ data: undefined, isError: false }) }));
vi.mock('@/hooks/useGa4Realtime', () => ({ useGa4Realtime: () => ({ data: undefined, isError: false }) }));
vi.mock("@/hooks/useIntegrations", () => ({
  useIntegrations: () => ({ data: state.data, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({
    data: state.providers,
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-08-04T12:00:00.000Z"),
}));

import { deskRoutes } from "@/App";
import { HealthRoute } from "@/routes/HealthRoute";
import { IntegrationsRoute } from "@/routes/IntegrationsRoute";
import { componentAt } from "./route-table";

describe("the page's own address", () => {
  it("answers at /health, and no longer at /integrations", async () => {
    // Every link the Tower emitted to the matrix points at `/health`.
    expect(await componentAt(deskRoutes, "/health")).toBe(HealthRoute);
    expect(await componentAt(deskRoutes, "/integrations")).toBe(IntegrationsRoute);
  });
});

function lane(
  id: string,
  label: string,
  credential: "shared" | "per-property",
  layer: IntegrationLayer = "provider",
): IntegrationCatalogRow {
  return {
    id,
    label,
    docRef: "docs/11-integrations.md#the-catalog",
    scope: "property",
    layer,
    usage: { cost: "free" as const },
    onFailure: "keeps-last-data" as const,
    credential,
    derived: false,
  };
}

function cell(
  assetId: string,
  laneId: string,
  effective: IntegrationCell["effective"],
): IntegrationCell {
  return {
    assetId,
    laneId,
    declared: effective,
    effective,
    evidence: [],
    note: "",
    ref: null,
    since: "2026-07-06",
  };
}

function matrix(
  cells: Record<string, IntegrationCell[]>,
  derivedLanes: DerivedLaneRow[] = [],
  extra: IntegrationCatalogRow[] = [],
): IntegrationsMatrix {
  const catalog = [
    lane("gsc", "Google Search Console", "shared"),
    lane("clarity", "Microsoft Clarity", "per-property"),
    ...extra,
  ];
  return {
    generatedAt: "2026-08-04T12:00:00.000Z",
    owner: "config/integrations.json",
    history: emptyIntegrationsHistory(),
    catalog,
    undeclared: [],
    derivedLanes,
    assets: [
      { id: "meadow.example", displayName: "Meadow Board", isOs: false },
      { id: "northwind.example", displayName: "Northwind", isOs: false },
    ],
    cells,
    summary: summarize(Object.values(cells).flat()),
    sharedCredential: { lanes: 1, cells: 2 },
    dataSpend: {
      period: "2026-08",
      spentUsd: 8.4, unknownPrices: 0,
      capUsd: 25,
      unattributedUsd: 0, unattributedUnknownPrices: 0,
      byAsset: [
        { asset: "meadow.example", spentUsd: 6.2, unknownPrices: 0 },
        { asset: "northwind.example", spentUsd: 2.2, unknownPrices: 0 },
      ],
    },
  };
}

/** The page over a matrix that is only about the daily history; every other
 * slice is the standing fixture's. */
function renderHealth(over: Partial<IntegrationsMatrix>) {
  return renderRoute({ ...matrix({ "meadow.example": [] }), ...over });
}

function renderRoute(
  data: IntegrationsMatrix,
  providers: [string, string][] | null = null,
) {
  state.data = data;
  state.providers =
    providers === null
      ? null
      : {
          providers: providers.map(([id, source]) => ({
            provider: integrationProvider(id),
            credential: {
              provider: id, source, fields: source === "none" ? [] : ["KEY"], assetsHeld: [], missingFields: [], auth: null,
              metadata: null, keyVersion: 1, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null,
            },
          })),
        };
  return render(
    <MemoryRouter>
      <HealthRoute />
    </MemoryRouter>,
  );
}

/**
 * Open one of the page's collapsed panels. A panel mounts its body only when
 * open (a closed `<details>` still lays its contents out), so a case about
 * the matrix presses the header first.
 */
function openPanel(mark: string): HTMLElement {
  const panel = document.querySelector(`[data-panel="${mark}"]`);
  if (!(panel instanceof HTMLElement)) throw new Error(`no panel ${mark}`);
  if (!panel.hasAttribute("data-panel-open")) {
    fireEvent.click(panel.querySelector("button")!);
  }
  return panel;
}

describe("the Health page is layered", () => {
  const derived: DerivedLaneRow[] = [
    {
      catalog: {
        ...lane("egress", "The OS's own internet connection", "shared", "os"),
        derived: true,
        scope: "portfolio",
      },
      cells: {
        "meadow.example": {
          assetId: "meadow.example",
          laneId: "egress",
          effective: "not-applicable",
          evidence: [],
        },
        "northwind.example": {
          assetId: "northwind.example",
          laneId: "egress",
          effective: "not-applicable",
          evidence: [],
        },
      },
    },
    {
      catalog: {
        ...lane("nightly-report", "Nightly report", "per-property", "property"),
        derived: true,
        scope: "both",
      },
      cells: {
        "meadow.example": {
          assetId: "meadow.example",
          laneId: "nightly-report",
          effective: "live",
          evidence: [],
        },
        "northwind.example": {
          assetId: "northwind.example",
          laneId: "nightly-report",
          effective: "live",
          evidence: [],
        },
      },
    },
  ];

  it("names the page Health — the top row is no longer a data source", () => {
    const { getByRole } = renderRoute(matrix({ "meadow.example": [], "northwind.example": [] }));
    expect(getByRole("heading", { level: 1 }).textContent).toBe("System health");
  });

  it("groups the matrix rows os → provider → asset, widest blast radius first", () => {
    renderRoute(
      matrix(
        {
          "meadow.example": [
            cell("meadow.example", "gsc", "live"),
            cell("meadow.example", "clarity", "needs-setup"),
          ],
          "northwind.example": [
            cell("northwind.example", "gsc", "live"),
            cell("northwind.example", "clarity", "needs-setup"),
          ],
        },
        derived,
      ),
    );

    const audit = openPanel("audit");
    const headings = [...audit.querySelectorAll('table th[scope="rowgroup"]')].map(
      (th) => th.textContent ?? "",
    );
    expect(headings).toHaveLength(3);
    expect(headings[0]).toContain("The OS itself");
    expect(headings[1]).toContain("Provider accounts");
    expect(headings[2]).toContain("The site's own wiring");
    // The order is the argument: the OS first, then accounts, then wiring.
    expect(headings[0]).toBe("The OS itself");

    const groups = [...audit.querySelectorAll("table tbody")].map((body) =>
      [...body.querySelectorAll("tr td:first-child button")].map((b) => b.textContent),
    );
    expect(groups).toEqual([
      ["Internet connection"],
      ["Google Search Console", "Microsoft Clarity"],
      ["Nightly report"],
    ]);
  });
});

describe("/health — the page leads with what to unblock next", () => {
  const blocked = matrix({
    "meadow.example": [
      cell("meadow.example", "gsc", "needs-setup"),
      cell("meadow.example", "clarity", "needs-setup"),
    ],
    "northwind.example": [
      cell("northwind.example", "gsc", "needs-setup"),
      cell("northwind.example", "clarity", "degraded"),
    ],
  });

  it("counts connections in the connection vocabulary, with nothing to open to read them", () => {
    const { container, queryByRole } = renderRoute(blocked);
    const strip = container.querySelector("[data-connections] [data-kpi-strip]")!;
    expect([...strip.querySelectorAll("[data-kpi]")].map((kpi) => kpi.getAttribute("data-kpi"))).toEqual([
      "Sites failing", "Sites overdue", "Reports missing", "Sites working",
    ]);
    for (const retired of ["Verified working", "Not verified", "Degraded", "Not set up"]) {
      expect(container.querySelector(`[data-kpi="${retired}"]`)).toBeNull();
    }
    openPanel("spend");
    expect(queryByRole("button", { name: "About Data spend" })).toBeNull();
    expect(container.querySelector("button button, a button")).toBeNull();
  });

  const wiring = matrix(
    {
      "meadow.example": [
        cell("meadow.example", "gsc", "needs-setup"),
        cell("meadow.example", "clarity", "degraded"),
        cell("meadow.example", "uptime", "needs-setup"),
      ],
      "northwind.example": [
        cell("northwind.example", "gsc", "needs-setup"),
        cell("northwind.example", "clarity", "needs-setup"),
        cell("northwind.example", "uptime", "needs-setup"),
      ],
    },
    [],
    [lane("uptime", "Uptime monitoring", "shared")],
  );

  /** A source nothing on Integrations connects is no to-do while it is only
   * Not set up, and the grid draws no row for it; once a site uses it, it is
   * listed like any other. */
  it("offers no to-do and no grid row for a source nothing on Integrations connects", () => {
    const { container, getByText, queryByText } = renderRoute(wiring);
    expect(queryByText("Connect Uptime monitoring once")).toBeNull();
    expect(getByText("Nothing to set up")).toBeInTheDocument();
    // A provider's source belongs to the Connections panel alone.
    expect(queryByText("Connect Google Search Console once")).toBeNull();
    expect(queryByText(/Microsoft Clarity/, { selector: "section[aria-label='Other sources'] *" })).toBeNull();
    expect(queryByText("Finish setup on Meadow Board")).toBeNull();
    openPanel("audit");
    expect(container.querySelector("table")?.textContent).not.toContain("Uptime");
  });

  const inUse = matrix(
    {
      "meadow.example": [cell("meadow.example", "gsc", "live"), cell("meadow.example", "clarity", "live"), cell("meadow.example", "uptime", "degraded")],
      "northwind.example": [cell("northwind.example", "gsc", "live"), cell("northwind.example", "clarity", "live"), cell("northwind.example", "uptime", "needs-setup")],
    },
    [],
    [lane("uptime", "Uptime monitoring", "shared")],
  );

  it("lists a source nothing connects once a site uses it, and opens it on where it is fixed", () => {
    const { container } = renderRoute(inUse);
    const list = container.querySelector<HTMLElement>("section[aria-label='Other sources']")!;
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The grid's own status word leads the row; for uptime, what is down: the site.
    expect(row.textContent).toContain("Site down");
    expect(row.textContent).not.toContain("degradation");
    expect(row.textContent).toContain("Meadow Board");
    expect(row.textContent).not.toContain("Northwind");
    fireEvent.click(row.querySelector("button")!);
    expect(row.querySelector('a[href="/integrations"]')).not.toBeNull();
    expect(row.textContent).not.toContain("One portfolio account covers every site.");
    openPanel("audit");
    expect(container.querySelector("table")?.textContent).toContain("Uptime");
  });

  /** A site the register holds no status for on a data source reads that
   * source as not applicable; each such site is one row, opening its Data sources. */
  it("names each site that has no status for a data source, and opens its Data sources", () => {
    const { container } = renderRoute({
      ...inUse,
      undeclared: [
        { laneId: "clarity", label: "Microsoft Clarity", assets: ["northwind.example"] },
        { laneId: "posthog", label: "PostHog", assets: ["meadow.example", "northwind.example"] },
      ],
    });
    const list = container.querySelector<HTMLElement>("section[aria-label='Other sources']")!;
    const rows = [...list.querySelectorAll("li")].filter((row) => row.textContent?.includes("Set source status"));
    expect(rows).toHaveLength(2);
    const [northwind, meadow] = rows;
    expect(northwind!.textContent).toContain("Set source status on Northwind");
    expect(northwind!.textContent).toContain("Microsoft Clarity · PostHog");
    expect(meadow!.textContent).toContain("Set source status on Meadow Board");
    expect(meadow!.textContent).toContain("PostHog");
    fireEvent.click(northwind!.querySelector("button")!);
    expect(northwind!.querySelector('a[href="/assets/northwind.example/sources"]')).not.toBeNull();
  });

  it("names no site when every site has a status for every source", () => {
    const { container } = renderRoute({ ...inUse, undeclared: [] });
    expect(container.querySelector("section[aria-label='Other sources']")?.textContent).not.toContain("Set source status");
  });

  /** One name for the nightly report, the lexicon's, and the grid's status word. */
  it("names the nightly report once, and says a late one is overdue", () => {
    const late = "2026-08-01T06:00:00.000Z";
    const nightly: DerivedLaneRow = {
      catalog: { ...lane("nightly-report", "Daily site report", "per-property", "property"), derived: true, scope: "both" },
      cells: {
        "meadow.example": {
          assetId: "meadow.example", laneId: "nightly-report", effective: "degraded",
          evidence: [{ polarity: "against", source: "Last nightly report accepted", detail: "due every 24h", at: late }],
        },
        "northwind.example": { assetId: "northwind.example", laneId: "nightly-report", effective: "not-applicable", evidence: [] },
      },
    };
    const { container } = renderRoute(matrix({ "meadow.example": [], "northwind.example": [] }, [nightly]));
    const list = container.querySelector<HTMLElement>("section[aria-label='Other sources']")!;
    expect([...list.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("Nightly report overdue"),
    ]);
    expect(container.textContent).toContain("1 other source not working");
    expect(container.textContent).not.toContain("source failing");
    const evidence = [...container.querySelectorAll<HTMLElement>("span[title]")]
      .find((label) => label.title.startsWith("Daily site report ·") || label.title.startsWith("Nightly report ·"));
    expect(evidence?.textContent).toBe("Nightly report");
    openPanel("audit");
    expect(container.querySelector("table")?.textContent).toContain("Nightly report");
    expect(container.textContent).not.toMatch(/degradation|Daily site report|Daily asset report/);
  });

  /** The audit measures the first screen against a block the page names. Not
   * one of these five figures has a series: the store keeps the current state
   * of every connection and no by-day record, so each declares how its total
   * divides (`data-composition`). */
  it("declares its hero: the connections, with their counts", () => {
    const { container } = renderRoute(blocked);

    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector("[data-connections] [data-kpi-strip]")).not.toBeNull();

    openPanel("spend");
    const kpis = [...container.querySelectorAll("[data-kpi]")].filter((kpi) => !kpi.closest("[data-connections]"));
    expect(kpis.map((kpi) => kpi.getAttribute("data-kpi"))).toEqual(["Expiring", "Data spend"]);
    for (const label of ["Expiring", "Data spend"]) {
      const kpi = container.querySelector(`[data-kpi="${label}"]`)!;
      expect(kpi.querySelector("[data-composition]"), label).not.toBeNull();
    }
  });

  /** The catalog's full name earns every word in the audit matrix; in a
   * five-across strip it truncates mid-word, so the strip uses the short
   * names with the full one on hover. */
  it("names each source in the strip the short way, with the full name on hover", () => {
    const { container } = renderRoute(
      matrix(
        {
          "meadow.example": [cell("meadow.example", "gsc", "live")],
          "northwind.example": [cell("northwind.example", "gsc", "live")],
        },
        [
          {
            catalog: {
              ...lane("ga4", "Google Analytics 4 (GA4 Data API)", "shared"),
              derived: true,
            },
            cells: {
              "meadow.example": {
                assetId: "meadow.example",
                laneId: "ga4",
                effective: "live",
                evidence: [
                  {
                    polarity: "supporting",
                    source: "Last collector run",
                    detail: "The run finished with rows.",
                    at: "2026-08-04T09:00:00.000Z",
                  },
                ],
              },
            },
          },
        ],
      ),
    );

    const label = container.querySelector('[title^="Google Analytics ·"]')!;
    expect(label.textContent).toBe("GA4");
  });

  /** A view surface names the register that declares the lanes in words,
   * never as a path the reader cannot act on from here. */
  it("carries no owner chip and no config path", () => {
    const { container } = renderRoute(blocked);

    expect(container.querySelector("[data-owner-chip]")).toBeNull();
    expect(container.textContent).not.toContain("config/integrations.json");
  });

  it("carries no About", () => {
    const { container } = renderRoute(blocked);
    expect(container.querySelector("[data-about]")).toBeNull();
  });

  it("keeps the matrix reachable, and closed", () => {
    const { container, getByText } = renderRoute(blocked);
    const closed = container.querySelector('[data-panel="audit"]')!;
    // Closed means not rendered, not merely hidden: a closed `<details>` still
    // lays its contents out.
    expect(closed.hasAttribute("data-panel-open")).toBe(false);
    expect(closed.querySelector("table")).toBeNull();
    expect(getByText("Every source, site by site")).toBeInTheDocument();

    const audit = openPanel("audit");
    expect(audit.textContent).toContain("Google Search Console");
    expect(audit.textContent).toContain("Meadow Board");
  });

  it("answers a clear portfolio in one line instead of a grid to read", () => {
    const { getByText } = renderRoute(
      matrix({
        "meadow.example": [
          cell("meadow.example", "gsc", "live"),
          cell("meadow.example", "clarity", "not-applicable"),
        ],
        "northwind.example": [
          cell("northwind.example", "gsc", "live"),
          cell("northwind.example", "clarity", "skipped"),
        ],
      }),
    );
    expect(getByText("Nothing to set up")).toBeInTheDocument();
    expect(openPanel("audit").querySelector("table")).not.toBeNull();
  });
});

describe("which credentials are still on the environment file", () => {
  const healthy = () =>
    matrix({
      "meadow.example": [cell("meadow.example", "gsc", "live")],
      "northwind.example": [cell("northwind.example", "gsc", "live")],
    });

  /** A `StatusBanner`: one line, above the hero, rendering nothing at all
   * when the state it reports is closed. */
  const banner = (container: HTMLElement) => [...container.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes('legacy credential')) ?? null;

  it("names them in one line, with where to move them", () => {
    // A portfolio that reads entirely green here, and depends on a gitignored
    // file a fresh install would not have.
    const { container } = renderRoute(healthy(), [
      ["google", "env"],
      ["bing-webmaster", "store"],
      ["dataforseo", "env"],
    ]);
    const note = banner(container)!;
    expect(note).toHaveTextContent("2 connections use legacy credentials");
    expect(note).toHaveTextContent("google, dataforseo");
    expect(note).toHaveTextContent("manage this connection in Integrations");
    expect(note).not.toHaveTextContent("they work");
    expect(note.querySelector('a[href="/integrations"]')).not.toBeNull();
  });

  it("says nothing at all when every credential is in the store", () => {
    const { container } = renderRoute(healthy(), [
      ["google", "store"],
      ["calendar", "none"],
    ]);
    expect(banner(container)).toBeNull();
  });

  it("is a note, never a lane state — the matrix keeps its five", () => {
    // A lane can be Working while its credential is Legacy env. Folding that
    // into the matrix would invent a sixth state or bury it in a cell.
    const { container } = renderRoute(healthy(), [["google", "env"]]);
    expect(openPanel("audit").textContent).not.toContain("environment file");
    expect(banner(container)).not.toBeNull();
  });
});


describe('source history shows available observations', () => {
  it('fits sparse history to its actual calendar extent and explains gaps', () => {
    const { container, getByText } = renderHealth({ history: { ...emptyIntegrationsHistory(), days: 3, sources: [{ source: 'gsc', points: [{ t: '2026-08-01', v: 24 }, { t: '2026-08-02', v: 48 }, { t: '2026-08-04', v: 12 }] }] } });
    expect(getByText('3 daily snapshots · 1 day without a recorded snapshot')).toBeInTheDocument();
    expect(getByText('View data · 4 days')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-hero-point="Stalest source"]')).toHaveLength(2);
  });
  it('draws no source-history card until it has three days to draw', () => {
    const { container } = renderHealth({ history: emptyIntegrationsHistory() });
    expect(container.querySelector('[data-source-history]')).toBeNull();
    expect(container.querySelector('[aria-label="Source history"]')).toBeNull();
  });
});

vi.mock('@/hooks/useIntegrationHealth', () => ({ INTEGRATION_HEALTH_KEY: ['integration-health'], useIntegrationHealth: () => ({ data: undefined, isError: false, status: integrationStatus(undefined, false, Date.now()) }) }));
