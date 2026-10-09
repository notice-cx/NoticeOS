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

// /health after beads `ro-9mx` and `ro-034`. The page used to open on the
// matrix, which answers "what state is everything in" — a question nobody
// arrives with. It now opens on what to unblock next, the matrix is the audit
// view underneath, and that matrix reads in layers: the OS's own connection,
// then provider accounts, then each asset's own wiring.
//
// It answered at `/integrations` too until bead `ro-vu8d.2`, which gave that
// path its own page. The two questions were only ever sharing an address: this
// one observes connections, that one MAKES them.

const state = vi.hoisted(() => ({
  data: null as IntegrationsMatrix | null,
  /** The credential summaries this page also reads, so it can say which
   * providers are still on the environment file (bead `ro-vu8d.5`). */
  providers: null as { providers: { provider: unknown; credential: Record<string, unknown> }[] } | null,
}));

vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: () => ({ data: undefined, isError: false }) }));
// System health names the OS's own problems from the Wall's read (D45); these
// cases are about the workflow and connection reads, so the Wall has none.
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
    // `/integrations` was an alias for this page from bead `ro-034` until bead
    // `ro-vu8d.2` gave that path its own page — the one where a credential is
    // entered. This page still answers at `/health`, which is what every link
    // the Tower emitted to the MATRIX points at.
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
      { id: "meals.example", displayName: "Meal Planner", isOs: false },
      { id: "nosh.example", displayName: "Nosh", isOs: false },
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
        { asset: "meals.example", spentUsd: 6.2, unknownPrices: 0 },
        { asset: "nosh.example", spentUsd: 2.2, unknownPrices: 0 },
      ],
    },
  };
}

/**
 * The page over a matrix that is only about the daily history (bead
 * `ro-78qo.41`) — every other slice is the standing fixture's.
 */
function renderHealth(over: Partial<IntegrationsMatrix>) {
  return renderRoute({ ...matrix({ "meals.example": [] }), ...over });
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
 * Open one of the page's collapsed panels (doc 21, bead `ro-78qo.16`).
 *
 * A panel MOUNTS ITS BODY ONLY WHEN OPEN. A closed `<details>` still lays its
 * contents out, so the 98-cell audit matrix inside one was still on the page's
 * measured height and on `surface:audit`'s prose count while nobody could see
 * it. A case about the matrix presses the header first, exactly as an operator
 * does.
 */
function openPanel(mark: string): HTMLElement {
  const panel = document.querySelector(`[data-panel="${mark}"]`);
  if (!(panel instanceof HTMLElement)) throw new Error(`no panel ${mark}`);
  if (!panel.hasAttribute("data-panel-open")) {
    fireEvent.click(panel.querySelector("button")!);
  }
  return panel;
}

describe("the Health page is layered (bead ro-034)", () => {
  const derived: DerivedLaneRow[] = [
    {
      catalog: {
        ...lane("egress", "The OS's own internet connection", "shared", "os"),
        derived: true,
        scope: "portfolio",
      },
      cells: {
        "meals.example": {
          assetId: "meals.example",
          laneId: "egress",
          effective: "not-applicable",
          evidence: [],
        },
        "nosh.example": {
          assetId: "nosh.example",
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
        "meals.example": {
          assetId: "meals.example",
          laneId: "nightly-report",
          effective: "live",
          evidence: [],
        },
        "nosh.example": {
          assetId: "nosh.example",
          laneId: "nightly-report",
          effective: "live",
          evidence: [],
        },
      },
    },
  ];

  it("names the page Health — the top row is no longer a data source", () => {
    const { getByRole } = renderRoute(matrix({ "meals.example": [], "nosh.example": [] }));
    expect(getByRole("heading", { level: 1 }).textContent).toBe("System health");
  });

  it("groups the matrix rows os → provider → asset, widest blast radius first", () => {
    renderRoute(
      matrix(
        {
          "meals.example": [
            cell("meals.example", "gsc", "live"),
            cell("meals.example", "clarity", "needs-setup"),
          ],
          "nosh.example": [
            cell("nosh.example", "gsc", "live"),
            cell("nosh.example", "clarity", "needs-setup"),
          ],
        },
        derived,
      ),
    );

    // The audit view is the page's secondary read since doc 21 — opened here
    // the way an operator opens it.
    const audit = openPanel("audit");
    const headings = [...audit.querySelectorAll('table th[scope="rowgroup"]')].map(
      (th) => th.textContent ?? "",
    );
    expect(headings).toHaveLength(3);
    expect(headings[0]).toContain("The OS itself");
    expect(headings[1]).toContain("Provider accounts");
    expect(headings[2]).toContain("The site's own wiring");
    // The order is the argument: the OS first, then accounts, then wiring.
    // A heading is its label alone, never a sentence under it.
    expect(headings[0]).toBe("The OS itself");

    // Each heading heads its own row group, so the lanes land under the layer
    // they belong to rather than in one flat list with decoration in it.
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

describe("/health — the page leads with what to unblock next (bead ro-9mx)", () => {
  const blocked = matrix({
    "meals.example": [
      cell("meals.example", "gsc", "needs-setup"),
      cell("meals.example", "clarity", "needs-setup"),
    ],
    "nosh.example": [
      cell("nosh.example", "gsc", "needs-setup"),
      cell("nosh.example", "clarity", "degraded"),
    ],
  });

  it("counts connections in the connection vocabulary, with nothing to open to read them", () => {
    const { container, queryByRole } = renderRoute(blocked);
    const strip = container.querySelector("[data-connections] [data-kpi-strip]")!;
    expect([...strip.querySelectorAll("[data-kpi]")].map((kpi) => kpi.getAttribute("data-kpi"))).toEqual([
      "Sites failing", "Sites overdue", "Reports missing", "Sites working",
    ]);
    // The retired register strip is gone: one set of words for one subject.
    for (const retired of ["Verified working", "Not verified", "Degraded", "Not set up"]) {
      expect(container.querySelector(`[data-kpi="${retired}"]`)).toBeNull();
    }
    openPanel("spend");
    expect(queryByRole("button", { name: "About Data spend" })).toBeNull();
    expect(container.querySelector("button button, a button")).toBeNull();
  });

  const wiring = matrix(
    {
      "meals.example": [
        cell("meals.example", "gsc", "needs-setup"),
        cell("meals.example", "clarity", "degraded"),
        cell("meals.example", "uptime", "needs-setup"),
      ],
      "nosh.example": [
        cell("nosh.example", "gsc", "needs-setup"),
        cell("nosh.example", "clarity", "needs-setup"),
        cell("nosh.example", "uptime", "needs-setup"),
      ],
    },
    [],
    [lane("uptime", "Uptime monitoring", "shared")],
  );

  /**
   * Bead ro-ujb9.133: Integrations has no card that connects uptime
   * monitoring, so "Connect Uptime monitoring once" led nowhere and stayed on
   * the page forever. A source nothing connects is no to-do while it is only
   * Not set up, and the grid draws no row for it; once a site uses it, it is
   * listed like any other.
   */
  it("offers no to-do and no grid row for a source nothing on Integrations connects", () => {
    const { container, getByText, queryByText } = renderRoute(wiring);
    expect(queryByText("Connect Uptime monitoring once")).toBeNull();
    expect(getByText("Nothing to set up")).toBeInTheDocument();
    // A provider's source belongs to the Connections panel alone: listing it
    // here too would be the same site in a second vocabulary.
    expect(queryByText("Connect Google Search Console once")).toBeNull();
    expect(queryByText(/Microsoft Clarity/, { selector: "section[aria-label='Other sources'] *" })).toBeNull();
    expect(queryByText("Finish setup on Meal Planner")).toBeNull();
    openPanel("audit");
    expect(container.querySelector("table")?.textContent).not.toContain("Uptime");
  });

  const inUse = matrix(
    {
      "meals.example": [cell("meals.example", "gsc", "live"), cell("meals.example", "clarity", "live"), cell("meals.example", "uptime", "degraded")],
      "nosh.example": [cell("nosh.example", "gsc", "live"), cell("nosh.example", "clarity", "live"), cell("nosh.example", "uptime", "needs-setup")],
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
    // The grid's own status word leads the row (bead ro-ffbg), never
    // "Review … degradation" — for uptime, what is down: the site (bead
    // ro-ujb9.165).
    expect(row.textContent).toContain("Site down");
    expect(row.textContent).not.toContain("degradation");
    // The site whose monitor failed, not the one that never had one.
    expect(row.textContent).toContain("Meal Planner");
    expect(row.textContent).not.toContain("Nosh");
    fireEvent.click(row.querySelector("button")!);
    expect(row.querySelector('a[href="/integrations"]')).not.toBeNull();
    expect(row.textContent).not.toContain("One portfolio account covers every site.");
    openPanel("audit");
    expect(container.querySelector("table")?.textContent).toContain("Uptime");
  });

  /**
   * Bead ro-ujb9.96.15: a site the register holds no status for on a data
   * source reads that source as not applicable, so it was hidden on the site
   * and named nowhere. Each such site is one row, opening its Data sources.
   */
  it("names each site that has no status for a data source, and opens its Data sources", () => {
    const { container } = renderRoute({
      ...inUse,
      undeclared: [
        { laneId: "clarity", label: "Microsoft Clarity", assets: ["nosh.example"] },
        { laneId: "posthog", label: "PostHog", assets: ["meals.example", "nosh.example"] },
      ],
    });
    const list = container.querySelector<HTMLElement>("section[aria-label='Other sources']")!;
    const rows = [...list.querySelectorAll("li")].filter((row) => row.textContent?.includes("Set source status"));
    expect(rows).toHaveLength(2);
    const [nosh, meals] = rows;
    expect(nosh!.textContent).toContain("Set source status on Nosh");
    expect(nosh!.textContent).toContain("Microsoft Clarity · PostHog");
    expect(meals!.textContent).toContain("Set source status on Meal Planner");
    expect(meals!.textContent).toContain("PostHog");
    fireEvent.click(nosh!.querySelector("button")!);
    expect(nosh!.querySelector('a[href="/assets/nosh.example/sources"]')).not.toBeNull();
  });

  it("names no site when every site has a status for every source", () => {
    const { container } = renderRoute({ ...inUse, undeclared: [] });
    expect(container.querySelector("section[aria-label='Other sources']")?.textContent).not.toContain("Set source status");
  });

  /**
   * Bead ro-ffbg: one screen called the nightly report "Daily asset report"
   * in the grid and Other sources and "Nightly report" in Latest evidence, and
   * asked the operator to "Review Daily asset report degradation". One name
   * now — the lexicon's — and the grid's status word.
   */
  it("names the nightly report once, and says a late one is overdue", () => {
    const late = "2026-08-01T06:00:00.000Z";
    const nightly: DerivedLaneRow = {
      // The catalog row as the payload sends it; the client names it.
      catalog: { ...lane("nightly-report", "Daily site report", "per-property", "property"), derived: true, scope: "both" },
      cells: {
        "meals.example": {
          assetId: "meals.example", laneId: "nightly-report", effective: "degraded",
          evidence: [{ polarity: "against", source: "Last nightly report accepted", detail: "due every 24h", at: late }],
        },
        "nosh.example": { assetId: "nosh.example", laneId: "nightly-report", effective: "not-applicable", evidence: [] },
      },
    };
    const { container } = renderRoute(matrix({ "meals.example": [], "nosh.example": [] }, [nightly]));
    const list = container.querySelector<HTMLElement>("section[aria-label='Other sources']")!;
    expect([...list.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("Nightly report overdue"),
    ]);
    // The page's summary counts it without calling an overdue report failing.
    expect(container.textContent).toContain("1 other source not working");
    expect(container.textContent).not.toContain("source failing");
    // Latest evidence names it the same way.
    const evidence = [...container.querySelectorAll<HTMLElement>("span[title]")]
      .find((label) => label.title.startsWith("Daily site report ·") || label.title.startsWith("Nightly report ·"));
    expect(evidence?.textContent).toBe("Nightly report");
    openPanel("audit");
    expect(container.querySelector("table")?.textContent).toContain("Nightly report");
    expect(container.textContent).not.toMatch(/degradation|Daily site report|Daily asset report/);
  });

  /**
   * The audit measures the first screen against a block the page NAMES
   * (`scripts/README.md`), and on this surface the answer is the counts, the
   * sources' own freshness and the queue — not a chart.
   */
  /**
   * EVERY FIGURE SHOWS ITS COMPOSITION, NOT A SERIES (doc 21's "every number
   * that CAN have a series", bead `ro-78qo.6`). Not one of these five has a
   * series: the store keeps the CURRENT state of every connection and no
   * by-day record of any of it. What each has instead is how its total divides,
   * which is what `data-composition` declares — and `ro-78qo.30` is the roll-up
   * that would give the strip a real trend.
   */
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

  /**
   * A LABEL THAT FITS IS A LABEL A READER CAN COMPARE (doc 17).
   *
   * The catalog's name is the source's full one and earns every word in the
   * audit matrix, where a row is named once. In a five-across strip it does
   * not: "Google Analytics 4 (GA4 Data API)" truncated mid-word, three of five
   * labels became guesses, and a row of comparable measures stopped comparing.
   * The strip uses the short names desk copy already uses, with the full one on
   * the hover.
   */
  it("names each source in the strip the short way, with the full name on hover", () => {
    const { container } = renderRoute(
      matrix(
        {
          "meals.example": [cell("meals.example", "gsc", "live")],
          "nosh.example": [cell("nosh.example", "gsc", "live")],
        },
        [
          {
            catalog: {
              ...lane("ga4", "Google Analytics 4 (GA4 Data API)", "shared"),
              derived: true,
            },
            cells: {
              "meals.example": {
                assetId: "meals.example",
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

    // The full name is the product's (integrationLabel), as the client names
    // every catalog row it is sent.
    const label = container.querySelector('[title^="Google Analytics ·"]')!;
    expect(label.textContent).toBe("GA4");
  });

  /**
   * NO OWNER CHIP (doc 21 principle 4). This is a view surface: the register
   * that declares the lanes is named in `About`, in words, rather than printed
   * as a path the reader cannot act on from here.
   */
  it("carries no owner chip and no config path", () => {
    const { container } = renderRoute(blocked);

    expect(container.querySelector("[data-owner-chip]")).toBeNull();
    expect(container.textContent).not.toContain("config/integrations.json");
  });

  /** No paragraph to open: the page's states and counts read without one. */
  it("carries no About", () => {
    const { container } = renderRoute(blocked);
    expect(container.querySelector("[data-about]")).toBeNull();
  });

  it("keeps the matrix reachable, and closed", () => {
    const { container, getByText } = renderRoute(blocked);
    const closed = container.querySelector('[data-panel="audit"]')!;
    // CLOSED MEANS NOT RENDERED, not merely hidden: a closed `<details>` still
    // lays its contents out, which is how 98 cells stayed on this page's
    // measured height with nobody able to see them.
    expect(closed.hasAttribute("data-panel-open")).toBe(false);
    expect(closed.querySelector("table")).toBeNull();
    expect(getByText("Every source, site by site")).toBeInTheDocument();

    // Still reachable — a secondary view, not a removed one.
    const audit = openPanel("audit");
    expect(audit.textContent).toContain("Google Search Console");
    expect(audit.textContent).toContain("Meal Planner");
  });

  it("answers a clear portfolio in one line instead of a grid to read", () => {
    const { getByText } = renderRoute(
      matrix({
        "meals.example": [
          cell("meals.example", "gsc", "live"),
          cell("meals.example", "clarity", "not-applicable"),
        ],
        "nosh.example": [
          cell("nosh.example", "gsc", "live"),
          cell("nosh.example", "clarity", "skipped"),
        ],
      }),
    );
    expect(getByText("Nothing to set up")).toBeInTheDocument();
    // The audit view is unchanged by the portfolio being healthy — it is still
    // there for the occasion someone wants the cross-asset comparison.
    expect(openPanel("audit").querySelector("table")).not.toBeNull();
  });
});

describe("which credentials are still on the environment file (bead ro-vu8d.5)", () => {
  const healthy = () =>
    matrix({
      "meals.example": [cell("meals.example", "gsc", "live")],
      "nosh.example": [cell("nosh.example", "gsc", "live")],
    });

  /** A `StatusBanner` since doc 21 — one line, above the hero, and it renders
   * nothing at all when the state it reports is closed. */
  const banner = (container: HTMLElement) => [...container.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes('legacy credential')) ?? null;

  it("names them in one line, with where to move them", () => {
    // The case this exists for: a portfolio that reads entirely green here, and
    // depends on a gitignored file a fresh install would not have.
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
    // A lane can be Working while its credential is Legacy env, and that gap is
    // the whole of epic ro-vu8d. Folding it into the matrix would either invent
    // a sixth state or bury the fact in a cell nobody expands.
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
  it('draws no source-history card until it has three days to draw (D45)', () => {
    const { container } = renderHealth({ history: emptyIntegrationsHistory() });
    // A chart too short to be a line is not a card of its own; it arrives
    // with its third day.
    expect(container.querySelector('[data-source-history]')).toBeNull();
    expect(container.querySelector('[aria-label="Source history"]')).toBeNull();
  });
});

vi.mock('@/hooks/useIntegrationHealth', () => ({ INTEGRATION_HEALTH_KEY: ['integration-health'], useIntegrationHealth: () => ({ data: undefined, isError: false, status: integrationStatus(undefined, false, Date.now()) }) }));
