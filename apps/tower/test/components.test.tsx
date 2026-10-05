import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "./render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AnnotationItem } from "@shared/annotations";
import type {
  DataForSeoQueryVisibilityRow,
  ExecutiveInsight,
  FlagRecord,
  ExecutiveSnapshot,
  HandoffBead,
  SearchPageMover,
  SearchPageTrends,
  SearchQueryTrends,
  SerpPanelQuery,
  SerpPanelSnapshot,
} from "@shared/asset-detail";
import { serpPanelScoreboard } from "@shared/asset-detail";
import { findingBasis, recommendationValidity } from "@shared/recommendation-validity";
import type { AttentionItem, PanelReview } from "@shared/wall";
import type { SourceReading } from "@shared/connection-status";
import { AgeBadge } from "@/components/AgeBadge";
import { AlertList, AlertRow } from "@/components/AlertRow";
import { AiOverviewGlyphs } from "@/components/AiOverviewGlyphs";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { alertTaskHandoff, isGrouped, memberNames } from "@/lib/attention";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { ExecutiveFindingsList } from "@/components/ExecutiveFindingsList";
import { AppToaster } from "@/lib/toaster";
import {
  ExecutiveInsightRow,
  executiveInsightMarkdown,
  findingTaskHandoff,
} from "@/components/ExecutiveInsightRow";
import { taskHandoffPrefill } from "@/lib/task-handoff";
import { KnobRow } from "@/components/KnobRow";
import { OwnerChip } from "@/components/OwnerChip";
import { PageDecisions } from "@/components/PageDecisions";
import { PanelReviewLine } from "@/components/PanelReviewLine";
import {
  PropertyFavicon,
  propertyFaviconUrl,
} from "@/components/PropertyFavicon";
import {
  QueryVisibilityRankings,
  queryWindowComparisonLabel,
} from "@/components/QueryVisibilityRankings";
import { ProgressRing } from "@/components/ProgressRing";
import { SegmentBar } from "@/components/SegmentBar";
import { SerpPanelBoard } from "@/components/SerpPanelBoard";
import { ScheduledLanesPanel } from "@/components/ScheduledLanes";
import { SeverityDot } from "@/components/SeverityDot";
import { StateChip } from "@/components/StateChip";
import { Tabs, type TabSpec } from "@/components/Tabs";
import { Timeline } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { PriorityBar } from "@/components/PriorityBar";
import { COPY_FLASH_MS } from "@/hooks/useCopyFlash";
import { Stepper, lifecycleStepper } from "@/components/Stepper";
import { KitchenSinkRoute } from "@/routes/KitchenSinkRoute";
import { copyText } from "@/lib/clipboard";
import { queryDecisionMarkdown } from "@/lib/query-decision-markdown";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

/**
 * Every render in this file goes through a `QueryClient` (bead `ro-l1ed.4`).
 *
 * The finding, query and page rows embed `FileTaskButton`, which asks the task
 * lane whether this build may write before deciding whether to be enabled — so
 * they need a client where they never used to. Wrapping once here beats forty
 * call sites each saying the same thing, and the `rerender` returned wraps too,
 * so a re-render does not silently drop the provider the first one had.
 *
 * NOTHING answers the question in jsdom, so the button renders in its read-only
 * face throughout, which is the correct face for a surface with no lane behind
 * it. Filing itself is exercised in `test/task-composer.test.tsx`.
 */
function render(ui: ReactNode, options?: Parameters<typeof rtlRender>[1]) {
  const client = new QueryClient();
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  // `options` passes straight through, so the `{ wrapper: MemoryRouter }` the
  // bead-bearing renders need (HandoffBeadBadge's id is a Link) still applies —
  // it simply wraps this provider rather than the bare component.
  const result = rtlRender(wrap(ui), options);
  return {
    ...result,
    rerender: (next: ReactNode) => result.rerender(wrap(next)),
  };
}

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

describe("copyText LAN fallback", () => {
  it("copies through a temporary selected textarea outside a secure context", async () => {
    const originalClipboard = navigator.clipboard;
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "isSecureContext",
    );
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "execCommand",
    );
    const writeText = vi.fn();
    const execCommand = vi.fn(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        "textarea[data-clipboard-fallback]",
      );
      expect(textarea?.value).toBe("agent-ready Markdown");
      return true;
    });

    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    try {
      await copyText("agent-ready Markdown");

      expect(writeText).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(
        document.querySelector("textarea[data-clipboard-fallback]"),
      ).toBeNull();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
      if (secureContextDescriptor) {
        Object.defineProperty(
          window,
          "isSecureContext",
          secureContextDescriptor,
        );
      } else {
        Reflect.deleteProperty(window, "isSecureContext");
      }
      if (execCommandDescriptor) {
        Object.defineProperty(
          document,
          "execCommand",
          execCommandDescriptor,
        );
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });
});

describe("PropertyFavicon source routing", () => {
  it("asks every site for its own favicon, with no site singled out", () => {
    // Bead ro-ujb9.118: the Tower ships no icon for any particular site. The
    // same rule answers for every domain; a site without one draws its initial.
    for (const domain of ["example.com", "shop.example.org", "fin.example"]) {
      expect(propertyFaviconUrl(domain)).toBe(`https://${domain}/favicon.ico`);
    }
  });

  it("renders the raw icon without badge chrome and falls back to a letter", () => {
    const { container } = render(
      <PropertyFavicon domain="missing.invalid" displayName="Missing" />,
    );
    const root = container.querySelector("[data-property-favicon]")!;
    expect(root.className).not.toMatch(/rounded|bg-/u);
    fireEvent.error(root.querySelector("img")!);
    expect(root.textContent).toBe("M");
  });
});

describe("QueryVisibilityRankings comparison labels", () => {
  const asset = {
    id: "meals.example",
    displayName: "Meal Planner",
    domain: "meals.example",
  };
  const weeklyTrend = {
    provider: "bing" as const,
    currentStart: "2026-06-12",
    currentEnd: "2026-07-24",
    previousStart: "2026-04-24",
    previousEnd: "2026-06-05",
    daysPerWindow: 7,
    movers: [],
    evidence: [],
    source: "bing-webmaster/queries",
    caveat: "Only queries present in both windows are ranked.",
  };

  it("states the comparison in weeks instead of exposing archive dates", () => {
    expect(queryWindowComparisonLabel(weeklyTrend)).toBe(
      "Latest 7 weeks vs prior 7",
    );
    const { container, getByText } = render(
      <QueryVisibilityRankings
        trends={{ google: null, bing: weeklyTrend, dataforseo: null }}
        asset={asset}
      />,
    );

    expect(
      getByText("Bing · Latest 7 weeks vs prior 7"),
    ).toHaveAttribute(
      "title",
      "Exact periods: 2026-06-12–2026-07-24, compared with 2026-04-24–2026-06-05",
    );
    expect(container.textContent).not.toContain("reported dates");
    expect(container.textContent).not.toContain("2026-06-12");
  });

  // The lane's own pre-ranking check. It exists to prove the check RAN, so the
  // surface has to keep three states apart: excluded something, excluded
  // nothing, and never checked.
  it("renders each lane's grounding proof, including the lane that excluded nothing", () => {
    const googleTrend = {
      ...weeklyTrend,
      provider: "google" as const,
      source: "gsc/query",
      evidence: [
        {
          label: "Grounding queries excluded",
          value: "4,217",
          detail:
            "9.0% of captured impressions · 102 quoted-literal queries · 0 clicks",
        },
      ],
    };
    const bingTrend = {
      ...weeklyTrend,
      evidence: [
        {
          label: "Grounding queries excluded",
          value: "0",
          detail: "No quoted-literal queries in this window",
        },
      ],
    };
    const { container } = render(
      <QueryVisibilityRankings
        trends={{ google: googleTrend, bing: bingTrend, dataforseo: null }}
        asset={asset}
      />,
    );

    const google = container.querySelector('[data-lane-evidence="google"]');
    expect(google?.textContent).toContain("Grounding queries excluded");
    expect(google?.textContent).toContain("4,217");
    expect(google?.textContent).toContain("102 quoted-literal queries");

    // The zero lane is the whole point: it says the check ran and came back
    // clean, in the same place and the same shape as the lane that excluded
    // thousands of impressions.
    const bing = container.querySelector('[data-lane-evidence="bing"]');
    expect(bing?.textContent).toContain("Grounding queries excluded");
    expect(bing?.textContent).toContain("0");
    expect(bing?.textContent).toContain(
      "No quoted-literal queries in this window",
    );

    // And the closed drawer says a proof is inside rather than only caveats.
    expect(container.textContent).toContain("Sources and limits · 2 checks run");
  });

  it("leaves a lane that ran no check saying nothing at all", () => {
    // Not the same fact as excluding nothing, and it must not read like it: no
    // row, no count, and the lane's provenance line still present.
    const { container } = render(
      <QueryVisibilityRankings
        trends={{ google: null, bing: weeklyTrend, dataforseo: null }}
        asset={asset}
      />,
    );

    expect(container.querySelector('[data-source-note="bing"]')).not.toBeNull();
    expect(container.querySelector("[data-lane-evidence]")).toBeNull();
    expect(container.textContent).not.toContain("Grounding queries excluded");
    expect(container.textContent).toContain("Sources and limits");
    expect(container.textContent).not.toContain("checks run");
  });

  it("merges provider evidence into one query row and labels estimated demand", () => {
    const googleTrend = {
      ...weeklyTrend,
      provider: "google" as const,
      movers: [
        {
          query: "weekly meal plan",
          currentImpressions: 140,
          previousImpressions: 100,
          impressionDelta: 40,
          impressionDeltaPercent: 40,
          currentPosition: 6,
          previousPosition: 7,
          positionImprovement: 1,
        },
      ],
      source: "gsc/query",
    };
    const bingTrend = {
      ...weeklyTrend,
      movers: [
        {
          query: "Weekly Meal Plan",
          currentImpressions: 12,
          previousImpressions: 10,
          impressionDelta: 2,
          impressionDeltaPercent: 20,
          currentPosition: 8,
          previousPosition: 9,
          positionImprovement: 1,
        },
      ],
    };
    const { container, getByText, getAllByText } = render(
      <QueryVisibilityRankings
        trends={{
          google: googleTrend,
          bing: bingTrend,
          dataforseo: {
            observedAt: "2026-07-28",
            queries: [
              {
                query: "weekly meal plan",
                monthlySearches: 1900,
                organicPosition: 7,
                previousOrganicPosition: null,
                positionImprovement: null,
                keywordDifficulty: 24,
                estimatedVisits: 31,
                page: "/meal-plan",
                intent: "informational",
                aiOverview: "cited",
                aiCitationPosition: 2,
                aioDevices: [],
              },
            ],
            source: "dataforseo/ranked-keywords",
            caveat: "Estimated demand, not impressions.",
          },
        }}
        asset={asset}
      />,
    );

    expect(getAllByText("weekly meal plan", { exact: false })).toHaveLength(1);
    expect(getByText("1,900")).toBeInTheDocument();
    // Modelled demand is labelled where it is stated: the Market evidence line.
    expect(container.textContent).toContain("Market: 1,900 searches/month");
    expect(getByText("Near win")).toBeInTheDocument();
    expect(getByText("Cited source", { exact: false })).toBeInTheDocument();
    // The decision reads "what the evidence says → what to do", one short
    // imperative naming the page (bead `ro-ujb9.96.6.5`); the units are
    // labelled on the evidence lines, not explained in a paragraph.
    expect(container.textContent).toContain(
      "Sharpen the title and opening answer on /meal-plan",
    );
    expect(container.textContent).not.toContain("measure your exposure");
    const decision = container.querySelector(
      '[data-decision-kind="near-win"]',
    );
    expect(decision).toHaveAttribute("data-decision-tone", "opportunity");
    expect(decision?.className).toContain("border-l-warn");
    expect(getByText("Near win").className).toContain("text-warn");
  });

  it("shows the intent and the estimated visits the clipboard used to keep to itself", () => {
    // Both fields rode in the payload and appeared only in the copied Markdown,
    // which is exactly backwards: intent and visits are what an act-vs-wait
    // judgement is made from, so they have to be readable before the copy.
    const { container, getByText } = render(
      <QueryVisibilityRankings
        trends={{
          google: null,
          bing: null,
          dataforseo: {
            observedAt: "2026-07-28",
            queries: [
              {
                query: "weekly meal plan",
                monthlySearches: 1900,
                organicPosition: 7,
                previousOrganicPosition: null,
                positionImprovement: null,
                keywordDifficulty: 24,
                estimatedVisits: 31,
                page: "/meal-plan",
                intent: "informational",
                aiOverview: "none",
                aiCitationPosition: null,
                aioDevices: [],
              },
              {
                // No intent classification and no visit estimate: the row must
                // simply say less, never render an empty token or a zero.
                query: "meal prep containers",
                monthlySearches: 480,
                organicPosition: 18,
                previousOrganicPosition: null,
                positionImprovement: null,
                keywordDifficulty: 31,
                estimatedVisits: null,
                page: "/containers",
                intent: null,
                aiOverview: "none",
                aiCitationPosition: null,
                aioDevices: [],
              },
            ],
            source: "dataforseo/ranked-keywords",
            caveat: "Estimated demand, not impressions.",
          },
        }}
        asset={asset}
      />,
    );

    expect(getByText("informational")).toBeInTheDocument();
    expect(getByText("31")).toBeInTheDocument();
    expect(container.textContent).toContain("visits/month at this rank");
    // The row without either field carries neither a stray token nor a 0.
    const containers = container.querySelector(
      '[data-decision-kind="ranking-opportunity"]',
    );
    expect(containers?.textContent).toContain("meal prep containers");
    expect(containers?.textContent).not.toContain("visits/month at this rank");
  });

  it("renders DataForSEO-only decisions when neither observed provider survived", () => {
    // The payload parser degrades providers independently, so a snapshot whose
    // Search Console/Bing blocks are missing still arrives with its DataForSEO
    // half intact — the panel must show that evidence, not an empty state.
    const { container, getByText, queryByText } = render(
      <QueryVisibilityRankings
        trends={{
          google: null,
          bing: null,
          dataforseo: {
            observedAt: "2026-07-28",
            queries: [
              {
                query: "weekly meal plan",
                monthlySearches: 1900,
                organicPosition: 14,
                previousOrganicPosition: null,
                positionImprovement: null,
                keywordDifficulty: 24,
                estimatedVisits: 31,
                page: "/meal-plan",
                intent: "informational",
                aiOverview: "none",
                aiCitationPosition: null,
                aioDevices: [],
              },
            ],
            source: "dataforseo/ranked-keywords",
            caveat: "Estimated demand, not impressions.",
          },
        }}
        asset={asset}
      />,
    );

    expect(getByText("Ranking opportunity")).toBeInTheDocument();
    expect(getByText("1,900")).toBeInTheDocument();
    expect(queryByText("No comparable Google or Bing windows", { exact: false })).toBeNull();
    expect(container.textContent).toContain("DataForSEO · ");
  });

  /**
   * Bead `ro-ogc7`. This case used to fail about one full-suite run in three and
   * pass every time alone, because its last assertion was a race against the
   * WALL CLOCK: the "Copied" confirmation clears itself `COPY_FLASH_MS` after
   * the copy, in real time, and a loaded 47-file run can put more than that
   * between the click and the assertion. Nothing about the copy path is
   * timing-dependent, so the clock is faked and the clearing becomes something
   * this test drives — including, now, the assertion that it happens at all.
   */
  it("copies the query decision with asset, exact evidence, and limitations", async () => {
    vi.useFakeTimers();
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const bingTrend = {
      ...weeklyTrend,
      movers: [
        {
          query: "jarra del buen beber",
          currentImpressions: 164,
          previousImpressions: 1640,
          impressionDelta: -1476,
          impressionDeltaPercent: -90,
          currentPosition: 10,
          previousPosition: 8.8,
          positionImprovement: -1.2,
        },
      ],
    };

    try {
      const { container, getByRole } = render(
        <QueryVisibilityRankings
          trends={{ google: null, bing: bingTrend, dataforseo: null }}
          asset={asset}
        />,
      );
      expect(
        container.querySelector('[data-decision-kind="recover"]'),
      ).toHaveAttribute("data-decision-tone", "loss");

      fireEvent.click(
        getByRole("button", {
          name: "Copy Markdown for jarra del buen beber",
        }),
      );

      // The copy settles on the MICROTASK queue — the clipboard mock resolves
      // immediately — so this drains it rather than waiting on any clock.
      await act(async () => {});
      expect(writeText).toHaveBeenCalledOnce();
      const markdown = String(writeText.mock.calls[0]?.[0]);
      expect(markdown).toContain(
        "# Query decision: jarra del buen beber",
      );
      expect(markdown).toContain(
        "- **Site:** Meal Planner (`meals.example`)",
      );
      expect(markdown).toContain("- **Decision:** Recover visibility");
      expect(markdown).toContain(
        "- **Current window:** 2026-06-12 to 2026-07-24",
      );
      expect(markdown).toContain("- **Impression change:** -90% (-1,476)");
      expect(markdown).toContain(
        "Only queries present in both windows are ranked.",
      );
      expect(markdown).toContain(
        "Google/Bing impressions are observed site exposure",
      );
      expect(
        getByRole("button", {
          name: "Copied for jarra del buen beber",
        }),
      ).toBeTruthy();

      // The confirmation is temporary, and the test now SAYS when it ends
      // instead of depending on how long it took to get here.
      await act(async () => {
        vi.advanceTimersByTime(COPY_FLASH_MS);
      });
      expect(
        getByRole("button", {
          name: "Copy Markdown for jarra del buen beber",
        }),
      ).toBeTruthy();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
      vi.useRealTimers();
    }
  });

  /**
   * The other half of bead `ro-ogc7` — the defect UNDER the flake.
   *
   * The confirmation used to be cleared by a bare `setTimeout` fired from the
   * click handler, owned by nobody. Two consequences, both proved here: the
   * timer outlived the row, so an unmounted component still had a callback
   * pointed at its dead state; and a second copy did not cancel the first
   * timer, so the confirmation an operator had just earned was cleared by the
   * PREVIOUS copy's deadline.
   */
  describe("the copy confirmation owns its own timer", () => {
    const soloTrend = {
      ...weeklyTrend,
      movers: [
        {
          query: "jarra del buen beber",
          currentImpressions: 164,
          previousImpressions: 1640,
          impressionDelta: -1476,
          impressionDeltaPercent: -90,
          currentPosition: 10,
          previousPosition: 8.8,
          positionImprovement: -1.2,
        },
      ],
    };

    const renderRow = () =>
      render(
        <QueryVisibilityRankings
          trends={{ google: null, bing: soloTrend, dataforseo: null }}
          asset={asset}
        />,
      );

    it("cancels the pending clear when the row unmounts", async () => {
      vi.useFakeTimers();
      const restore = withClipboard(vi.fn().mockResolvedValue(undefined));
      try {
        const { getByRole, unmount } = renderRow();
        fireEvent.click(
          getByRole("button", { name: "Copy Markdown for jarra del buen beber" }),
        );
        await act(async () => {});
        expect(vi.getTimerCount()).toBe(1);

        unmount();
        // Nothing is left pointing at a component that no longer exists.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        restore();
        vi.useRealTimers();
      }
    });

    it("restarts the window on a second copy rather than inheriting the first deadline", async () => {
      vi.useFakeTimers();
      const restore = withClipboard(vi.fn().mockResolvedValue(undefined));
      try {
        const { getByRole, queryByRole } = renderRow();
        const copied = () =>
          queryByRole("button", { name: "Copied for jarra del buen beber" });

        fireEvent.click(
          getByRole("button", { name: "Copy Markdown for jarra del buen beber" }),
        );
        await act(async () => {});
        expect(copied()).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(COPY_FLASH_MS - 400);
        });
        fireEvent.click(copied()!);
        await act(async () => {});

        // Past the FIRST copy's deadline, and still confirmed — which is what
        // the uncancelled timer got wrong.
        await act(async () => {
          vi.advanceTimersByTime(COPY_FLASH_MS - 400);
        });
        expect(copied()).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(400);
        });
        expect(copied()).toBeNull();
      } finally {
        restore();
        vi.useRealTimers();
      }
    });
  });

  /** One DataForSEO row per query, all landing in the same "near win"
   * priority band so only the decision record can change their order. */
  const dfsRow = (query: string, monthlySearches: number) => ({
    query,
    monthlySearches,
    organicPosition: 7,
    previousOrganicPosition: null,
    positionImprovement: null,
    keywordDifficulty: 24,
    estimatedVisits: 31,
    page: "/meal-plan",
    intent: "informational",
    aiOverview: "none" as const,
    aiCitationPosition: null,
    aioDevices: [],
  });
  const dfsTrends = (queries: ReturnType<typeof dfsRow>[]) => ({
    google: null,
    bing: null,
    dataforseo: {
      observedAt: "2026-07-28",
      queries,
      source: "dataforseo/ranked-keywords",
      caveat: "Estimated demand, not impressions.",
    },
  });
  /** What the register holds for one query — the payload's `handoffBeads`
   * slice, joined to a row by the normalized query alone. */
  const filedBead = (key: string, over: Partial<HandoffBead> = {}): HandoffBead => ({
    kind: "query",
    key,
    beadId: "mp-1w2",
    status: "open",
    closedAt: null,
    ...over,
  });

  function withClipboard(writeText: ReturnType<typeof vi.fn>) {
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return () =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: original,
      });
  }

  // Bead ro-5e8.3. The row's filing marker used to be `decisions.handed_off` —
  // a row the Tower wrote the instant the operator COPIED the Markdown, which is
  // a claim about intent and not about work. It now reads the register.
  describe("a query row shows its bead, not the operator's self-report", () => {
    const rowFor = (container: HTMLElement, text: string) =>
      [...container.querySelectorAll("[data-decision-kind]")].find((row) =>
        row.textContent?.includes(text),
      ) as HTMLElement | undefined;

    it("marks an open bead with its id and drops the row below unfiled work", () => {
      const { container } = render(
        <QueryVisibilityRankings
          trends={dfsTrends([
            dfsRow("Alpha Query", 2000),
            dfsRow("bravo query", 1000),
          ])}
          asset={asset}
          // The join key is the normalized query the rows are unified by,
          // never the display casing.
          handoffBeads={[filedBead("alpha query")]}
        />,
        { wrapper: MemoryRouter },
      );

      const marker = container.querySelector('[data-handoff-bead="open"]')!;
      expect(marker).toBeInTheDocument();
      expect(marker.textContent).toContain("mp-1w2");
      expect(marker.closest("[data-decision-kind]")?.textContent).toContain(
        "Alpha Query",
      );
      expect(rowFor(container, "Alpha Query")?.dataset.decisionFiled).toBe("open");
      // The stronger query is filed, so the one nobody has picked up leads.
      const rows = [...container.querySelectorAll("[data-decision-kind]")].map(
        (row) => row.textContent ?? "",
      );
      expect(rows[0]).toContain("bravo query");
    });

    it("records closure without claiming shipment or resolution", () => {
      const { container } = render(
        <QueryVisibilityRankings
          trends={dfsTrends([dfsRow("Alpha Query", 2000)])}
          asset={asset}
          handoffBeads={[
            filedBead("alpha query", {
              status: "closed",
              closedAt: "2026-07-29T09:00:00.000Z",
            }),
          ]}
        />,
        { wrapper: MemoryRouter },
      );

      const marker = container.querySelector('[data-handoff-bead="closed"]')!;
      expect(marker).toBeInTheDocument();
      expect(marker.textContent).toContain("mp-1w2");
      expect(marker.getAttribute("title")).toContain("not proof of shipment or outcome");
      expect(marker.className).not.toContain("text-ok");
      // A closed bead does not retire the query: the evidence and the next
      // step are still on the row, and the row is still on the page.
      expect(rowFor(container, "Alpha Query")).toBeTruthy();
      expect(rowFor(container, "Alpha Query")?.textContent).toContain(
        "Near win",
      );
      expect(rowFor(container, "Alpha Query")?.textContent).toContain(
        "Sharpen the title and opening answer on /meal-plan",
      );
    });

    it("leaves a copied-but-unfiled query with no filing marker at all", async () => {
      const restore = withClipboard(vi.fn().mockResolvedValue(undefined));
      try {
        const { container, getByRole } = render(
          <QueryVisibilityRankings
            trends={dfsTrends([dfsRow("Alpha Query", 2000)])}
            asset={asset}
            // The register was asked and holds nothing for this asset.
            handoffBeads={[]}
          />,
        );

        fireEvent.click(
          getByRole("button", { name: "Copy Markdown for Alpha Query" }),
        );
        await waitFor(() =>
          expect(
            getByRole("button", { name: "Copied for Alpha Query" }),
          ).toBeTruthy(),
        );

        // A copy nobody ran filed nothing, so the row claims nothing — no
        // marker, no diamond, no "handed off".
        expect(container.querySelector("[data-handoff-bead]")).toBeNull();
        expect(container.querySelector("[data-decision-filed]")).toBeNull();
        expect(container.textContent).not.toContain("Handed off");
      } finally {
        restore();
      }
    });

    it("renders nothing at all when the register could not be asked", () => {
      // `null` is a snapshot the poller never wrote this field into, an asset
      // that is not a spoke, or a `bd` that failed — never "nothing is filed".
      const { container } = render(
        <QueryVisibilityRankings
          trends={dfsTrends([dfsRow("Alpha Query", 2000)])}
          asset={asset}
          handoffBeads={null}
        />,
      );

      expect(container.querySelector("[data-handoff-bead]")).toBeNull();
      expect(container.querySelector("[data-decision-filed]")).toBeNull();
      expect(container.textContent).not.toContain("bead");
    });

    it("carries exactly one filing marker on a row, never two", () => {
      const { container } = render(
        <QueryVisibilityRankings
          trends={dfsTrends([dfsRow("Alpha Query", 2000)])}
          asset={asset}
          handoffBeads={[filedBead("alpha query")]}
        />,
        { wrapper: MemoryRouter },
      );

      const row = rowFor(container, "Alpha Query")!;
      expect(row.querySelectorAll("[data-handoff-bead]")).toHaveLength(1);
      // The self-report glyph is GONE, not merely outranked: two markers for
      // one question are two answers, and the operator would have to know
      // which of them was about the work.
      expect(row.querySelector("[data-decision-handed-off]")).toBeNull();
      expect(
        [...row.querySelectorAll('[role="img"]')].filter((glyph) =>
          /handed off/i.test(glyph.getAttribute("aria-label") ?? ""),
        ),
      ).toHaveLength(0);
    });

    it("never borrows a finding's bead for a query that shares its key", () => {
      const { container } = render(
        <QueryVisibilityRankings
          trends={dfsTrends([dfsRow("Alpha Query", 2000)])}
          asset={asset}
          handoffBeads={[
            filedBead("alpha query", { kind: "finding", beadId: "mp-9zz" }),
          ]}
        />,
      );

      expect(container.querySelector("[data-handoff-bead]")).toBeNull();
    });

    it("joins on the byte-exact key the handoff itself emits, commas and all", async () => {
      // End to end over the one string the chain turns on: the row normalizes
      // the query, the copied `bd create` carries it in METADATA (the `key:`
      // label is a comma-splitting slug), the agent's bead carries it back, and
      // the poller hands it to this component untouched. A single byte of drift
      // anywhere on that path silently empties the marker.
      const query = "Meal Plan, Weekly";
      const writeText = vi.fn().mockResolvedValue(undefined);
      const restore = withClipboard(writeText);
      try {
        const { getByRole } = render(
          <QueryVisibilityRankings
            trends={dfsTrends([dfsRow(query, 2000)])}
            asset={asset}
          />,
          { wrapper: MemoryRouter },
        );
        fireEvent.click(
          getByRole("button", { name: `Copy Markdown for ${query}` }),
        );
        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());

        const markdown = String(writeText.mock.calls[0]?.[0]);
        const metadata = JSON.parse(
          String(markdown.match(/--metadata '(\{.*?\})'/)?.[1]),
        );
        expect(metadata.noticeos_key).toBe("meal plan, weekly");
        expect(metadata.noticeos_kind).toBe("query");
        // The lossy label is beside it and is NOT what anything joins on.
        expect(markdown).toContain("-l 'key:meal-plan-weekly'");

        const { container } = render(
          <QueryVisibilityRankings
            trends={dfsTrends([dfsRow(query, 2000)])}
            asset={asset}
            handoffBeads={[filedBead(metadata.noticeos_key)]}
          />,
          { wrapper: MemoryRouter },
        );
        expect(
          rowFor(container, query)?.querySelector("[data-handoff-bead-id]")
            ?.textContent,
        ).toContain("mp-1w2");

        // The slug the label carries joins to nothing.
        const slugged = render(
          <QueryVisibilityRankings
            trends={dfsTrends([dfsRow(query, 2000)])}
            asset={asset}
            handoffBeads={[filedBead("meal-plan-weekly")]}
          />,
          { wrapper: MemoryRouter },
        );
        expect(
          slugged.container.querySelector("[data-handoff-bead]"),
        ).toBeNull();
      } finally {
        restore();
      }
    });
  });

  describe("tracked SERP panel rules", () => {
    /** A near win on position alone: the act-lane decision the AI-Overview gate
     * exists to intercept. Panel state is set per test.
     *
     * `(null, null)` is the UNTRACKED query — an empty device list, which is
     * unknown. A tracked term whose overview did not load is a device list with
     * a null reading in it, and `panelDevices()` below is how a test says that. */
    const panelRow = (
      aioPresent: boolean | null,
      aioCitesUs: boolean | null,
    ): DataForSeoQueryVisibilityRow =>
      panelDevices(
        aioPresent === null && aioCitesUs === null
          ? []
          : [{ device: "desktop", aioPresent, aioCitesUs }],
      );

    const panelDevices = (
      aioDevices: DataForSeoQueryVisibilityRow["aioDevices"],
    ): DataForSeoQueryVisibilityRow => ({
      query: "how many calories should i eat",
      monthlySearches: 74000,
      organicPosition: 6,
      previousOrganicPosition: null,
      positionImprovement: null,
      keywordDifficulty: 44,
      estimatedVisits: 210,
      page: "/calculator",
      intent: "informational",
      aiOverview: "none" as const,
      aiCitationPosition: null,
      aioDevices,
    });
    const panelTrends = (row: ReturnType<typeof panelRow>) => ({
      google: null,
      bing: null,
      dataforseo: {
        observedAt: "2026-07-28",
        queries: [row],
        source: "dataforseo/ranked-keywords",
        caveat: "Estimated demand, not impressions.",
      },
    });

    /** The rationale reaches the operator through the copied handoff, not the
     * row, so a rule's reasoning is asserted where it is actually read. */
    async function copiedMarkdown(trends: SearchQueryTrends) {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const restore = withClipboard(writeText);
      try {
        // Scoped to this render's own container: earlier renders in the same
        // test are still mounted in the document.
        const { container } = render(
          <QueryVisibilityRankings trends={trends} asset={asset} />,
        );
        fireEvent.click(
          container.querySelector(
            'button[aria-label^="Copy Markdown"]',
          ) as HTMLElement,
        );
        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        return String(writeText.mock.calls[0]?.[0]);
      } finally {
        restore();
      }
    }

    it("demotes a title-surgery recommendation walled by an AI Overview", async () => {
      const trends = panelTrends(panelRow(true, false));
      const { container } = render(
        <QueryVisibilityRankings trends={trends} asset={asset} />,
      );

      // Position 6 alone would read "Near win" in the act lane.
      expect(container.querySelector('[data-decision-kind="near-win"]')).toBeNull();
      const walled = container.querySelector(
        '[data-decision-kind="aio-walled"]',
      );
      expect(walled).toHaveAttribute("data-decision-tone", "investigate");
      expect(walled?.textContent).toContain("Investigate");
      expect(walled?.textContent).toContain("Walled by AI Overview");
      expect(walled?.textContent).toContain(
        "See who the AI Overview cites before editing the title",
      );

      const markdown = await copiedMarkdown(trends);
      expect(markdown).toContain("- **What to do:** Investigate");
      expect(markdown).toContain(
        "does not cite this site — the click is largely consumed inline",
      );
      // The positional reading it was demoted from survives as evidence.
      expect(markdown).toContain("- **Current Google organic position:** #6");
    });

    const slippingTrends = () => ({
      ...panelTrends({
        ...panelRow(true, true),
        previousOrganicPosition: 3,
        positionImprovement: -3,
      }),
      bing: {
        provider: "bing" as const,
        currentStart: "2026-06-12",
        currentEnd: "2026-07-24",
        previousStart: "2026-04-24",
        previousEnd: "2026-06-05",
        daysPerWindow: 7,
        movers: [
          {
            query: "how many calories should i eat",
            currentImpressions: 100,
            previousImpressions: 1000,
            impressionDelta: -900,
            impressionDeltaPercent: -90,
            currentPosition: 11,
            previousPosition: 8,
            positionImprovement: -3,
          },
        ],
        evidence: [],
        source: "bing-webmaster/queries",
        caveat: "Only queries present in both windows are ranked.",
      },
    });

    it("protects an AI-citation champion even while its position slips", async () => {
      const { container } = render(
        <QueryVisibilityRankings
          trends={slippingTrends()}
          asset={asset}
        />,
      );

      // A -90% decline would otherwise be the act-lane "Recover visibility".
      expect(container.querySelector('[data-decision-kind="recover"]')).toBeNull();
      const champion = container.querySelector(
        '[data-decision-kind="aio-champion"]',
      );
      expect(champion).toHaveAttribute("data-decision-tone", "positive");
      expect(champion?.textContent).toContain("Protect");
      expect(champion?.textContent).toContain("AI Overview cites us");
      // The slide is not discarded: it turns the protect call urgent.
      expect(champion?.textContent).toContain("Recheck the citation now; keep the quoted passage");

      const markdown = await copiedMarkdown(slippingTrends());
      expect(markdown).toContain("- **What to do:** Protect");
      expect(markdown).toContain("Recheck the citation now");
      // …and the decline itself travels as evidence.
      expect(markdown).toContain("- **Impression change:** -90%");
    });

    it("changes nothing for a query the panel does not cover", () => {
      const withPanel = render(
        <QueryVisibilityRankings
          trends={panelTrends(panelRow(null, null))}
          asset={asset}
        />,
      );
      expect(
        withPanel.container.querySelector('[data-decision-kind="near-win"]'),
      ).not.toBeNull();
      // Unknown is not "clear": no glyph is drawn at all.
      expect(
        withPanel.container.querySelector("[data-aio-state]"),
      ).toBeNull();

      // A panel that read the page and found no overview leaves the decision
      // alone too, but says so with the quiet checked-and-clear mark.
      const clear = render(
        <QueryVisibilityRankings
          trends={panelTrends(panelRow(false, false))}
          asset={asset}
        />,
      );
      expect(
        clear.container.querySelector('[data-decision-kind="near-win"]'),
      ).not.toBeNull();
      expect(
        clear.container.querySelector('[data-aio-state="absent"]'),
      ).not.toBeNull();
    });

    it("marks each known AI Overview state with its own quiet glyph", () => {
      const glyph = (row: ReturnType<typeof panelRow>) => {
        const { container } = render(
          <QueryVisibilityRankings
            trends={panelTrends(row)}
            asset={asset}
          />,
        );
        return container.querySelector("[data-aio-state]");
      };

      const cited = glyph(panelRow(true, true));
      expect(cited).toHaveAttribute("data-aio-state", "cited");
      expect(cited).toHaveAttribute(
        "aria-label",
        "AI Overview cites this site",
      );
      const uncited = glyph(panelRow(true, false));
      expect(uncited).toHaveAttribute("data-aio-state", "uncited");
      expect(uncited).toHaveAttribute(
        "aria-label",
        "AI Overview shown; this site is not cited",
      );
      const absent = glyph(panelRow(false, false));
      expect(absent).toHaveAttribute("data-aio-state", "absent");
      expect(absent).toHaveAttribute(
        "aria-label",
        "No AI Overview on the tracked result page",
      );
    });

    it("carries the panel evidence into the copied handoff", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const restore = withClipboard(writeText);
      try {
        const { container } = render(
          <QueryVisibilityRankings
            trends={panelTrends(panelRow(true, true))}
            asset={asset}
          />,
        );
        fireEvent.click(
          container.querySelector(
            'button[aria-label^="Copy Markdown"]',
          ) as HTMLElement,
        );
        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        const markdown = String(writeText.mock.calls[0]?.[0]);
        expect(markdown).toContain(
          "- **Tracked SERP panel:** AI Overview fires and cites this site",
        );
      } finally {
        restore();
      }
    });

    it("shows a query walled on the phone and clear on the desktop as both (ro-e46.2)", async () => {
      const trends = panelTrends(
        panelDevices([
          { device: "mobile", aioPresent: true, aioCitesUs: false },
          { device: "desktop", aioPresent: false, aioCitesUs: false },
        ]),
      );
      const { container } = render(
        <QueryVisibilityRankings trends={trends} asset={asset} />,
      );

      // Two marks in one cell, phone first — never two rows, and never one
      // folded mark, because the split IS the finding.
      const glyphs = [...container.querySelectorAll("[data-aio-state]")];
      expect(
        glyphs.map((el) => [
          el.getAttribute("data-aio-device"),
          el.getAttribute("data-aio-state"),
        ]),
      ).toEqual([
        ["mobile", "uncited"],
        ["desktop", "absent"],
      ]);
      expect(glyphs[0]).toHaveAttribute(
        "aria-label",
        "Phone: AI Overview shown; this site is not cited",
      );

      // The evidence line names both surfaces rather than picking one.
      expect(container.textContent).toContain(
        "Phone: shown, not cited · Desktop: none",
      );

      // The demotion still fires: an overview consuming the click on the phone
      // is not undone by a clear desktop page.
      expect(
        container.querySelector('[data-decision-kind="aio-walled"]'),
      ).not.toBeNull();

      // And the handoff carries both, so the split survives the copy.
      const markdown = await copiedMarkdown(trends);
      expect(markdown).toContain(
        "Phone: AI Overview fires and does not cite this site",
      );
      expect(markdown).toContain("Desktop: no AI Overview on the live result page");
    });

    it("draws no mark for a surface the panel could not answer for", () => {
      // The phone was pulled and its overview never loaded. Unknown draws
      // nothing (doc 17), so the desktop's mark is the only one — but it is
      // still labelled by surface, because the row was read on two.
      const { container } = render(
        <QueryVisibilityRankings
          trends={panelTrends(
            panelDevices([
              { device: "mobile", aioPresent: null, aioCitesUs: null },
              { device: "desktop", aioPresent: true, aioCitesUs: true },
            ]),
          )}
          asset={asset}
        />,
      );
      const glyphs = [...container.querySelectorAll("[data-aio-state]")];
      expect(glyphs).toHaveLength(1);
      expect(glyphs[0]).toHaveAttribute("data-aio-device", "desktop");
      // The unknown surface is SPELLED on the evidence line rather than
      // omitted: a missing surface would read as the two agreeing.
      expect(container.textContent).toContain(
        "Phone: not checked · Desktop: cites us",
      );
    });

    it("says nothing about the panel in a handoff for an untracked query", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const restore = withClipboard(writeText);
      try {
        const { container } = render(
          <QueryVisibilityRankings
            trends={panelTrends(panelRow(null, null))}
            asset={asset}
          />,
        );
        fireEvent.click(
          container.querySelector(
            'button[aria-label^="Copy Markdown"]',
          ) as HTMLElement,
        );
        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        // Silence, not a claim that no overview fires.
        expect(String(writeText.mock.calls[0]?.[0])).not.toContain(
          "Tracked SERP panel",
        );
      } finally {
        restore();
      }
    });
  });

  it("folds a filed query away in favour of one nobody has picked up", () => {
    const names = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
      "juliet",
    ];
    const trends = dfsTrends(
      names.map((name, index) => dfsRow(name, 1000 - index * 50)),
    );
    const rowFor = (container: HTMLElement, name: string) =>
      [...container.querySelectorAll("[data-decision-kind]")].find((row) =>
        row.textContent?.includes(name),
      );

    const untouched = render(
      <QueryVisibilityRankings trends={trends} asset={asset} />,
      { wrapper: MemoryRouter },
    );
    expect(untouched.container.textContent).toContain("Review 2 more queries");
    // The strongest query leads the visible set while nobody has acted on it.
    expect(rowFor(untouched.container, "alpha")?.closest("details")).toBeNull();

    const reviewed = render(
      <QueryVisibilityRankings
        trends={trends}
        asset={asset}
        handoffBeads={[filedBead("alpha")]}
      />,
      { wrapper: MemoryRouter },
    );
    // Once a bead exists it is work somebody has: it falls behind the fold and
    // a query nobody has picked up takes the visible slot.
    expect(rowFor(reviewed.container, "alpha")?.closest("details")).not.toBeNull();
    expect(rowFor(reviewed.container, "india")?.closest("details")).toBeNull();
    expect(reviewed.container.textContent).toContain("Review 2 more queries");
  });
});

describe("SeverityDot severity → token mapping", () => {
  it("maps error to the error token", () => {
    const { getByRole } = render(<SeverityDot severity="error" />);
    expect(getByRole("img", { name: "Error" }).className).toContain("text-error");
  });

  /**
   * DECODABLE WITHOUT A POINTER (bead ro-ujb9.14): error, warning and healthy
   * are SHAPES — a circle, a triangle, a check — so the state reads without the
   * colour and without the hover title; the count stays the accessible name.
   */
  it("draws error, warning and healthy as three different shapes, the count as its name", () => {
    const { container, getByRole } = render(<>
      <SeverityDot severity="error" title="2 open error alerts" />
      <SeverityDot severity="warn" title="1 open warning alert" />
      <SeverityDot severity={null} healthy />
    </>);
    const marks = [...container.querySelectorAll("[data-severity-mark]")];
    expect(marks.map((mark) => mark.getAttribute("data-severity-mark"))).toEqual(["error", "warn", "healthy"]);
    const shapes = marks.map((mark) => mark.querySelector("svg")!.getAttribute("class"));
    expect(new Set(shapes).size).toBe(3);
    expect(shapes[0]).toContain("lucide-circle-alert");
    expect(shapes[1]).toContain("lucide-triangle-alert");
    expect(shapes[2]).toContain("lucide-circle-check");
    expect(getByRole("img", { name: "2 open error alerts" })).toBe(marks[0]);
  });

  it("is neutral when there are no open flags", () => {
    const { getByRole } = render(<SeverityDot severity={null} />);
    expect(getByRole("img", { name: "No open alerts" }).className).toContain(
      "bg-muted-foreground/40",
    );
  });

  it("is green when current health evidence has no open warning or error", () => {
    const { getByRole } = render(<SeverityDot severity="info" healthy />);
    const dot = getByRole("img", { name: "Healthy — no open warnings or errors" });
    expect(dot.className).toContain("text-healthy");
  });

  it("keeps an active warning above the healthy state", () => {
    const { getByRole } = render(<SeverityDot severity="warn" healthy />);
    expect(getByRole("img", { name: "Warn" }).className).toContain("text-warn");
  });

  it("uses the reserved emerald for milestone kind", () => {
    const { getByRole } = render(<SeverityDot severity="info" milestone />);
    expect(getByRole("img", { name: "Milestone" }).className).toContain("bg-milestone");
  });
});

describe("ScheduledLanesPanel — silence and failure are visible states", () => {
  it("puts a failed latest firing first with its human label and age", () => {
    const { container } = render(
      <ScheduledLanesPanel
        lanes={[
          { job: "beads-snapshot", outcome: "ran", startedAt: hoursAgo(1) },
          { job: "backup", outcome: "failed", startedAt: hoursAgo(2) },
        ]}
        nowMs={NOW}
      />,
    );
    const rows = container.querySelectorAll("[data-scheduled-lane]");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-scheduled-lane", "backup");
    expect(rows[0]).toHaveAttribute("data-outcome", "failed");
    expect(rows[0]?.textContent).toContain("Backups");
    expect(rows[0]?.textContent).toContain("failed");
    expect(rows[0]?.textContent).toContain("2h ago");
  });

  it("calls an empty record unknown instead of healthy", () => {
    const { container } = render(
      <ScheduledLanesPanel lanes={[]} nowMs={NOW} />,
    );
    expect(container.textContent).toContain("Scheduled runs not yet recorded");
    // Unknown is the state, drawn — the warn question mark, never a check —
    // not a sentence saying so (bead ro-ujb9.96.6.2).
    const empty = container.querySelector("[data-scheduled-empty]");
    expect(empty).toHaveAttribute("data-lane-posture", "unknown");
    expect(empty?.querySelector("svg.text-warn")).not.toBeNull();
    expect(container.textContent).not.toContain("This is unknown, not healthy");
    expect(container.querySelector("[data-scheduled-lane]")).toBeNull();
  });

  it("puts the oldest successful firing first and marks global silence", () => {
    const { container } = render(
      <ScheduledLanesPanel
        lanes={[
          { job: "beads-snapshot", outcome: "ran", startedAt: hoursAgo(27) },
          { job: "backup", outcome: "ran", startedAt: hoursAgo(28) },
        ]}
        nowMs={NOW}
      />,
    );
    const rows = container.querySelectorAll("[data-scheduled-lane]");
    expect(rows[0]).toHaveAttribute("data-scheduled-lane", "backup");
    expect(rows[0]).toHaveAttribute("data-lane-posture", "silent");
    expect(rows[1]).toHaveAttribute("data-lane-posture", "silent");
  });
});

const insightFixture: ExecutiveInsight = {
  key: "search-opportunity",
  kind: "recommendation",
  title: "Expand pages already earning search demand",
  summary: "Several pages earn impressions but capture few clicks.",
  whyItMatters: "Improving these pages can grow qualified discovery.",
  primary: { value: "1,003", label: "Captured impressions" },
  confidence: "high",
  windowStart: "2026-05-01",
  windowEnd: "2026-07-29",
  evidence: [
    {
      label: "High-impression pages",
      value: "12",
      detail: "Pages with at least 50 impressions and below-median CTR.",
    },
  ],
  sources: ["gsc/search-analytics", "bing-webmaster/query-stats"],
  caveat: "Search demand does not prove that every page merits expansion.",
};

describe("ExecutiveInsightRow ranked interaction and Markdown handoff", () => {
  it("serializes the complete decision and evidence contract", () => {
    const markdown = executiveInsightMarkdown(
      insightFixture,
      "meals.example",
    );

    expect(markdown).toContain(
      "# Recommendation: Expand pages already earning search demand",
    );
    expect(markdown).toContain("- **Site:** `meals.example`");
    expect(markdown).toContain("## Meaning / next move");
    expect(markdown).toContain("## Why it matters");
    expect(markdown).toContain("- **Captured impressions:** 1,003");
    expect(markdown).toContain("- **High-impression pages:** 12");
    expect(markdown).toContain(
      "  - Pages with at least 50 impressions and below-median CTR.",
    );
    expect(markdown).toContain(
      "- **Evidence window:** 2026-05-01 to 2026-07-29",
    );
    expect(markdown).toContain(
      "- **Sources:** `gsc/search-analytics`, `bing-webmaster/query-stats`",
    );
    expect(markdown).toContain(
      "Search demand does not prove that every page merits expansion.",
    );
  });

  // Same wall-clock race as the query row's copy case, same answer (bead
  // `ro-ogc7`): the "Copied" confirmation clears itself in real time, so a test
  // that asserts it after an `await` is only ever probably right.
  it("copies the exact Markdown and exposes completion without hiding context", async () => {
    vi.useFakeTimers();
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const { getByRole, getByText } = render(
        <ExecutiveInsightRow
          insight={insightFixture}
          asset="meals.example"
          rank={1}
        />,
      );
      fireEvent.click(getByText("Expand pages already earning search demand").closest("summary")!);
      fireEvent.click(getByRole("button", { name: "Copy Markdown" }));

      await act(async () => {});
      expect(writeText).toHaveBeenCalledWith(
        executiveInsightMarkdown(insightFixture, "meals.example", recommendationValidity(findingBasis(insightFixture), null, Date.now())),
      );
      expect(getByRole("button", { name: "Copied" })).toBeTruthy();
      expect(
        getByText("Evidence & limits · 1 fact · 2 sources"),
      ).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(COPY_FLASH_MS);
      });
      expect(getByRole("button", { name: "Copy Markdown" })).toBeTruthy();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
      vi.useRealTimers();
    }
  });

  // The operator's half of the same handoff (bead `ro-l1ed.4`): the row offers
  // the bead the copied command describes, and offers nothing where that
  // command would also be dropped.
  it("offers File task beside Copy Markdown, and none without an asset", () => {
    const withAsset = render(
      <ExecutiveInsightRow insight={insightFixture} asset="meals.example" rank={1} />,
    ).container;
    fireEvent.click(withAsset.querySelector("summary")!);
    expect(
      within(withAsset).getByRole("button", {
        name: "File task for Expand pages already earning search demand",
      }),
    ).toBeInTheDocument();

    // No asset means no repo to file in, so the row offers nothing rather than
    // a button that would file against nothing — the same rule that drops the
    // File this task section from the copied Markdown.
    const withoutAsset = render(
      <ExecutiveInsightRow insight={insightFixture} rank={1} />,
    ).container;
    fireEvent.click(withoutAsset.querySelector("summary")!);
    expect(
      within(withoutAsset).queryByRole("button", { name: /^File task/ }),
    ).toBeNull();
  });

  // Bead ro-ujb9.96.7.11 (PagerDuty's Create Jira issue): File task sits on
  // the closed row, and pressing it opens the composer without opening or
  // closing the row around it. A filed finding shows its task instead.
  it("offers File task on the closed row until the finding is filed", () => {
    // A build with the task lane, so the button is live.
    const client = new QueryClient();
    client.setQueryData(["tasks-live"], { live: true, reason: null });
    const { container } = rtlRender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ExecutiveInsightRow insight={insightFixture} asset="meals.example" rank={1} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(within(container).getByRole("button", { name: "File task for Expand pages already earning search demand" }));
    expect(details.open).toBe(false);
    const composer = within(screen.getByRole("dialog", { name: "File a task" }));
    expect((composer.getByLabelText("Title") as HTMLInputElement).value).toBe("Expand pages already earning search demand");
    expect((composer.getByLabelText("Description") as HTMLTextAreaElement).value).toContain("Captured impressions: 1,003");
    fireEvent.click(composer.getByRole("button", { name: "Cancel" }));

    const filed = render(
      <MemoryRouter>
        <ExecutiveInsightRow
          insight={insightFixture}
          asset="meals.example"
          rank={1}
          bead={{ beadId: "mp-9k1", status: "open", kind: "finding", key: "search-opportunity", closedAt: null }}
        />
      </MemoryRouter>,
    ).container;
    expect(within(filed.querySelector("summary")!).queryByRole("button", { name: /^File task/ })).toBeNull();
  });

  it("exposes compact mark and dismiss controls without conflating them with alert resolution", () => {
    const onToggleMarked = vi.fn();
    const onDismiss = vi.fn();
    const { getByRole } = render(
      <ExecutiveInsightRow
        insight={insightFixture}
        rank={2}
        onToggleMarked={onToggleMarked}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(getByRole("article").querySelector("summary")!);
    fireEvent.click(getByRole("button", { name: "Mark" }));
    fireEvent.click(getByRole("button", { name: "Dismiss" }));

    expect(onToggleMarked).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(getByRole("article").getAttribute("data-insight-kind")).toBe(
      "recommendation",
    );
    expect(getByRole("article")).toHaveAttribute(
      "data-insight-tone",
      "recommendation",
    );
    expect(getByRole("article").className).toContain("border-l-warn");
    expect(getByRole("article").textContent).toContain("Why it matters:");
  });
});

/** The handoff files a bead in the asset's own repo, and the labels it
 * carries are what later joins the bead to the finding it came from. The
 * command is generated for an agent to run, so the query text is inside a
 * shell string: quoting is a correctness asset, not a style one. */
describe("bead-native task handoff", () => {
  const asset = {
    id: "meals.example",
    displayName: "Meal Planner",
    domain: "meals.example",
  };
  const bingTrend: NonNullable<SearchQueryTrends["bing"]> = {
    provider: "bing",
    currentStart: "2026-06-12",
    currentEnd: "2026-07-24",
    previousStart: "2026-05-01",
    previousEnd: "2026-06-11",
    daysPerWindow: 6,
    source: "bing-webmaster/query-stats",
    caveat: "Only queries present in both windows are ranked.",
    movers: [],
    evidence: [],
  };
  const mover = (query: string) => ({
    query,
    currentImpressions: 164,
    previousImpressions: 1640,
    impressionDelta: -1476,
    impressionDeltaPercent: -90,
    currentPosition: 10,
    previousPosition: 8.8,
    positionImprovement: -1.2,
  });
  const decisionMarkdown = (
    query: string,
    overrides: { key?: string; asset?: string } = {},
  ) =>
    queryDecisionMarkdown({
      row: {
        query,
        key: overrides.key ?? query.trim().toLocaleLowerCase("en-US"),
        google: null,
        bing: mover(query),
        dataforseo: null,
      },
      assessment: {
        lane: "act",
        kind: "recover",
        label: "Recover visibility",
        action: "Confirm the page still exists and is indexed.",
      },
      trends: { google: null, bing: bingTrend, dataforseo: null },
      asset:
        overrides.asset === undefined
          ? asset
          : { ...asset, id: overrides.asset },
    });
  /** Reverse of the generator's POSIX single-quoting, so a test can read back
   * what the shell would actually hand `bd`. */
  const unquote = (token: string) =>
    token.slice(1, -1).replaceAll("'\\''", "'");
  const metadataOf = (markdown: string) =>
    JSON.parse(unquote(/^ {2}--metadata (.+) \\$/m.exec(markdown)?.[1] ?? ""));

  it("files a query decision with the keys that make the chain joinable", () => {
    const markdown = decisionMarkdown("jarra del buen beber");

    expect(markdown).toContain("## File this task");
    expect(markdown).toContain("in the `meals.example` asset repo");
    expect(markdown).toContain("**File task** button");
    expect(markdown).toContain("bd create 'Act on “jarra del buen beber”'");
    expect(markdown).toContain("  -t task");
    expect(markdown).toContain("  -p 1");
    expect(markdown).toContain("  -l 'noticeos-handoff'");
    expect(markdown).toContain("  -l 'asset:meals.example'");
    expect(markdown).toContain("  -l 'rule:recover'");
    expect(markdown).toContain("  -l 'key:jarra-del-buen-beber'");
    expect(markdown).toContain(
      `--metadata '${JSON.stringify({
        noticeos_source: "noticeos-handoff",
        noticeos_asset: "meals.example",
        noticeos_kind: "query",
        noticeos_rule: "recover",
        noticeos_key: "jarra del buen beber",
      })}'`,
    );
    expect(markdown).toContain(
      "-d 'From the NoticeOS saved query decision for meals.example: Recover visibility. Original suggested step: Confirm the page still exists and is indexed.",
    );
    expect(markdown).toContain("**not proof of shipment or outcome**");
    expect(markdown.split("-d '")[1]).toContain("Recheck the latest reports, linked work and the site before acting.");
    expect(markdown).toContain("Nothing files, closes, or measures it on your behalf");
  });

  // The button beside the copy (bead `ro-l1ed.4`). What it files is the same
  // `queryTaskHandoff` the command above is rendered from, which
  // `test/task-composer.test.tsx` pins field by field; here the row only has to
  // offer it, named for the query so eight rows do not read as eight buttons.
  it("offers File task on every query row", () => {
    const { getAllByRole } = render(
      <QueryVisibilityRankings
        trends={{
          google: null,
          bing: { ...bingTrend, movers: [mover("jarra del buen beber"), mover("chia pudding")] },
          dataforseo: null,
        }}
        asset={asset}
      />,
    );
    expect(getAllByRole("button", { name: /^File task for / })).toHaveLength(2);
    expect(
      getAllByRole("button", { name: "File task for chia pudding" }),
    ).toHaveLength(1);
  });

  it("carries the lane's own imperative and priority", () => {
    const lanes = [
      { lane: "act", title: "Act on", priority: 1 },
      { lane: "protect", title: "Protect", priority: 1 },
      { lane: "investigate", title: "Investigate", priority: 2 },
      { lane: "wait", title: "Hold", priority: 3 },
    ] as const;
    for (const { lane, title, priority } of lanes) {
      const markdown = queryDecisionMarkdown({
        row: {
          query: "chia pudding",
          key: "chia pudding",
          google: null,
          bing: mover("chia pudding"),
          dataforseo: null,
        },
        assessment: {
          lane,
          kind: "recover",
          label: "Recover visibility",
          action: "…",
        },
        trends: { google: null, bing: bingTrend, dataforseo: null },
        asset,
      });
      expect(markdown).toContain(`bd create '${title} “chia pudding”'`);
      expect(markdown).toContain(`  -p ${priority}`);
    }
  });

  it("neutralizes shell metacharacters in the query it interpolates", () => {
    const hostile = 'best "protein" powder, `whoami` $(id); rm -rf ~ — cheap\'s';
    const markdown = decisionMarkdown(hostile);
    const command = markdown.slice(markdown.indexOf("bd create"));

    // Everything data-derived is POSIX single-quoted, where a backtick,
    // $(…), and a double quote are all inert. The only way out of a
    // single-quoted string is a quote, and each one is escaped as '\''.
    expect(command).toContain(
      `bd create 'Act on “best "protein" powder, \`whoami\` $(id); rm -rf ~ — cheap'\\''s”'`,
    );
    // The comma would have split one label into two; the slug has none, and
    // the verbatim key rides in metadata, which bd matches exactly.
    expect(markdown).toContain(
      "  -l 'key:best-protein-powder-whoami-id-rm-rf-cheap-s'",
    );
    // What the shell hands bd is the key byte for byte — nothing expanded,
    // nothing dropped. This is the value the work board joins on.
    expect(metadataOf(markdown).noticeos_key).toBe(hostile);
    // Every single-quote run in the command is balanced: an odd count would
    // mean the shell string never closed.
    expect((command.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it("flattens a query that tries to span lines or reorder what it renders", () => {
    // A newline would put the rest of the query on a line the command does not
    // own; a bidi override would let the rendered command read differently
    // from the one that runs. Both are collapsed to a space.
    const markdown = decisionMarkdown("chia\n  pudding‮rm -rf ~");

    expect(markdown).toContain("bd create 'Act on “chia pudding rm -rf ~”'");
    expect(metadataOf(markdown).noticeos_key).toBe("chia pudding rm -rf ~");
  });

  it("opens a fence the query's own backticks cannot escape", () => {
    const markdown = decisionMarkdown("how to write ``` in markdown");

    expect(markdown).toContain("````sh");
    expect(markdown).toContain("\n````\n");
  });

  it("degrades to the evidence handoff when the row carries no key", () => {
    const markdown = decisionMarkdown("   ", { key: "   " });

    expect(markdown).not.toContain("## File this task");
    expect(markdown).not.toContain("bd create");
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("- **Impression change:** -90% (-1,476)");
  });

  it("refuses to name a repo for something that is not an asset id", () => {
    expect(decisionMarkdown("chia pudding", { asset: "" })).not.toContain(
      "## File this task",
    );
    expect(
      decisionMarkdown("chia pudding", { asset: "not an id; rm -rf ~" }),
    ).not.toContain("bd create");
  });

  it("files a finding under its card key, which is also its rule id", () => {
    const markdown = executiveInsightMarkdown(insightFixture, "meals.example");

    expect(markdown).toContain("## File this task");
    expect(markdown).toContain(
      "bd create 'Expand pages already earning search demand'",
    );
    expect(markdown).toContain("  -p 2");
    expect(markdown).toContain("  -l 'noticeos-handoff'");
    expect(markdown).toContain("  -l 'asset:meals.example'");
    expect(markdown).toContain("  -l 'rule:search-opportunity'");
    expect(markdown).toContain("  -l 'key:search-opportunity'");
    expect(markdown).toContain(
      `--metadata '${JSON.stringify({
        noticeos_source: "noticeos-handoff",
        noticeos_asset: "meals.example",
        noticeos_kind: "finding",
        noticeos_rule: "search-opportunity",
        noticeos_key: "search-opportunity",
      })}'`,
    );
    // The task body is the finding's FIELDS, never its prose (bead
    // ro-ujb9.96.7.11): what it measured, then its window and sources.
    expect(markdown).toContain(
      "-d 'Recommendation on meals.example. Captured impressions: 1,003. High-impression pages: 12. Window: 2026-05-01 to 2026-07-29. Sources: gsc/search-analytics, bing-webmaster/query-stats. Original analysis confidence: high.",
    );
    expect(markdown.split("## File this task")[1]).not.toContain("Several pages earn impressions");
  });

  it("carries the finding's page as an evidence link, kept whole beside the clipped summary", () => {
    const prefill = taskHandoffPrefill(
      findingTaskHandoff(insightFixture, "meals.example", undefined, "http://tower.local:5173/assets/meals.example"),
    )!;
    expect(prefill.title).toBe("Expand pages already earning search demand");
    expect(prefill.description).toContain(
      "High-impression pages: 12. Evidence: http://tower.local:5173/assets/meals.example Window: 2026-05-01",
    );
    // Anything but an http(s) link is dropped rather than carried.
    expect(
      taskHandoffPrefill(findingTaskHandoff(insightFixture, "meals.example", undefined, "javascript:alert(1)"))!.description,
    ).not.toContain("Evidence:");
  });

  it("ranks a warning above the context it sits next to", () => {
    expect(
      executiveInsightMarkdown(
        { ...insightFixture, kind: "warning" },
        "meals.example",
      ),
    ).toContain("  -p 1");
    expect(
      executiveInsightMarkdown(
        { ...insightFixture, kind: "insight" },
        "meals.example",
      ),
    ).toContain("  -p 3");
  });

  it("omits the section for a vintage finding or an unattributed one", () => {
    // A snapshot predating ExecutiveInsight.key: still a complete handoff,
    // just nothing to file it under.
    expect(
      executiveInsightMarkdown({ ...insightFixture, key: "" }, "meals.example"),
    ).not.toContain("## File this task");
    // The kitchen sink renders findings with no asset at all.
    expect(executiveInsightMarkdown(insightFixture)).not.toContain("bd create");
    expect(executiveInsightMarkdown(insightFixture)).toContain("## Limitation");
  });
});

describe("ExecutiveFindingsList decisions live in the OS", () => {
  const second: ExecutiveInsight = {
    ...insightFixture,
    key: "traffic-warning",
    kind: "warning",
    title: "Organic clicks fell against a stable baseline",
  };
  const snapshot: ExecutiveSnapshot = {
    schemaVersion: 1,
    asset: "meals.example",
    generatedAt: "2026-07-29T06:00:00.000Z",
    windowStart: "2026-05-01",
    windowEnd: "2026-07-29",
    sourceArchiveCount: 12,
    items: [insightFixture, second],
    suppressedItems: [],
    searchQueries: null,
    searchPages: null,
    productUse: null,
    searchIntelligence: null,
    serpPanel: null,
    methodology: ["Derived from archived GA4/GSC reports."],
  };

  it("starts as one focused decision plus a compact, fully identified queue", async () => {
    const { container } = render(
      <ExecutiveFindingsList
        snapshot={snapshot}
        handoffBeads={[
          {
            kind: "finding",
            key: "search-opportunity",
            beadId: "mp-ux1",
            status: "open",
            closedAt: null,
          },
        ]}
        onWatch={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );

    const rows = [...container.querySelectorAll("article")];
    const disclosures = rows.map(
      (row) => row.querySelector(":scope > details") as HTMLDetailsElement,
    );
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]!.open).toBe(true);
    expect(disclosures[1]!.open).toBe(false);
    expect(disclosures[0]!.getAttribute("name")).toBe(
      "current-findings-meals.example",
    );
    expect(disclosures[1]!.getAttribute("name")).toBe(
      "current-findings-meals.example",
    );

    // Warning sorts first, and each kind is ONE group whose heading names it
    // and counts it (bead `ro-ujb9.96.6.8`); the rank runs on across groups.
    const groups = [...container.querySelectorAll<HTMLElement>("[data-finding-group]")];
    expect(groups.map((group) => group.dataset.findingGroup)).toEqual(["warning", "recommendation"]);
    expect(groups[1]!.querySelector("h3")?.textContent).toBe("Recommendation1");
    expect(groups[1]!.contains(rows[1]!)).toBe(true);
    // Even the CLOSED face keeps every material scan fact: order, title,
    // magnitude, confidence, and bead. The kind is the heading's, not repeated.
    const closedSummary = disclosures[1]!.querySelector("summary")!;
    expect(closedSummary.tagName).toBe("SUMMARY");
    expect(closedSummary.textContent).not.toContain("Recommendation");
    expect(closedSummary.textContent).toContain("Priority 2");
    expect(closedSummary.textContent).toContain(
      "Expand pages already earning search demand",
    );
    expect(closedSummary.textContent).toContain("1,003");
    expect(closedSummary.textContent).toContain("high confidence");
    expect(closedSummary.textContent).toContain("mp-ux1");

    // The native summary is the keyboard disclosure control. Opening it
    // reveals the unchanged next move, rationale, handoff, and evidence.
    fireEvent.click(closedSummary);
    await waitFor(() => expect(disclosures[1]!.open).toBe(true));
    expect(rows[1]!.textContent).toContain(
      "Several pages earn impressions but capture few clicks.",
    );
    expect(rows[1]!.textContent).toContain(
      "Improving these pages can grow qualified discovery.",
    );
    expect(rows[1]!.textContent).toContain("Copy Markdown");
    expect(rows[1]!.textContent).toContain("Watch outcome");
    expect(rows[1]!.textContent).toContain(
      "Evidence & limits · 1 fact · 2 sources",
    );
  });

  // `ro-kukv.3` asked that the operator KNOW Mark and Dismiss are safe to
  // press; `ro-ujb9.96.6.8` answers it with the interaction instead of a
  // sentence: a dismissal offers Undo, and no reassurance prose remains.
  it("answers a dismissal with Undo instead of a reversibility sentence", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const { container, getAllByRole } = render(
      <>
        <AppToaster />
        <ExecutiveFindingsList snapshot={snapshot} onDecide={onDecide} />
      </>,
    );
    expect(container.textContent).not.toContain("reversible");
    expect(container.textContent).not.toContain("does not resolve an alert");

    fireEvent.click(getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(onDecide).toHaveBeenLastCalledWith("traffic-warning", "dismissed");
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(onDecide).toHaveBeenLastCalledWith("traffic-warning", null);
    await waitFor(() =>
      expect(container.querySelectorAll("[data-insight-dismissed]")).toHaveLength(0),
    );
    expect(getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
  });

  it("writes mark, dismiss, and restore through the decisions API", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const { getAllByRole, getByRole, container } = render(
      <ExecutiveFindingsList snapshot={snapshot} onDecide={onDecide} />,
    );

    fireEvent.click(getAllByRole("button", { name: "Mark" })[0]!);
    expect(onDecide).toHaveBeenLastCalledWith("traffic-warning", "marked");
    // The mark is applied optimistically: the finding pins to the top.
    await waitFor(() =>
      expect(
        container.querySelector("[data-insight-marked]"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(onDecide).toHaveBeenLastCalledWith("traffic-warning", "dismissed");

    fireEvent.click(await waitFor(() => getByRole("button", { name: /Review 1 dismissed/ })));
    fireEvent.click(getByRole("button", { name: "Restore" }));
    expect(onDecide).toHaveBeenLastCalledWith("traffic-warning", null);
  });

  it("renders the stored decisions", () => {
    const { container, getByRole } = render(
      <ExecutiveFindingsList
        snapshot={snapshot}
        recordedDecisions={[
          {
            kind: "finding",
            key: "traffic-warning",
            status: "dismissed",
            decidedAt: "2026-07-28T06:00:00.000Z",
            updatedAt: "2026-07-28T06:00:00.000Z",
          },
        ]}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(getByRole("button", { name: /Review 1 dismissed/ })).toBeTruthy();
    expect(container.querySelectorAll("[data-insight-kind]")).toHaveLength(1);
  });

  it("rolls a dismissal back when the write fails", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("offline"));
    const { getAllByRole, queryByRole } = render(
      <ExecutiveFindingsList snapshot={snapshot} onDecide={onDecide} />,
    );

    fireEvent.click(getAllByRole("button", { name: "Dismiss" })[0]!);
    await waitFor(() =>
      expect(queryByRole("button", { name: /Review 1 dismissed/ })).toBeNull(),
    );
    expect(getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
  });

  it("lifts this browser's old preferences into the OS exactly once", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    window.localStorage.setItem(
      "noticeos:property-findings:meals.example",
      JSON.stringify({
        marked: ["search-opportunity"],
        dismissed: ["traffic-warning"],
      }),
    );

    render(<ExecutiveFindingsList snapshot={snapshot} onDecide={onDecide} />);

    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(2));
    expect(onDecide).toHaveBeenCalledWith("search-opportunity", "marked");
    expect(onDecide).toHaveBeenCalledWith("traffic-warning", "dismissed");
    await waitFor(() =>
      expect(
        window.localStorage.getItem("noticeos:property-findings:meals.example"),
      ).toBeNull(),
    );
  });

  it("never re-lifts old preferences over decisions the OS already holds", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    window.localStorage.setItem(
      "noticeos:property-findings:meals.example",
      JSON.stringify({ marked: ["search-opportunity"], dismissed: [] }),
    );

    render(
      <ExecutiveFindingsList
        snapshot={snapshot}
        recordedDecisions={[
          {
            kind: "finding",
            key: "traffic-warning",
            status: "dismissed",
            decidedAt: "2026-07-28T06:00:00.000Z",
            updatedAt: "2026-07-28T06:00:00.000Z",
          },
        ]}
        onDecide={onDecide}
      />,
    );

    await waitFor(() => expect(onDecide).not.toHaveBeenCalled());
  });

  // Bead ro-248. The register knew and the finding could not see it: a finding
  // whose work had already been filed still presented as untouched. The join is
  // the handoff's own `noticeos_key`, carried in the bead's metadata and
  // photographed into the beads snapshot once a minute.
  describe("a finding shows the bead somebody filed from it", () => {
    const filed = (over: Partial<HandoffBead> = {}): HandoffBead => ({
      kind: "finding",
      key: "traffic-warning",
      beadId: "mp-1w2",
      status: "open",
      closedAt: null,
      ...over,
    });

    it("marks an open bead with its id, quietly enough not to rival the severity", () => {
      const { container } = render(
        <ExecutiveFindingsList snapshot={snapshot} handoffBeads={[filed()]} />,
        { wrapper: MemoryRouter },
      );

      const marker = container.querySelector('[data-handoff-bead="open"]')!;
      expect(marker).toBeInTheDocument();
      // The visible text is the actionable string: the commit quotes it, the
      // watch window is keyed to it — and since `ro-l1ed.3` it is a LINK to the
      // task page, so the id an operator used to paste into `bd show` in a
      // terminal opens the bead, its conversation and where it came from.
      expect(marker.textContent).toContain("mp-1w2");
      expect(marker.tagName).toBe("A");
      expect(marker).toHaveAttribute("href", "/tasks/mp-1w2");
      // Muted, not toned. A filed warning is still a warning, and the row's own
      // rail is the loud thing on it.
      expect(marker.className).toContain("bg-muted");
      expect(marker.className).not.toMatch(/text-(error|warn|info|ok)/);
      // It lands on the finding it was filed FROM, and on no other.
      const rows = [...container.querySelectorAll("article")];
      expect(rows.find((r) => r.getAttribute("data-insight-filed") === "open")!.textContent)
        .toContain("Organic clicks fell against a stable baseline");
      expect(rows.filter((r) => r.hasAttribute("data-insight-filed"))).toHaveLength(1);
    });

    it("records closure without claiming shipment or resolution", () => {
      const { container } = render(
        <ExecutiveFindingsList
          snapshot={snapshot}
          handoffBeads={[filed({ status: "closed", closedAt: "2026-07-28T09:00:00.000Z" })]}
        />,
        { wrapper: MemoryRouter },
      );

      const marker = container.querySelector('[data-handoff-bead="closed"]')!;
      expect(marker).toBeInTheDocument();
      expect(marker.textContent).toContain("mp-1w2");
      expect(marker.getAttribute("title")).toContain("not proof of shipment or outcome");
      // Only a watch-window verdict retires a finding, so a closed bead may not
      // dismiss it, hide it, or dress itself as a success.
      expect(marker.className).not.toContain("text-ok");
      expect(container.querySelectorAll("article")).toHaveLength(2);
      expect(container.querySelector("[data-insight-dismissed]")).toBeNull();
    });

    it("leaves an unfiled finding with no trace of the register", () => {
      const { container } = render(
        <ExecutiveFindingsList
          snapshot={snapshot}
          handoffBeads={[filed({ key: "search-opportunity" })]}
        />,
        { wrapper: MemoryRouter },
      );

      const rows = [...container.querySelectorAll("article")];
      const untouched = rows.find(
        (r) => r.textContent?.includes("Organic clicks fell against a stable baseline"),
      )!;
      // No pill, no dash, no "not filed": most findings have no bead, and a
      // marker on every one of them would be noise to say nothing.
      expect(untouched.querySelector("[data-handoff-bead]")).toBeNull();
      expect(untouched.hasAttribute("data-insight-filed")).toBe(false);
    });

    it("renders nothing at all when the register could not be asked", () => {
      // `null` is a snapshot the poller never wrote this field into, an asset
      // that is not a spoke, or a `bd` that failed — never "nothing is filed".
      const { container } = render(
        <ExecutiveFindingsList snapshot={snapshot} handoffBeads={null} />,
      );

      expect(container.querySelector("[data-handoff-bead]")).toBeNull();
      expect(container.textContent).not.toContain("bead");
    });

    it("never borrows a query decision's bead for a finding that shares its key", () => {
      const { container } = render(
        <ExecutiveFindingsList
          snapshot={snapshot}
          handoffBeads={[filed({ kind: "query", beadId: "mp-9zz" })]}
        />,
      );

      expect(container.querySelector("[data-handoff-bead]")).toBeNull();
    });
  });
});

// Bead ro-wwm. The cut was silent on this surface: the producer named every
// dropped card in `suppressedItems` and the Tower rendered none of them, so the
// largest single finding in the meals.example archive sat one field deeper than
// the screen with nothing on the page admitting it existed.
describe("ExecutiveFindingsList reaches what the eight-card cut dropped", () => {
  const shown: ExecutiveInsight[] = Array.from({ length: 8 }, (_, index) => ({
    ...insightFixture,
    key: `shown-${index}`,
    title: `Shown finding ${index + 1}`,
  }));
  // Eleven findings ranked: eight shown, three named.
  const capped: ExecutiveSnapshot = {
    schemaVersion: 1,
    asset: "meals.example",
    generatedAt: "2026-07-31T06:00:00.000Z",
    windowStart: "2026-07-25",
    windowEnd: "2026-07-28",
    sourceArchiveCount: 89,
    items: shown,
    suppressedItems: [
      {
        key: "distant-demand-cluster/water-intake-calculator",
        kind: "discovery",
        title: "56,500 monthly searches sit past the near-win band on /water-intake-calculator",
      },
      {
        key: "llm-grounding-traffic",
        kind: "discovery",
        title: "9.0% of captured search impressions are machine grounding",
      },
      {
        key: "feature-usage-calculation_complete",
        kind: "insight",
        title: "The calculator is completing meaningful user jobs",
      },
    ],
    searchQueries: null,
    searchPages: null,
    productUse: null,
    searchIntelligence: null,
    serpPanel: null,
    methodology: ["Derived from archived GA4/GSC reports."],
  };

  it("counts the suppressed findings and discloses their titles", () => {
    const { container, getByText } = render(
      <ExecutiveFindingsList snapshot={capped} />,
    );

    const reveal = container.querySelector<HTMLDetailsElement>(
      "[data-suppressed-findings]",
    );
    expect(reveal).not.toBeNull();
    // Where the line was drawn, in the summary itself: the eight shown.
    expect(reveal!.querySelector("summary")?.textContent).toBe(
      "3 more below the top 8",
    );
    // Closed by default: the cap is an attention decision, so the answer to it
    // is a quiet line, not three more cards.
    expect(reveal!.open).toBe(false);

    fireEvent.click(reveal!.querySelector("summary")!);
    expect(reveal!.open).toBe(true);
    for (const item of capped.suppressedItems) {
      expect(getByText(item.title)).toBeTruthy();
    }
    // The titles are the proof nothing was discarded; no sentence says so.
    expect(reveal!.querySelector("p")).toBeNull();
  });

  it("mentions a suppressed finding without offering it as one to act on", () => {
    const { container, getAllByRole } = render(
      <ExecutiveFindingsList snapshot={capped} onDecide={vi.fn()} />,
    );

    // Eight rows, eight sets of controls: a mention is not a row.
    expect(getAllByRole("button", { name: "Mark" })).toHaveLength(8);
    expect(
      container.querySelector("[data-suppressed-findings] button"),
    ).toBeNull();
  });

  it("says nothing when the cut dropped nothing", () => {
    const { container } = render(
      <ExecutiveFindingsList snapshot={{ ...capped, suppressedItems: [] }} />,
    );

    expect(container.querySelector("[data-suppressed-findings]")).toBeNull();
  });

  it("counts one dropped finding in the singular", () => {
    const { container } = render(
      <ExecutiveFindingsList
        snapshot={{ ...capped, suppressedItems: capped.suppressedItems.slice(0, 1) }}
      />,
    );

    expect(
      container.querySelector("[data-suppressed-findings] summary")?.textContent,
    ).toBe("1 more below the top 8");
  });
});

describe("like-for-like performance tones", () => {
  it("steps positive and negative intensity symmetrically", () => {
    expect(performanceTone(0)).toBe("neutral");
    expect(performanceTone(5)).toBe("positive-subtle");
    expect(performanceTone(12)).toBe("positive");
    expect(performanceTone(25)).toBe("positive-strong");
    expect(performanceTone(-5)).toBe("negative-subtle");
    expect(performanceTone(-12)).toBe("negative");
    expect(performanceTone(-25)).toBe("negative-strong");
  });

  it("keeps the directional color when a caller supplies TV-size text", () => {
    const { container } = render(
      <DeltaChip
        value={37}
        tone="positive-strong"
        className="text-wall-detail"
      />,
    );
    const chip = container.querySelector('[data-tone="positive-strong"]');
    expect(chip?.className).toContain("text-wall-detail");
    expect(chip?.className).toContain(
      "data-[tone=positive-strong]:text-trend-positive",
    );
  });
});

// --- one open alert, as lib/attention reads it
const signupsDrop: AttentionItem = {
  id: 1,
  asset: "meals.example",
  assetDisplayName: "Meal Planner",
  severity: "warn",
  kind: "anomaly",
  message: "22 in last24h (avg7d 39.3, P(<=22)~=0.0020)",
  firedAt: hoursAgo(2),
  metric: "signups",
  ruleId: "flow-poisson-low",
  ruleInputs: {
    metric: "signups",
    observed: 22,
    baselinePerDay: 39.285714285714285,
    alpha: 0.01,
    pLowerTail: 0.001958382423585121,
  },
  correlatedChanges: [],
  occurrences: 1,
  firstFiredAt: hoursAgo(2),
};

/**
 * Bead ro-elf. The page states the SAME obligation the card marks, with the
 * room the card does not have: which panel day is owed, when the triage was
 * due, and the bead to go and close. So the assertions are about the extra
 * facts — and about the badge still being the thing that carries the state.
 */
describe("PanelReviewLine — the card's marker, with the page's room", () => {
  const DAY = 24 * HOUR;
  const daysAhead = (d: number) => new Date(NOW + d * DAY).toISOString();
  const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();
  const PANEL_DAY = "2026-07-01";

  const openReview = (dueAt: string): PanelReview => ({
    beadId: "mp-4a2",
    panelDate: PANEL_DAY,
    dueAt,
    status: "open",
    closedAt: null,
    panel: true,
  });

  const renderLine = (
    review: PanelReview | null,
    latestPanelDate: string | null = PANEL_DAY,
  ) =>
    render(
      <PanelReviewLine review={review} latestPanelDate={latestPanelDate} nowMs={NOW} />,
    );

  it("draws nothing whatsoever for an asset with nothing to review", () => {
    // The card's absence rule, inherited exactly: no row, no dash, no empty
    // state — and it follows the LANDING, never config/serp-panel.json.
    const { container } = renderLine(null, null);
    expect(container.querySelector("[data-panel-review-line]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("labels a panel-less asset's row a signal collection, and a panel's a SERP panel", () => {
    // Bead ro-z0g, one surface down from the badge: the row's own label is the
    // noun, so an asset that buys no panel reads as the collection it does
    // buy — the same words its bead title carries.
    const panel = renderLine(openReview(daysAhead(4)));
    const panelLine = panel.container.querySelector("[data-panel-review-line]")!;
    expect(panelLine.textContent).toContain("SERP panel");
    panel.unmount();

    const collection = renderLine({ ...openReview(daysAhead(4)), panel: false });
    const collectionLine = collection.container.querySelector("[data-panel-review-line]")!;
    expect(collectionLine.textContent).toContain("Signal collection");
    expect(collectionLine.textContent).not.toMatch(/SERP panel/);
    // Still the same row: the day owed, the deadline, and the bead to close.
    expect(collectionLine.textContent).toContain("Jul 1, 2026");
    expect(collectionLine.textContent).toContain("mp-4a2");
  });

  it("names the panel day, the deadline, and the bead to close", () => {
    const { container } = renderLine(openReview(daysAhead(4)));
    const line = container.querySelector("[data-panel-review-line]")!;
    expect(line.getAttribute("data-panel-review-line")).toBe("pending");
    // The three facts the badge could only fit into a hover title.
    expect(line.textContent).toContain("Jul 1, 2026");
    expect(line.textContent).toContain("Jul 9, 2026");
    expect(line.textContent).toContain("mp-4a2");
    // And the state is still the badge's job, in a glyph and a duration.
    expect(line.querySelector("[data-panel-review]")!.textContent).toBe("4d");
    expect(line.textContent).not.toMatch(/pending|overdue|reviewed/i);
  });

  it("escalates the whole row when the deadline has passed", () => {
    const { container } = renderLine(openReview(daysAgo(3)));
    const line = container.querySelector("[data-panel-review-line]")!;
    expect(line.getAttribute("data-panel-review-line")).toBe("overdue");
    expect(line.className).toContain("border-error/40");
    // Still stated in dates and an id — the tone is what carries "late".
    expect(line.textContent).toContain("Jul 2, 2026");
    expect(line.textContent).not.toMatch(/late|overdue/i);
  });

  it("stops stating a deadline once the review is done", () => {
    // A met obligation has no outstanding date, and printing the old one would
    // be a number the page then has to explain.
    const { container } = renderLine({
      ...openReview(daysAgo(2)),
      status: "closed",
      closedAt: daysAgo(1),
    });
    const line = container.querySelector("[data-panel-review-line]")!;
    expect(line.getAttribute("data-panel-review-line")).toBe("reviewed");
    expect(line.textContent).not.toContain("due");
    expect(line.textContent).toContain("mp-4a2");
    expect(line.className).not.toContain("border-error");
  });

  it("names the NEWER panel day when a finished review no longer covers it", () => {
    // The day the operator still owes, not the one they already dealt with —
    // the same day the badge beside it names, from the same derivation.
    const { container } = renderLine(
      { ...openReview(daysAgo(2)), status: "closed", closedAt: daysAgo(1) },
      "2026-07-08",
    );
    const line = container.querySelector("[data-panel-review-line]")!;
    expect(line.getAttribute("data-panel-review-line")).toBe("pending");
    expect(line.textContent).toContain("Jul 8, 2026");
    expect(line.textContent).not.toContain("Jul 1, 2026");
    expect(line.querySelector("[data-panel-review]")!.getAttribute("title")).toContain(
      "2026-07-08",
    );
  });

  it("says less rather than inventing a date it does not have", () => {
    const { container } = renderLine(
      { ...openReview(daysAhead(4)), dueAt: null, panelDate: null },
      null,
    );
    const line = container.querySelector("[data-panel-review-line]")!;
    expect(line.getAttribute("data-panel-review-line")).toBe("pending");
    expect(line.textContent).toContain("SERP panel");
    expect(line.textContent).toContain("mp-4a2");
    expect(line.textContent).not.toContain("due");
  });
});

// The pure answers /alerts and Home read about one open alert (bead
// `ro-trai.25`: they outlived the desk table they were born in). The rows that
// draw them are /alerts' and Home's, and are tested there.
describe("lib/attention — one alert's handoff and grouping", () => {
  // The alert row's own handoff (bead `ro-l1ed.4`).
  it("files the translated headline against the firing, never the rule alone", () => {
    // The key is `flags.id`: one rule fires many times on one asset, and only
    // the flag id names the firing the operator was looking at.
    expect(alertTaskHandoff(signupsDrop)).toEqual({
      asset: "meals.example",
      kind: "alert",
      key: String(signupsDrop.id),
      rule: signupsDrop.ruleId,
      title: "Signups well below normal — 22 vs ~39/day",
      summary: expect.stringContaining("From the NoticeOS alert for meals.example"),
      priority: 2,
    });
    expect(alertTaskHandoff({ ...signupsDrop, severity: "error" }).priority).toBe(1);
    // Never the rule's stored statistics line — that is what the desk moved
    // behind the evidence glyph in the first place.
    expect(alertTaskHandoff(signupsDrop).title).not.toContain("avg7d");
  });

  // `ro-kukv.6` / decision D15: one row for one fact true of several sites.
  it("reads a row standing for several sites as a group, with their names as one hover", () => {
    const member = (id: number, asset: string, assetDisplayName: string) => ({ id, asset, assetDisplayName, firedAt: hoursAgo(24) });
    const group: AttentionItem = {
      ...signupsDrop,
      members: [member(41, "fees.example", "Fee Codes"), member(42, "areas.info", "Area Lookup")],
    };
    expect(isGrouped(group)).toBe(true);
    expect(memberNames(group)).toBe("Fee Codes, Area Lookup");
    expect(isGrouped(signupsDrop)).toBe(false);
    expect(memberNames(signupsDrop)).toBeUndefined();
    expect(isGrouped({ ...signupsDrop, members: [member(41, "fees.example", "Fee Codes")] })).toBe(false);
  });
});

describe("DataSourceIcons — one status per source, told apart by glyph (ro-kukv.9)", () => {
  // One slot per distinct look of the connection vocabulary (ro-ujb9.96.7.16).
  const everyState: SourceReading[] = ([
    ["nightly-report", "Nightly report", "working"],
    ["gsc", "Google Search Console", "failing"],
    ["bing-webmaster", "Bing Webmaster Tools", "overdue"],
    ["posthog", "PostHog", "collecting"],
    ["uptime", "Uptime", "unknown"],
    ["ga4", "Google Analytics 4", "not-connected"],
    ["clarity", "Microsoft Clarity", "not-using"],
    ["dataforseo", "DataForSEO", "not-applicable"],
  ] as const).map(([id, label, kind]) => ({ id, label, kind, site: null, provider: null, detail: null, observedAt: null }));
  const classNames = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>("*")].map((node) =>
      typeof node.className === "string"
        ? node.className
        : (node.getAttribute("class") ?? ""),
    );

  it("leaves no arbitrary pixel value on a mark", () => {
    const { container } = render(<DataSourceIcons sources={everyState} />);
    for (const className of classNames(container)) {
      expect(className).not.toMatch(/\[\d+(\.\d+)?px\]/);
    }
    expect(classNames(container).join(" ")).toContain("text-mark-degraded");
  });

  it("tells every status apart by glyph, not by opacity", () => {
    const { container } = render(<DataSourceIcons sources={everyState} />);
    const marks = [...container.querySelectorAll("[role='img']")];
    expect(marks).toHaveLength(8);
    // Every status names itself for a screen reader, in the words the
    // Integrations page and the Data sources rows use...
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual([
      "Nightly report: Working",
      "Google Search Console: Failing",
      "Bing Webmaster Tools: Overdue",
      "PostHog: Collecting",
      "Uptime: Unknown",
      "Google Analytics 4: Not connected",
      "Microsoft Clarity: Not using",
      "DataForSEO: Doesn't apply",
    ]);
    // ...and each carries a DIFFERENT corner mark. Skipped and not-applicable
    // used to share one slash at two opacities, which is the single difference
    // a television across a room cannot carry.
    const shapes = marks.map(
      (mark) =>
        mark.querySelector("[data-state-mark]")?.getAttribute("data-state-mark") ??
        "dashed-box",
    );
    expect(shapes).toEqual(["check", "bang", "clock", "pending", "unknown", "dashed-box", "slash", "bar"]);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("wears the same tone as the status chip: red for Failing, amber for Overdue", () => {
    const { container } = render(<DataSourceIcons sources={everyState} />);
    const box = (id: string) => container.querySelector(`[data-source="${id}"]`)!;
    expect(box("nightly-report")).toHaveClass("text-connected");
    expect(box("gsc")).toHaveClass("text-error");
    expect(box("bing-webmaster")).toHaveClass("text-warn");
    expect(box("ga4")).toHaveClass("border-dashed");
    expect(box("gsc")).toHaveAttribute("data-connection", "failing");
  });
});

describe("AgeBadge amber threshold", () => {
  it("renders fresh (muted) below 2× cadence", () => {
    const { container } = render(
      <AgeBadge iso={hoursAgo(3)} cadenceHours={24} nowMs={NOW} />,
    );
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("text-muted-foreground");
    expect(badge?.className).not.toContain("text-warn");
    expect(badge?.textContent).toContain("3h");
  });

  it("turns amber past 2× cadence", () => {
    const { container } = render(
      <AgeBadge iso={hoursAgo(72)} cadenceHours={24} nowMs={NOW} />,
    );
    expect(container.querySelector("span")?.className).toContain("text-warn");
  });

  it("marks a last-good value after a failed fetch", () => {
    const { container } = render(
      <AgeBadge iso={hoursAgo(1)} cadenceHours={24} nowMs={NOW} lastGood />,
    );
    expect(container.textContent).toContain("last-good");
  });

  // bead ro-kukv.10 / doc 17 rule 6 — a dash in a value's slot reads as a
  // rendering failure, not as an absence.
  it("says a lane that never reported never reported", () => {
    const { container } = render(
      <AgeBadge iso={null} cadenceHours={24} nowMs={NOW} />,
    );
    const badge = container.querySelector("span");
    expect(badge?.textContent).toBe("never");
    expect(badge?.textContent).not.toContain("—");
    expect(badge?.getAttribute("data-age-state")).toBe("never");
    expect(badge?.getAttribute("title")).toBe(
      "Never reported — nothing has ever arrived from this source",
    );
    // Still amber: an absent age is never fresh (isAmber).
    expect(badge?.className).toContain("text-warn");
    // And the badge never renders the "{age} ago" shape, so no surface can
    // read "never ago".
    expect(badge?.textContent).not.toContain("ago");
  });

  it("keeps an unreadable timestamp distinct from a lane that never reported", () => {
    const { container } = render(
      <AgeBadge iso="not-a-timestamp" cadenceHours={24} nowMs={NOW} />,
    );
    const badge = container.querySelector("span");
    expect(badge?.textContent).toBe("unknown");
    expect(badge?.getAttribute("data-age-state")).toBe("unreadable");
    expect(badge?.getAttribute("title")).toBe(
      "The stored timestamp for this source could not be read",
    );
  });

  it("keeps its ordinary title once an age exists", () => {
    const { container } = render(
      <AgeBadge iso={hoursAgo(3)} cadenceHours={24} nowMs={NOW} />,
    );
    const badge = container.querySelector("span");
    expect(badge?.getAttribute("data-age-state")).toBe("aged");
    expect(badge?.getAttribute("title")).toBe("Data age");
  });
});

describe("Timeline — a cut history says it was cut (ro-5e8.1)", () => {
  const events: AnnotationItem[] = [
    { id: 9, at: hoursAgo(3), kind: "deploy", ref: "a1b2c3d", note: "ship cards" },
    { id: 8, at: hoursAgo(50), kind: "config", ref: "flags@41", note: "raise alpha" },
  ];

  it("renders no truncation line when the page carries every change", () => {
    const { container } = render(<Timeline items={events} nowMs={NOW} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).not.toContain("not shown");
  });

  it("names how many older changes are missing, as the line's last node", () => {
    const { container } = render(
      <Timeline items={events} nowMs={NOW} olderCount={52} />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(3);
    const last = container.querySelector("li:last-child");
    expect(last?.getAttribute("data-timeline-older")).toBe("52");
    expect(last?.textContent).toBe("52 older changes not shown");
  });

  it("counts one missing change in the singular", () => {
    const { container } = render(
      <Timeline items={events} nowMs={NOW} olderCount={1} />,
    );
    expect(container.textContent).toContain("1 older change not shown");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bead ro-4ko — an event names the task that caused it.
  // ───────────────────────────────────────────────────────────────────────────
  const filed: AnnotationItem[] = [
    { id: 9, at: hoursAgo(3), kind: "deploy", ref: "mp-1w2", note: "rewrote the opener" },
    { id: 8, at: hoursAgo(50), kind: "config", ref: "a1b2c3d", note: "raise alpha" },
  ];
  const bead = {
    kind: "query" as const,
    key: "chipotle calories",
    beadId: "mp-1w2",
    status: "open" as const,
    closedAt: null,
  };

  it("renders a resolved ref as the task, and an unresolved one as it always was", () => {
    const { container } = render(
      <Timeline items={filed} nowMs={NOW} beads={[bead]} />,
      { wrapper: MemoryRouter },
    );
    const rows = [...container.querySelectorAll("li")];
    // ONE representation of the ref: the badge IS the ref rendered richer, never
    // a badge beside the mono string it replaces.
    expect(rows[0]!.querySelector("[data-handoff-bead-id]")).toHaveAttribute(
      "data-handoff-bead-id",
      "mp-1w2",
    );
    expect(rows[0]!.textContent?.match(/mp-1w2/g)).toHaveLength(1);
    // A commit sha resolves to nothing and stays exactly what it was — an
    // unresolved ref is not a task-less event.
    expect(rows[1]!.querySelector("[data-handoff-bead-id]")).toBeNull();
    expect(rows[1]!.querySelector(".font-mono")?.textContent).toBe("a1b2c3d");
  });

  it("keeps a shipped task from reading as a proven outcome", () => {
    const { container } = render(
      <Timeline
        items={filed}
        nowMs={NOW}
        beads={[{ ...bead, status: "closed", closedAt: "2026-07-29T00:00:00.000Z" }]}
      />,
      { wrapper: MemoryRouter },
    );
    expect(
      container.querySelector('[title*="mp-1w2"]')?.getAttribute("title"),
    ).toContain("not proof of shipment or outcome");
    expect(container.textContent).not.toMatch(/it worked|confirmed|resolved/i);
  });

  it("falls back to the plain ref when the register could not be asked", () => {
    // A null slice is "we could not look", never "this event has no task".
    const { container } = render(<Timeline items={filed} nowMs={NOW} beads={null} />);
    expect(container.querySelector("[data-handoff-bead-id]")).toBeNull();
    expect(
      [...container.querySelectorAll(".font-mono")].map((el) => el.textContent),
    ).toEqual(["mp-1w2", "a1b2c3d"]);
  });

  // A lifecycle move (ro-3085) stores the two stages in its `ref` because that
  // is the row's identity; the row must still read as English.
  it("states a recorded lifecycle move in words instead of printing its ref", () => {
    const moved: AnnotationItem[] = [
      { id: 12, at: hoursAgo(2), kind: "config", ref: "lifecycle:baselining>retired", note: null },
    ];
    const { container } = render(<Timeline items={moved} nowMs={NOW} />);
    expect(container.textContent).toContain("Stage moved from Baselining to Retired");
    expect(container.textContent).not.toContain("lifecycle:baselining>retired");
    expect(container.querySelector(".font-mono")).toBeNull();
  });

  it("leaves a ref that only looks like a move as the mono string it is", () => {
    const odd: AnnotationItem[] = [
      { id: 13, at: hoursAgo(2), kind: "config", ref: "lifecycle:live>nowhere", note: null },
    ];
    const { container } = render(<Timeline items={odd} nowMs={NOW} />);
    expect(container.querySelector(".font-mono")?.textContent).toBe("lifecycle:live>nowhere");
  });
});

describe("lifecycleStepper — assets.status → stepper spec", () => {
  it("maps each happy-path status to its step index, no terminal", () => {
    expect(lifecycleStepper("pre-launch")).toMatchObject({ activeIndex: 0, terminal: null });
    expect(lifecycleStepper("onboarding")).toMatchObject({ activeIndex: 1, terminal: null });
    expect(lifecycleStepper("baselining")).toMatchObject({ activeIndex: 2, terminal: null });
    expect(lifecycleStepper("live")).toMatchObject({ activeIndex: 3, terminal: null });
  });

  it("routes retired off the happy path into a terminal chip", () => {
    const spec = lifecycleStepper("retired");
    expect(spec.activeIndex).toBe(-1);
    expect(spec.terminal).toEqual({ label: "Retired" });
  });
});

describe("Stepper rendering across stages", () => {
  it("marks the current happy-path step with aria-current", () => {
    const spec = lifecycleStepper("baselining");
    const { container } = render(
      <Stepper steps={spec.steps} activeIndex={spec.activeIndex} terminal={spec.terminal} />,
    );
    const current = container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Baselining");
  });

  it("gives retired its terminal chip the current marker, no happy-path step current", () => {
    const spec = lifecycleStepper("retired");
    const { container } = render(
      <Stepper steps={spec.steps} activeIndex={spec.activeIndex} terminal={spec.terminal} />,
    );
    const marked = container.querySelectorAll('[aria-current="step"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("Retired");
  });
});

describe("KnobRow", () => {
  it("renders a plain-language label, value, explanation, and scope", () => {
    const { container, getByText } = render(
      <KnobRow
        label="Anomaly sensitivity"
        value="0.01"
        explain="How unlikely a drop must be before a flag fires."
        scope="portfolio default"
      />,
    );
    expect(getByText("Anomaly sensitivity")).toBeInTheDocument();
    expect(getByText("0.01")).toBeInTheDocument();
    expect(container.textContent).toContain("How unlikely a drop");
    expect(container.textContent).toContain("portfolio default");
  });
});

describe("StateChip — tone maps to a palette token (no bare state prose)", () => {
  it("generic affirmative is neutral, declined is slate, and na is muted", () => {
    const { getByText } = render(
      <>
        <StateChip tone="affirmative" label="Enabled" subject="collection:example.com" />
        <StateChip tone="declined" label="Paused" subject="collection:other.example" />
        <StateChip tone="na" label="Retired" subject="lifecycle:example.com" />
      </>,
    );
    expect(getByText("Enabled").className).toContain("text-foreground");
    // Each chip names what it is about (bead ro-ujb9.96.10), read by the flow gate.
    expect(getByText("Enabled")).toHaveAttribute("data-status-for", "collection:example.com");
    expect(getByText("Retired")).toHaveAttribute("data-status-for", "lifecycle:example.com");
    expect(getByText("Paused").className).toContain("text-info");
    expect(getByText("Retired").className).toContain("text-muted-foreground");
  });
});

/** Bead ro-pbzu.8: the ONE segmented mass bar. `PriorityBar` became its
 * priority-ramp preset rather than staying a rival implementation of the same
 * shape, so both keep proving the same rules here. */
describe("ProgressRing — n of m discrete steps", () => {
  const segments = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-segment]")].map((el) =>
      el.getAttribute("data-segment"),
    );

  it("draws one arc per item and fills exactly the done ones", () => {
    const { container } = render(
      <ProgressRing done={2} total={4} title="Setup 2 of 4" />,
    );
    expect(segments(container)).toEqual(["done", "done", "pending", "pending"]);
  });

  it("draws an empty ring at 0 and a full one at m", () => {
    const empty = render(<ProgressRing done={0} total={4} title="Setup 0 of 4" />);
    expect(segments(empty.container)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    const full = render(<ProgressRing done={4} total={4} title="Setup 4 of 4" />);
    expect(segments(full.container)).toEqual(["done", "done", "done", "done"]);
  });

  it("clamps a fraction outside its own range instead of drawing past the ring", () => {
    const over = render(<ProgressRing done={9} total={3} title="over" />);
    expect(segments(over.container)).toEqual(["done", "done", "done"]);
    const under = render(<ProgressRing done={-4} total={3} title="under" />);
    expect(segments(under.container)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("carries the whole sentence as its accessible name, not just a fraction", () => {
    const { getByRole } = render(
      <ProgressRing
        done={2}
        total={4}
        title="Setup 2 of 4 — still to do: Data sources, Baseline · 28 days"
      />,
    );
    expect(
      getByRole("img", {
        name: "Setup 2 of 4 — still to do: Data sources, Baseline · 28 days",
      }),
    ).toBeTruthy();
  });

  it("keeps every painted arc positive however many segments it is given", () => {
    const { container } = render(
      <ProgressRing done={5} total={12} title="5 of 12" />,
    );
    const dashes = [...container.querySelectorAll("[data-segment]")].map((el) =>
      Number(el.getAttribute("stroke-dasharray")?.split(" ")[0]),
    );
    expect(dashes).toHaveLength(12);
    for (const dash of dashes) expect(dash).toBeGreaterThan(0);
  });

  it("prints the done count only at panel size", () => {
    const small = render(<ProgressRing done={2} total={4} title="Setup 2 of 4" />);
    expect(small.container.textContent).toBe("");
    const large = render(
      <ProgressRing done={2} total={4} title="Setup 2 of 4" size="md" />,
    );
    expect(large.container.textContent).toBe("2");
  });
});

describe("SegmentBar — how a total divides", () => {
  it("sizes each segment by its share and skips the empty ones", () => {
    const { container } = render(
      <SegmentBar
        ariaLabel="4 of 7 open alerts are errors, 3 are warnings"
        segments={[
          { name: "error", value: 4, fill: "bg-error" },
          { name: "warn", value: 3, fill: "bg-warn" },
          { name: "info", value: 0, fill: "bg-info" },
        ]}
      />,
    );

    const drawn = [...container.querySelectorAll("[data-segment]")].map((el) => [
      el.getAttribute("data-segment"),
      (el as HTMLElement).style.flexGrow,
    ]);
    expect(drawn).toEqual([
      ["error", "4"],
      ["warn", "3"],
    ]);
    // The bar is a sentence, not an ornament: it always names what it divides.
    expect(container.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe(
      "4 of 7 open alerts are errors, 3 are warnings",
    );
  });

  it("never paints a non-empty segment below its minimum width", () => {
    const { container } = render(
      <SegmentBar
        ariaLabel="1 of 121 is top priority"
        segments={[
          { name: "top", value: 1, fill: "bg-error" },
          { name: "rest", value: 120, fill: "bg-muted-foreground/30" },
        ]}
      />,
    );

    // At true proportion this would be a third of a pixel, which communicates
    // nothing and makes the bar lie by omission.
    const top = container.querySelector('[data-segment="top"]') as HTMLElement;
    expect(top.style.minWidth).toBe("3px");
  });

  it("renders an empty track rather than an invented split", () => {
    const { container } = render(
      <SegmentBar
        ariaLabel="Nothing open"
        segments={[
          { name: "error", value: 0, fill: "bg-error" },
          { name: "warn", value: 0, fill: "bg-warn" },
        ]}
      />,
    );

    expect(container.querySelector("[data-segment-bar]")).not.toBeNull();
    expect(container.querySelectorAll("[data-segment]")).toHaveLength(0);
  });

  it("keeps PriorityBar's own ramp, hooks and breakdown after the refactor", () => {
    const { container } = render(<PriorityBar bands={[1, 2, 8, 2, 1]} total={14} />);

    const bar = container.querySelector("[data-priority-bar]")!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toBe(
      "Open work by priority: 1 top · 2 high · 8 normal · 2 low · 1 lowest",
    );
    expect(bar.getAttribute("title")).toContain("14 not-closed tasks by priority");
    // A task's priority is not a severity (doc 14, bead ro-ujb9.200): the ramp
    // steps down in ink and never wears an attention hue.
    expect(
      container.querySelector('[data-priority-band="top"]')!.className,
    ).toContain("bg-foreground");
    expect(
      container.querySelector('[data-priority-band="high"]')!.className,
    ).toContain("bg-foreground/65");
    for (const segment of container.querySelectorAll("[data-priority-band]")) {
      expect(segment.className).not.toMatch(/\bbg-(error|warn|info)\b/);
    }
  });
});

// The KnobEditor's own cases moved to test/knob-editor.test.tsx when it stopped
// staging and started writing (D18, bead ro-pbzu.5): they mock Sonner to read
// the Undo out of the toast, and a module mock is a file-wide fact.

/**
 * Bead ro-282.3. The scoreboard is the point — six counts before twenty rows —
 * and every assertion below is about one of the three semantics a naive
 * rendering destroys: depth-bounded ranks, an unstated depth, and unknown AI
 * Overviews. The counts themselves come from `serpPanelScoreboard`, so the
 * derivation is tested once and the component is tested for what it SAYS.
 */
describe("SerpPanelBoard — how the panel is doing, before what each row is", () => {
  const q = (over: Partial<SerpPanelQuery> = {}): SerpPanelQuery => ({
    query: "calorie calculator",
    device: "desktop",
    // Unlabelled by default — meals.example's panel, and the case the grouping
    // must leave rendering exactly as it did before clusters existed.
    label: null,
    bestRank: 2,
    bestUrl: "https://nosh.example/calories",
    aioPresent: true,
    aioCitesUs: true,
    composition: null,
    ...over,
  });

  /** Ten tracked queries: 2/3/9 in the tiers, four outside the depth, and an
   * AI-Overview column that is deliberately not fully observed. */
  const panel: SerpPanelSnapshot = {
    reportDate: "2026-08-03",
    trackedDepth: 20,
    market: null,
    queries: [
      q({ query: "a", bestRank: 1, aioPresent: true, aioCitesUs: true }),
      q({ query: "b", bestRank: 3, aioPresent: true, aioCitesUs: false }),
      q({ query: "c", bestRank: 4, aioPresent: false, aioCitesUs: false }),
      q({ query: "d", bestRank: 10, aioPresent: false, aioCitesUs: false }),
      q({ query: "e", bestRank: 11, aioPresent: null, aioCitesUs: null }),
      q({ query: "f", bestRank: 19, aioPresent: null, aioCitesUs: null }),
      q({ query: "g", bestRank: null, bestUrl: null, aioPresent: true, aioCitesUs: false }),
      q({ query: "h", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null }),
      q({ query: "i", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null }),
      q({ query: "j", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null }),
    ],
  };

  const statOf = (root: Element, name: string) =>
    root.querySelector(`[data-serp-panel-stat="${name}"]`)!.textContent ?? "";

  it("counts the tiers off ranks the pull actually recorded", () => {
    const board = serpPanelScoreboard(panel);
    expect(board).toEqual({
      tracked: 10,
      ranking: 6,
      top10: 4,
      top3: 2,
      // Five rows the panel could answer the AI question for; five unknown.
      aioKnown: 5,
      aioPresent: 3,
      aioCitesUs: 1,
    });
  });

  it("leads with the scoreboard and states the collection day once", () => {
    const { container } = render(<SerpPanelBoard panel={panel} />);
    const board = container.querySelector("[data-serp-panel]")!;

    expect(statOf(board, "tracked")).toContain("10");
    expect(statOf(board, "ranking")).toContain("6");
    expect(statOf(board, "top10")).toContain("4");
    expect(statOf(board, "top3")).toContain("2");
    // The day the whole block is about, stated once and nowhere else.
    expect(board.textContent).toContain("Aug 3, 2026");
    expect(board.textContent!.match(/Aug 3, 2026/g)).toHaveLength(1);
  });

  it("never reads a query outside the tracked depth as not ranking", () => {
    // The semantic this component exists for. A depth-20 pull that saw
    // nothing says so about ITS OWN depth; rank 24 and genuinely absent are the
    // same observation to it, and both are terms worth working.
    const { container } = render(<SerpPanelBoard panel={panel} />);
    const unranked = container.querySelector("[data-serp-panel-unranked]")!;
    expect(unranked.textContent).toBe(">20");
    expect(unranked.getAttribute("title")).toContain("Not in the top 20");
    expect(container.textContent).not.toMatch(/not ranking|does not rank|no rank/i);
    // And the tier denominators never absorbed it as a rank.
    expect(statOf(container.querySelector("[data-serp-panel]")!, "ranking")).toContain("6");
  });

  it("claims no depth when the archive recorded none", () => {
    // A legacy row without `tracked_depth`. Printing ">20" here would name a
    // depth nobody pulled to, so the number simply is not stated.
    const { container } = render(
      <SerpPanelBoard panel={{ ...panel, trackedDepth: null }} />,
    );
    expect(container.querySelector("[data-serp-panel-unranked]")!.textContent).toBe("—");
    expect(container.textContent).not.toContain("depth 20");
    expect(container.textContent).not.toContain("top 20");
    expect(container.textContent).toContain("inside tracked depth");
  });

  it("counts AI Overviews against what was CHECKED, never against the panel", () => {
    // Five of ten rows never got an answer. Dividing by ten would report this
    // asset clear of overviews it has never been checked against.
    const { container } = render(<SerpPanelBoard panel={panel} />);
    const board = container.querySelector("[data-serp-panel]")!;
    expect(statOf(board, "aio-present")).toContain("of 5 checked");
    expect(statOf(board, "aio-present")).not.toContain("of 10");
    expect(statOf(board, "aio-cites-us")).toContain("of 3 shown");
  });

  it("says unknown rather than zero when nothing was checked at all", () => {
    const { container } = render(
      <SerpPanelBoard
        panel={{
          ...panel,
          queries: panel.queries.map((row) => ({
            ...row,
            aioPresent: null,
            aioCitesUs: null,
          })),
        }}
      />,
    );
    const board = container.querySelector("[data-serp-panel]")!;
    expect(statOf(board, "aio-present")).toContain("—");
    expect(statOf(board, "aio-present")).toContain("not checked");
    expect(statOf(board, "aio-present")).not.toMatch(/\b0\b/);
    // No glyph for an unknown row either — absence means unknown, not clear.
    expect(board.querySelector("[data-aio-state]")).toBeNull();
  });

  it("tells the three known AI Overview states apart by glyph, as the query rows do", () => {
    const { container } = render(<SerpPanelBoard panel={panel} />);
    expect(container.querySelector('[data-aio-state="cited"]')).not.toBeNull();
    expect(container.querySelector('[data-aio-state="uncited"]')).not.toBeNull();
    expect(container.querySelector('[data-aio-state="absent"]')).not.toBeNull();
  });

  it("orders the rows by rank, unranked last", () => {
    const { container } = render(<SerpPanelBoard panel={panel} />);
    const order = [...container.querySelectorAll("[data-serp-panel-query]")].map((el) =>
      el.getAttribute("data-serp-panel-query"),
    );
    expect(order).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  });

  it("draws nothing whatsoever for an asset with no panel", () => {
    // Six zeroes would be a score this asset never played for.
    const { container } = render(<SerpPanelBoard panel={null} />);
    expect(container.querySelector("[data-serp-panel]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bead ro-282.5 — the panel groups by the BET each query measures.
  // Three cases, and the constraint is that they are additive in both
  // directions: a labelled panel groups, an unlabelled one must render exactly
  // what it always did, and a mixed one must not invent a cluster for the rows
  // that carry no label.
  // ───────────────────────────────────────────────────────────────────────────
  const clustersOf = (root: Element) =>
    [...root.querySelectorAll("[data-serp-panel-cluster]")].map((el) =>
      el.getAttribute("data-serp-panel-cluster"),
    );

  it("groups a labelled panel by cluster, with each cluster's line from the shared scoreboard", () => {
    const labelled: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({ query: "calorie calculator", label: "Calculator seam", bestRank: 2, aioPresent: true, aioCitesUs: true }),
        q({ query: "macro calculator", label: "Calculator seam", bestRank: 9, aioPresent: false, aioCitesUs: false }),
        q({ query: "chipotle calories", label: "Item head", bestRank: 14, aioPresent: null, aioCitesUs: null }),
        q({ query: "starbucks calories", label: "Item head", bestRank: null, bestUrl: null, aioPresent: true, aioCitesUs: false }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={labelled} />);
    // Cluster order is the panel's own row order — the operator's config order,
    // the order they think about their bets in.
    expect(clustersOf(container)).toEqual(["Calculator seam", "Item head"]);

    // The per-cluster figures come from `serpPanelScoreboard` over that
    // cluster's rows, so the page and the derivation cannot hold two opinions
    // of "top 10". Two of the seam's terms are inside it; one of the item
    // head's two terms was never checked for an overview, so its AI clause
    // quotes ONE as the denominator rather than two.
    const line = (label: string) =>
      container.querySelector(`[data-serp-panel-cluster-line="${label}"]`)!.textContent ?? "";
    expect(line("Calculator seam")).toContain("2 of 2 in top 10");
    expect(line("Calculator seam")).toContain("1 AI Overview of 2 checked");
    expect(line("Item head")).toContain("0 of 2 in top 10");
    expect(line("Item head")).toContain("1 AI Overview of 1 checked");

    // The whole-panel tiles are unchanged by the grouping: four terms, four
    // rows, no denominator multiplied by the split.
    expect(statOf(container.querySelector("[data-serp-panel]")!, "tracked")).toContain("4");
  });

  it("renders a panel with no labels anywhere as the single ungrouped list it always was", () => {
    // meals.example. Not one group called "Unlabelled" — a fake cluster on a
    // asset that never placed a bet is a claim it never made.
    const { container } = render(<SerpPanelBoard panel={panel} />);
    expect(clustersOf(container)).toEqual([""]);
    expect(container.querySelector("[data-serp-panel-cluster-line]")).toBeNull();
    expect(container.textContent).not.toMatch(/unlabelled|ungrouped|other/i);
    // Same rows, same order, same total order as before grouping existed.
    const order = [...container.querySelectorAll("[data-serp-panel-query]")].map((el) =>
      el.getAttribute("data-serp-panel-query"),
    );
    expect(order).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bead ro-e46.2 — the device dimension reaches the surface.
  // ───────────────────────────────────────────────────────────────────────────
  it("shows a query walled on the phone and clear on the desktop as both, not one", () => {
    const split: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({ query: "how many calories", device: "mobile", bestRank: 4, aioPresent: true, aioCitesUs: false }),
        q({ query: "how many calories", device: "desktop", bestRank: 4, aioPresent: false, aioCitesUs: false }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={split} />);
    // ONE row — the split is a pair of marks in one cell, never a second row.
    // Doubled rows would list the same bets twice and multiply the tiles.
    expect(container.querySelectorAll("[data-serp-panel-query]")).toHaveLength(1);
    const glyphs = [...container.querySelectorAll("[data-aio-state]")];
    expect(
      glyphs.map((el) => [
        el.getAttribute("data-aio-device"),
        el.getAttribute("data-aio-state"),
      ]),
      // Phone first, always, so the reader learns the column once.
    ).toEqual([
      ["mobile", "uncited"],
      ["desktop", "absent"],
    ]);
    // Each mark names its own surface — a pair where only one is labelled would
    // read as one reading plus an unexplained second mark.
    expect(glyphs[0]).toHaveAttribute(
      "aria-label",
      "Phone: AI Overview shown; this site is not cited",
    );
    expect(glyphs[1]).toHaveAttribute(
      "aria-label",
      "Desktop: no AI Overview on the tracked result page",
    );
    // The caption names both surfaces rather than the hardcoded "desktop" it
    // claimed before the split reached this component — and, for a site that
    // saved no search market, no market at all (bead ro-ujb9.230).
    const board = container.querySelector("[data-serp-panel]")!;
    expect(board.textContent).toContain("Aug 3, 2026 · phone & desktop · depth 20");
    expect(board.textContent).not.toContain("US/English");
  });

  it("names the market the site saved, never a US/English it did not choose (ro-ujb9.230)", () => {
    const { container } = render(
      <SerpPanelBoard panel={{ ...panel, market: { locationCode: 2276, languageCode: "de" } }} />,
    );
    const board = container.querySelector("[data-serp-panel]")!;
    // The market's own spaces do not break: one fact stays on one line.
    expect(board.textContent).toContain("Aug 3, 2026 · desktop · Germany\u00a0·\u00a0German · depth 20");
    expect(board.textContent).not.toContain("US/English");
    expect(board.textContent).not.toContain("United States");
  });

  it("never turns one unknown into two, and never counts a term twice", () => {
    // The arithmetic risk of the split, asserted on the surface the operator
    // reads first. Two terms on two devices each: one answered on both, one
    // answered on neither.
    const split: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({ query: "answered", device: "mobile", bestRank: 4, aioPresent: true, aioCitesUs: false }),
        q({ query: "answered", device: "desktop", bestRank: 4, aioPresent: false, aioCitesUs: false }),
        q({ query: "unchecked", device: "mobile", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null }),
        q({ query: "unchecked", device: "desktop", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={split} />);
    const board = container.querySelector("[data-serp-panel]")!;
    expect(statOf(board, "tracked")).toContain("2");
    expect(statOf(board, "ranking")).toContain("1");
    // ONE term was checked, not two, and the unranked term still reads as the
    // depth rather than as "does not rank".
    expect(statOf(board, "aio-present")).toContain("of 1 checked");
    expect(container.querySelector("[data-serp-panel-unranked]")!.textContent).toBe(">20");
    expect(container.textContent).not.toMatch(/not ranking|does not rank/i);
    // The unchecked term draws no mark on either surface: absence is unknown,
    // and two blanks are still one unknown term.
    const row = container.querySelectorAll("[data-serp-panel-query]")[1]!;
    expect(row.querySelector("[data-aio-state]")).toBeNull();
  });

  it("draws one mark for a term the panel read on one surface", () => {
    // Nothing renders a device the snapshot did not observe: a single-device
    // panel looks exactly as it did before the split.
    const { container } = render(<SerpPanelBoard panel={panel} />);
    const first = container.querySelectorAll("[data-serp-panel-query]")[0]!;
    expect(first.querySelectorAll("[data-aio-state]")).toHaveLength(1);
    expect(first.querySelector("[data-aio-state]")).toHaveAttribute(
      "aria-label",
      "AI Overview cites this site",
    );
  });

  it("shows the current top three and our slot count per device, never movement", () => {
    const composed: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({
          query: "macro calculator",
          device: "mobile",
          bestRank: 3,
          bestUrl: "https://nosh.example/macros",
          composition: {
            top3Domains: ["calculator.net", "omnicalculator.com", "nosh.example"],
            organicResults: 19,
            secondRank: null,
            secondUrl: null,
            serpFeatures: ["ai_overview", "people_also_ask"],
          },
        }),
        q({
          query: "macro calculator",
          device: "desktop",
          bestRank: 1,
          bestUrl: "https://nosh.example/macros",
          composition: {
            top3Domains: ["nosh.example", "calculator.net", "healthline.com"],
            organicResults: 20,
            secondRank: 7,
            secondUrl: "https://nosh.example/macros/protein",
            serpFeatures: ["images", "related_searches"],
          },
        }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={composed} />);
    const row = container.querySelector('[data-serp-panel-query="macro calculator"]')!;
    const lanes = row.querySelectorAll("[data-serp-composition-device]");
    expect(lanes).toHaveLength(2);

    const phone = row.querySelector('[data-serp-composition-device="mobile"]')!;
    expect(phone.querySelector("[data-serp-top-three]")?.textContent).toMatch(
      /1calculator\.net.*2omnicalculator\.com.*3nosh\.example/,
    );
    expect(phone.querySelector("[data-serp-our-slots]")?.textContent).toContain(
      "Our slots 1",
    );
    expect(phone.querySelector("[data-serp-second-slot]")).toBeNull();
    expect(phone.querySelector("[data-serp-features]")?.textContent).toContain(
      "ai overview · people also ask",
    );

    const desktop = row.querySelector('[data-serp-composition-device="desktop"]')!;
    expect(desktop.querySelector("[data-serp-our-slots]")?.textContent).toContain(
      "Our slots 2",
    );
    expect(desktop.querySelector("[data-serp-second-slot]")?.textContent).toContain(
      "second #7 /macros/protein",
    );
    expect(row.textContent).not.toMatch(/moved|movement|new|arrived|takeover/i);
  });

  it("renders no empty neighborhood for a result page the provider could not read", () => {
    const unread: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({
          query: "unread term",
          bestRank: null,
          bestUrl: null,
          aioPresent: null,
          aioCitesUs: null,
          composition: null,
        }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={unread} />);
    const row = container.querySelector('[data-serp-panel-query="unread term"]')!;
    expect(row.querySelector("[data-serp-composition]")).toBeNull();
    expect(row.textContent).not.toMatch(/0 organic|our slots 0|top three/i);
  });

  it("makes a fresh partial panel amber without hiding its observed calls", () => {
    const partial: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({ query: "observed" }),
        q({
          query: "unknown",
          bestRank: null,
          bestUrl: null,
          aioPresent: null,
          aioCitesUs: null,
          providerStatus: "Internal SE Server Error.",
          providerAttempts: 1,
        }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={partial} />);
    const board = container.querySelector("[data-serp-panel]")!;
    expect(board).toHaveAttribute("data-serp-panel-degradation", "partial");
    expect(board.className).toContain("border-warn/65");
    expect(board.className).toContain("bg-warn/10");
    expect(container.querySelector("[data-serp-panel-coverage]")?.textContent).toContain(
      "1/2",
    );
    expect(container.querySelector("[data-serp-panel-call-failure]")).not.toBeNull();
    // Unknown is not outside depth: the page was never read.
    expect(container.querySelector("[data-serp-panel-unread]")?.textContent).toBe("—");
  });

  it("settles to pale yellow when multiple unknown calls exhaust three backed-off attempts", () => {
    const settled: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({ query: "observed" }),
        q({
          query: "unknown one",
          bestRank: null,
          bestUrl: null,
          aioPresent: null,
          aioCitesUs: null,
          providerStatus: "Internal SE Server Error.",
          providerAttempts: 2,
        }),
        q({
          query: "unknown two",
          bestRank: null,
          bestUrl: null,
          aioPresent: null,
          aioCitesUs: null,
          providerStatus: "Internal SE Server Error.",
          providerAttempts: 1,
        }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={settled} />);
    const board = container.querySelector("[data-serp-panel]")!;
    expect(board).toHaveAttribute("data-serp-panel-degradation", "settled");
    expect(board.className).toContain("border-warn/35");
    expect(board.className).toContain("bg-warn/5");
    expect(board.textContent).toContain("observed");
    expect(board.textContent).toContain("unknown one");
    expect(board.textContent).toContain("unknown two");
    expect(container.querySelector("[data-serp-panel-coverage]")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("after 3 attempts with exponential backoff"),
    );
  });

  it("keeps a partly-labelled panel's unlabelled terms in one trailing run", () => {
    // nom's cutover week: ro-282.2 chose no backfill, so its pre-label
    // collections have empty cells and a mixed panel is ordinary input.
    const mixed: SerpPanelSnapshot = {
      ...panel,
      queries: [
        q({ query: "calorie calculator", label: "Calculator seam", bestRank: 2 }),
        q({ query: "older term", bestRank: 5 }),
        q({ query: "macro calculator", label: "Calculator seam", bestRank: 9 }),
        q({ query: "another older term", bestRank: 1 }),
      ],
    };
    const { container } = render(<SerpPanelBoard panel={mixed} />);
    // One labelled cluster, then ONE trailing run — never a second named group.
    expect(clustersOf(container)).toEqual(["Calculator seam", ""]);
    expect(
      container.querySelectorAll("[data-serp-panel-cluster-line]"),
    ).toHaveLength(1);
    // The trailing run holds both unlabelled terms, rank-sorted like every
    // other run, and the labelled ones stay in their cluster.
    const runOf = (label: string) =>
      [
        ...container
          .querySelector(`[data-serp-panel-cluster="${label}"]`)!
          .querySelectorAll("[data-serp-panel-query]"),
      ].map((el) => el.getAttribute("data-serp-panel-query"));
    expect(runOf("Calculator seam")).toEqual(["calorie calculator", "macro calculator"]);
    expect(runOf("")).toEqual(["another older term", "older term"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bead ro-glf — one AI-Overview glyph, drawn twice, now extracted once.
//
// The per-surface tests above and below stay exactly where they are: they
// assert what each SURFACE says, and folding them into these would lose the
// only claim worth making about a shared component's callers. What is asserted
// HERE is the component's own contract, and above all the one behavioural
// difference the extraction had to keep rather than flatten.
// ─────────────────────────────────────────────────────────────────────────────
describe("AiOverviewGlyphs", () => {
  const marks = (root: Element | null) =>
    root === null
      ? []
      : [...root.querySelectorAll("[data-aio-state]")].map((el) => [
          el.getAttribute("data-aio-device"),
          el.getAttribute("data-aio-state"),
        ]);

  it("tells the three known states apart by weight, with no severity color", () => {
    const { container } = render(
      <AiOverviewGlyphs
        readings={[
          { device: "desktop", aioPresent: true, aioCitesUs: true },
          { device: "mobile", aioPresent: true, aioCitesUs: false },
          { device: "tablet", aioPresent: false, aioCitesUs: false },
        ]}
        unknownSurface="blank"
      />,
    );
    expect(marks(container)).toEqual([
      ["desktop", "cited"],
      ["mobile", "uncited"],
      ["tablet", "absent"],
    ]);
    // An AI Overview is a fact about the result page, not an alert (doc 14).
    expect(container.innerHTML).not.toMatch(/text-error|text-warn|text-info/);
  });

  it("holds the slot for an unanswered surface when the caller has a column to align to", () => {
    // SerpPanelBoard's case: the pair sits in a fixed row grid, and a collapsed
    // one would slide the desktop mark under the phone column.
    const { container } = render(
      <AiOverviewGlyphs
        readings={[
          { device: "mobile", aioPresent: null, aioCitesUs: null },
          { device: "desktop", aioPresent: true, aioCitesUs: true },
        ]}
        unknownSurface="blank"
      />,
    );
    const slots = [...container.querySelectorAll("[data-aio-device]")];
    expect(slots.map((el) => el.getAttribute("data-aio-device"))).toEqual([
      "mobile",
      "desktop",
    ]);
    // The held slot carries no state: it is the absence of an answer, and a
    // blank that claimed `absent` would be the unknown-as-no lie.
    expect(slots[0]).not.toHaveAttribute("data-aio-state");
    expect(slots[0]).toHaveAttribute(
      "title",
      expect.stringContaining("AI Overview unknown · did not load"),
    );
  });

  it("draws nothing for an unanswered surface when the caller has none", () => {
    // QueryVisibilityRankings' case: inline beside the decision chip, where an
    // empty span is a mark the reader has to account for.
    const { container } = render(
      <AiOverviewGlyphs
        readings={[
          { device: "mobile", aioPresent: null, aioCitesUs: null },
          { device: "desktop", aioPresent: true, aioCitesUs: true },
        ]}
        unknownSurface="omit"
      />,
    );
    expect(
      [...container.querySelectorAll("[data-aio-device]")].map((el) =>
        el.getAttribute("data-aio-device"),
      ),
    ).toEqual(["desktop"]);
  });

  it("still names the surviving surface when its partner went unanswered", () => {
    // The prefix comes off EVERY reading, not the drawn ones: "Desktop:" is
    // what tells the reader the other surface exists and is missing.
    const { container } = render(
      <AiOverviewGlyphs
        readings={[
          { device: "mobile", aioPresent: null, aioCitesUs: null },
          { device: "desktop", aioPresent: true, aioCitesUs: true },
        ]}
        unknownSurface="omit"
      />,
    );
    expect(container.querySelector("[data-aio-state]")).toHaveAttribute(
      "aria-label",
      "Desktop: AI Overview cites this site",
    );
  });

  it("draws one unprefixed mark for a term read on one surface", () => {
    const { container } = render(
      <AiOverviewGlyphs
        readings={[{ device: "desktop", aioPresent: true, aioCitesUs: true }]}
        unknownSurface="omit"
      />,
    );
    expect(container.querySelector("[data-aio-state]")).toHaveAttribute(
      "aria-label",
      "AI Overview cites this site",
    );
  });

  it("renders nothing at all when the panel does not cover the query", () => {
    // An empty reading list is unknown, never clear — and `omit` has no column
    // to hold, so the whole cell goes rather than an empty wrapper.
    const { container } = render(
      <AiOverviewGlyphs readings={[]} unknownSurface="omit" />,
    );
    expect(container.textContent).toBe("");
    expect(container.querySelector("[data-aio-devices]")).toBeNull();
  });
});

describe("kitchen sink covers the registry", () => {
  // doc 14 anti-duplication mechanic #2: the registry's promise is that every
  // entry has a rendered reference. These seven had entries and no demo, so a
  // token change could not be reviewed against them.
  it("renders the components that were missing from it", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <KitchenSinkRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    for (const title of [
      "SegmentBar",
      "PriorityBar",
      "ReportFreshness",
      "ExecutiveFindingsList",
      "QueryVisibilityRankings",
      "Drill",
      "FlagActions",
      "SnoozeUntil",
      "BacktestStrip",
      "TuneRate",
      "RuleTunePanel",
      "Table (shadcn primitives)",
      "SerpPanelBoard",
      "PageDecisions",
      "AiOverviewGlyphs",
      "Timeline",
      "Tabs",
      "TaskComposer / File task",
      "DataSourceIcons",
    ]) {
      expect(
        [...container.querySelectorAll("h2")].some((h) =>
          h.textContent?.startsWith(title),
        ),
      ).toBe(true);
    }
    // REGISTRY.md claims the populated fixture reaches every decision lane.
    // That claim is only worth writing down if something checks it.
    for (const kind of [
      "recover",
      "near-win",
      "ranking-opportunity",
      "organic-gap",
      "aio-walled",
      "mixed",
      "weak",
      "aio-champion",
      "strong",
      "growing",
      "watch",
    ]) {
      expect(
        container.querySelector(`[data-decision-kind="${kind}"]`),
      ).not.toBeNull();
    }
    // And the query row's filed states, which REGISTRY.md now also claims
    // (bead ro-5e8.3) — a filing marker nobody can review is a marker whose
    // weight and tone drift with the next token change.
    expect(
      container.querySelector('[data-decision-filed="open"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-decision-filed="closed"]'),
    ).not.toBeNull();
    // The page table makes the same claim on its own grain (bead ro-427).
    for (const kind of [
      "recover",
      "harvest",
      "aio-walled",
      "aio-champion",
      "shown-not-taken",
      "slipping",
      "growing",
      "watch",
    ]) {
      expect(
        container.querySelector(`[data-page-decision-kind="${kind}"]`),
      ).not.toBeNull();
    }
    expect(
      container.querySelector('[data-page-decision-filed="open"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-page-decision-filed="closed"]'),
    ).not.toBeNull();
    // This one test mounts the WHOLE gallery — every registry entry, every
    // chart, every live control — so it is the most expensive render in the
    // suite by a wide margin. It sits near two seconds warm and crosses the
    // 5s default on a cold transform or while the other workspaces are running
    // beside it, which made a green gate depend on machine load rather than on
    // the code. The render is the point of the test, so the timeout moves
    // rather than the coverage.
  }, 30_000);
});

// Bead ro-427. The page grain had cards and no verdicts: the one grain an
// operator actually edits was the one with no act/investigate/protect row.
describe("PageDecisions", () => {
  const asset = {
    id: "meals.example",
    displayName: "Meal Planner",
    domain: "meals.example",
  };

  const pageRow = (
    overrides: Partial<SearchPageMover> & Pick<SearchPageMover, "page" | "path">,
  ): SearchPageMover => ({
    currentClicks: 20,
    previousClicks: 20,
    clickDelta: 0,
    clickDeltaPercent: 0,
    currentImpressions: 1000,
    previousImpressions: 1000,
    impressionDelta: 0,
    impressionDeltaPercent: 0,
    currentPosition: 6,
    previousPosition: 6,
    positionImprovement: 0,
    // Above the ~2.1% cited-result benchmark the harvest rule reads, so the
    // default row is genuinely flat rather than quietly harvestable.
    currentCtr: 0.05,
    previousCtr: 0.05,
    leadingQuery: null,
    ...overrides,
  });

  /** The rationale reaches the operator through the copied handoff, not the
   * row — the same split the query table's tests assert against. */
  async function copiedMarkdown(pages: SearchPageTrends) {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      const { container } = render(
        <PageDecisions pages={pages} asset={asset} />,
      );
      fireEvent.click(
        container.querySelector(
          'button[aria-label^="Copy Markdown"]',
        ) as HTMLElement,
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      return String(writeText.mock.calls[0]?.[0]);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: original,
      });
    }
  }

  const pageTrends = (pages: SearchPageMover[]): SearchPageTrends => ({
    provider: "google",
    currentStart: "2026-06-29",
    currentEnd: "2026-07-05",
    previousStart: "2026-06-22",
    previousEnd: "2026-06-28",
    daysPerWindow: 7,
    pages,
    evidence: [
      {
        label: "Grounding queries excluded from the leading-query join",
        value: "0",
        detail: "No quoted-literal queries in this window.",
      },
    ],
    source: "gsc/page",
    caveat: "Search Console page exports are top rows.",
  });

  const HARVEST = pageRow({
    page: "https://meals.example/recipes",
    path: "/recipes",
    currentClicks: 5,
    previousClicks: 5,
    currentImpressions: 2000,
    currentCtr: 0.0025,
    previousCtr: 0.0025,
    currentPosition: 7,
    previousPosition: 7,
  });

  const withAio = (
    row: SearchPageMover,
    aioPresent: boolean | null,
    aioCitesUs: boolean | null,
  ): SearchPageMover => ({
    ...row,
    leadingQuery: {
      query: "free meal plans",
      impressions: 900,
      clicks: 2,
      position: 7,
      aioDevices: [{ device: "mobile", aioPresent, aioCitesUs }],
    },
  });

  const pageBead = (
    key: string,
    overrides: Partial<HandoffBead> = {},
  ): HandoffBead => ({
    kind: "page",
    key,
    beadId: "mp-page",
    status: "open",
    closedAt: null,
    ...overrides,
  });

  it("shows each page's filed bead and sinks filed rows below unfiled peers", () => {
    const openPage = "https://meals.example/recipes";
    const closedPage = "https://meals.example/guides";
    const untouchedPage = "https://meals.example/plans";
    const { container } = render(
      <PageDecisions
        pages={pageTrends([
          HARVEST,
          { ...HARVEST, page: closedPage, path: "/guides" },
          { ...HARVEST, page: untouchedPage, path: "/plans" },
        ])}
        asset={asset}
        handoffBeads={[
          pageBead(openPage),
          pageBead(closedPage, {
            beadId: "mp-shipped",
            status: "closed",
            closedAt: "2026-08-03T10:00:00.000Z",
          }),
          // Same key, wrong surface: it must not lend a page somebody else's
          // task marker.
          pageBead(untouchedPage, { kind: "query", beadId: "mp-query" }),
        ]}
      />,
      { wrapper: MemoryRouter },
    );

    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-page-decision-kind]"),
    ];
    expect(rows[0]?.textContent).toContain("/plans");
    expect(rows[0]?.dataset.pageDecisionFiled).toBeUndefined();

    const open = rows.find((row) => row.textContent?.includes("/recipes"))!;
    expect(open.dataset.pageDecisionFiled).toBe("open");
    expect(open.querySelector('[data-handoff-bead="open"]')?.textContent).toContain(
      "mp-page",
    );

    const closed = rows.find((row) => row.textContent?.includes("/guides"))!;
    expect(closed.dataset.pageDecisionFiled).toBe("closed");
    expect(
      closed.querySelector('[data-handoff-bead="closed"]')?.textContent,
    ).toContain("mp-shipped");
  });

  it("classifies each page into a lane with its own evidence and next step", () => {
    const { container, getByText } = render(
      <PageDecisions
        pages={pageTrends([
          pageRow({
            page: "https://meals.example/calculator",
            path: "/calculator",
            currentClicks: 21,
            previousClicks: 84,
            clickDelta: -63,
            clickDeltaPercent: -75,
            currentCtr: 0.0075,
            previousCtr: 0.03,
          }),
          HARVEST,
          pageRow({
            page: "https://meals.example/plan",
            path: "/plan",
            currentClicks: 60,
            previousClicks: 20,
            clickDelta: 40,
            clickDeltaPercent: 200,
            currentCtr: 0.06,
          }),
          pageRow({ page: "https://meals.example/about", path: "/about" }),
        ])}
        asset={asset}
      />,
    );

    const kinds = [...container.querySelectorAll("[data-page-decision-kind]")].map(
      (row) => row.getAttribute("data-page-decision-kind"),
    );
    expect(kinds).toEqual(["recover", "harvest", "growing", "watch"]);
    const recover = container.querySelector('[data-page-decision-kind="recover"]');
    expect(recover).toHaveAttribute("data-page-decision-tone", "loss");
    // Clicks fell at steady impressions and position: the result page changed,
    // and the CTR line is tagged as the likely cause (bead `ro-ujb9.96.6.8`).
    expect(recover).toHaveAttribute("data-page-decision-cause", "result-page");
    expect(recover?.textContent).toContain("Search it live; a new result is taking the clicks");
    expect(
      recover?.querySelector("[data-likely-cause]")?.closest("p")?.textContent,
    ).toContain("CTR:");
    const harvest = container.querySelector('[data-page-decision-kind="harvest"]');
    expect(harvest?.textContent).toContain("Shown, rarely clicked");
    expect(harvest?.textContent).toContain("Rewrite the title and opening answer");
    // The benchmark it was judged against sits beside the number it judged.
    expect(harvest?.textContent).toContain("typical 2.1%");
    // A flat page stays in the table rather than vanishing: flat is a finding.
    expect(
      container.querySelector('[data-page-decision-kind="watch"]')?.textContent,
    ).toContain("Nothing to do");
    // The lane's own statement about its series renders, including at zero.
    expect(
      getByText(/Grounding queries excluded from the leading-query join/),
    ).toBeTruthy();
  });

  // Bead `ro-ujb9.96.6.8`: the row infers where to look instead of asking the
  // operator to — ranking first, then demand, then a release inside the
  // window, then the result page — and tags that evidence line.
  it("names the likely cause of a click move on the evidence line behind it", () => {
    const loss = {
      currentClicks: 20,
      previousClicks: 60,
      clickDelta: -40,
      clickDeltaPercent: -66.7,
    };
    const { container } = render(
      <PageDecisions
        pages={pageTrends([
          pageRow({ page: "https://meals.example/a", path: "/a", ...loss, currentPosition: 8, previousPosition: 6, positionImprovement: -2 }),
          pageRow({ page: "https://meals.example/b", path: "/b", ...loss, clickDelta: -39, currentImpressions: 600, impressionDeltaPercent: -40 }),
          pageRow({ page: "https://meals.example/c", path: "/c", ...loss, clickDelta: -38 }),
          pageRow({ page: "https://meals.example/d", path: "/d", currentClicks: 60, previousClicks: 20, clickDelta: 40, clickDeltaPercent: 200 }),
        ])}
        asset={asset}
        annotations={{
          items: [
            { id: 2, at: "2026-07-02T17:00:00.000Z", kind: "deploy", ref: null, note: "Template refresh" },
            // Outside the current window: never a cause.
            { id: 1, at: "2026-06-20T17:00:00.000Z", kind: "deploy", ref: null, note: "Older" },
          ],
          olderCount: 0,
        }}
      />,
    );
    const row = (path: string) =>
      [...container.querySelectorAll<HTMLElement>("[data-page-decision-kind]")].find(
        (candidate) => candidate.textContent?.includes(path),
      )!;
    const tagged = (path: string) =>
      row(path).querySelector("[data-likely-cause]")?.closest("p")?.textContent ?? "";

    expect(row("/a")).toHaveAttribute("data-page-decision-cause", "ranking");
    expect(row("/a").textContent).toContain("Find what now outranks this page");
    expect(tagged("/a")).toContain("Average position:");

    expect(row("/b")).toHaveAttribute("data-page-decision-cause", "demand");
    expect(tagged("/b")).toContain("Impressions:");

    // Nothing page-specific explains /c, so the release in the window does.
    expect(row("/c")).toHaveAttribute("data-page-decision-cause", "release");
    expect(row("/c").textContent).toContain("Check what the Jul 2 release changed here");
    expect(tagged("/c")).toContain("Template refresh");
    expect(row("/c").textContent).not.toContain("Older");

    expect(row("/d")).toHaveAttribute("data-page-decision-kind", "growing");
    expect(row("/d").textContent).toContain("The Jul 2 release likely helped; repeat it");
  });

  it("applies the impression-harvest gate to a page walled by an AI Overview", () => {
    const { container } = render(
      <PageDecisions
        pages={pageTrends([withAio(HARVEST, true, false)])}
        asset={asset}
      />,
    );
    // The same page without a panel reading is an act-lane harvest row.
    expect(
      container.querySelector('[data-page-decision-kind="harvest"]'),
    ).toBeNull();
    const walled = container.querySelector(
      '[data-page-decision-kind="aio-walled"]',
    );
    expect(walled).toHaveAttribute("data-page-decision-tone", "investigate");
    expect(walled?.textContent).toContain("Walled by AI Overview");
    expect(walled?.textContent).toContain("See who the AI Overview cites before editing the title");
  });

  it("protects a page the overview cites, and changes nothing for an unknown one", async () => {
    const citedPages = pageTrends([
      withAio(
        pageRow({
          page: "https://meals.example/recipes",
          path: "/recipes",
          currentClicks: 5,
          previousClicks: 40,
          clickDelta: -35,
          clickDeltaPercent: -87.5,
        }),
        true,
        true,
      ),
    ]);
    const cited = render(
      <PageDecisions pages={citedPages} asset={asset} />,
    );
    // A -87.5% click loss would otherwise be the act-lane recover row.
    expect(
      cited.container.querySelector('[data-page-decision-kind="recover"]'),
    ).toBeNull();
    const champion = cited.container.querySelector(
      '[data-page-decision-kind="aio-champion"]',
    );
    expect(champion).toHaveAttribute("data-page-decision-tone", "positive");
    // The loss is not discarded: a cited page that is sliding defends the
    // citation now, rather than only keeping it.
    expect(champion?.textContent).toContain(
      "Recheck the citation now; keep the quoted passage",
    );
    expect(await copiedMarkdown(citedPages)).toContain(
      "Recheck the citation now; keep the quoted passage",
    );

    // An overview that did not load is UNKNOWN and must leave the verdict alone.
    const unknown = render(
      <PageDecisions
        pages={pageTrends([withAio(HARVEST, null, null)])}
        asset={asset}
      />,
    );
    expect(
      unknown.container.querySelector('[data-page-decision-kind="harvest"]'),
    ).not.toBeNull();
  });

  it("says nothing rather than showing an empty comparison without two weeks", () => {
    const { container, getByText } = render(
      <PageDecisions pages={null} asset={asset} />,
    );
    expect(container.querySelector("[data-page-decision-kind]")).toBeNull();
    expect(getByText("Needs two full weeks of Search Console data")).toBeTruthy();
  });

  // The same bead as a button (bead `ro-l1ed.4`), one per row, beside the copy.
  it("offers File task on every page row", () => {
    const { getAllByRole } = render(
      <PageDecisions
        pages={pageTrends([HARVEST, pageRow({ page: "https://meals.example/", path: "/" })])}
        asset={asset}
      />,
    );
    expect(getAllByRole("button", { name: /^File task for / })).toHaveLength(2);
    expect(
      getAllByRole("button", { name: "File task for /recipes" }),
    ).toHaveLength(1);
  });

  it("hands off a page decision as Markdown carrying its own key and limits", async () => {
    const markdown = await copiedMarkdown(
      pageTrends([withAio(HARVEST, true, false)]),
    );
    expect(markdown).toContain("# Page decision: /recipes");
    expect(markdown).toContain("- **What to do:** Investigate");
    expect(markdown).toContain("**Clicks:** 5 → 5");
    // The page URL is the key, because two assets can share a path.
    expect(markdown).toContain('"noticeos_kind":"page"');
    expect(markdown).toContain('"noticeos_key":"https://meals.example/recipes"');
    // The lane's own check travels with the copy, at zero as well.
    expect(markdown).toContain(
      "**Grounding queries excluded from the leading-query join:** 0",
    );
    expect(markdown).toContain("Search Console page exports are top rows.");
  });
});

/**
 * PHONE MODE — the responsive branches, pinned where layout cannot be measured
 * (bead `ro-md80`).
 *
 * jsdom has no layout, so these assert the CLASSES that decide the reflow —
 * exactly what `wall:fit`'s structural guards do for the TV, and for the same
 * reason: the real check is a 390px browser, and what a browser can regress
 * silently is a class somebody deleted while tidying.
 */
describe("phone mode — a wide table reflows instead of hiding its right half", () => {
  it("marks a stacked table and carries the rules that turn its rows into cards", () => {
    const { container } = render(
      <Table stacked>
        <TableBody>
          <TableRow>
            <TableCell label="Status">Onboarding</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = container.querySelector("table")!;
    expect(table.hasAttribute("data-stacked")).toBe(true);
    const classes = table.className;
    // the row becomes a card…
    expect(classes).toContain("@max-[40rem]:[&_tr]:block");
    // …the header goes, because every label it held is now on the cell…
    expect(classes).toContain("@max-[40rem]:[&_thead]:hidden");
    // …and the label is painted from the cell's own attribute.
    expect(classes).toContain("@max-[40rem]:[&_td[data-label]]:before:content-[attr(data-label)]");
    expect(container.querySelector("td")?.getAttribute("data-label")).toBe("Status");
    // The width measured is the table's own box, not the screen (bead
    // `ro-ujb9.169`), and that box scrolls only while it still has columns.
    expect(classes).not.toContain("max-sm:");
    const box = container.querySelector("[data-table-box]")!;
    expect(box.className).toContain("@container");
    expect(table.parentElement?.className).toContain("@min-[40rem]:overflow-x-auto");
  });

  it("leaves an unstacked table scrolling inside its own box, as it always did", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>Onboarding</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = container.querySelector("table")!;
    expect(table.hasAttribute("data-stacked")).toBe(false);
    expect(table.className).not.toContain("@max-[40rem]:");
    // The scroller is unconditional here; a stacked table only scrolls at `sm`.
    expect(container.firstElementChild?.className).toContain("overflow-x-auto");
    expect(container.querySelector("td")?.hasAttribute("data-label")).toBe(false);
  });

  // The reflow trades width for height, and a register with many rows spends it
  // all (bead `ro-c59x`): /financials measured 28,244px at 390×844 because 22
  // rows × 6 fields is 132 labelled lines. A folding row is one line until it is
  // asked for — and the DESK is untouched, which is what the `max-sm:` prefix on
  // the fold rule and the `sm:` prefix on the summary rule say.
  it("carries the rules that fold a stacked row down to its summary line", () => {
    const { container } = render(
      <Table stacked>
        <TableBody>
          <TableRow foldedWhenStacked>
            <TableCell onlyWhenStacked>fees.example</TableCell>
            <TableCell label="Paid (USD)" foldWhenStacked>
              36.32
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const classes = container.querySelector("table")!.className;
    // A folded row hides the cells that fold…
    expect(classes).toContain("@max-[40rem]:[&_tr[data-stack-fold]_td[data-fold]]:hidden");
    // …and the summary line it shows instead is gone from `sm` up, where the
    // header row and the columns already say it.
    expect(classes).toContain("@min-[40rem]:[&_td[data-stack-only]]:hidden");
    const cells = [...container.querySelectorAll("td")];
    expect(cells[0]?.hasAttribute("data-stack-only")).toBe(true);
    expect(cells[1]?.hasAttribute("data-fold")).toBe(true);
    expect(container.querySelector("tr")?.hasAttribute("data-stack-fold")).toBe(true);
  });

  it("leaves a row that is not folding unmarked, so nothing hides on a short table", () => {
    const { container } = render(
      <Table stacked>
        <TableBody>
          <TableRow>
            <TableCell label="Paid (USD)">36.32</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(container.querySelector("tr")?.hasAttribute("data-stack-fold")).toBe(false);
    expect(container.querySelector("td")?.hasAttribute("data-fold")).toBe(false);
  });
});

describe("phone mode — the tab strip scrolls, the page does not", () => {
  const SEVEN: TabSpec[] = [
    "overview",
    "growth",
    "alerts",
    "tasks",
    "activity",
    "sources",
    "settings",
  ].map((key, index) => ({
    key,
    to: index === 0 ? "/assets/a" : `/assets/a/${key}`,
    label: key,
    end: index === 0,
  }));

  const strip = (at = "/assets/a") =>
    render(
      <MemoryRouter initialEntries={[at]}>
        <Tabs label="Site sections" tabs={SEVEN} idBase="t" panelId="p" />
      </MemoryRouter>,
    ).container;

  it("keeps the seven tabs on one line that scrolls inside its own box", () => {
    const list = strip().querySelector('[role="tablist"]')!;
    expect(list.className).toContain("overflow-x-auto");
    // Wrapping is what put the selected tab's underline in mid-air two rows
    // above the divider; one scrolling line replaced it.
    expect(list.className).not.toContain("flex-wrap");
    expect(list.className).toContain("overscroll-x-contain");
  });

  it("hangs the divider on the wrapper so the scroller cannot clip it", () => {
    const wrapper = strip().querySelector("[data-tab-strip]")!;
    expect(wrapper.className).toContain("border-b");
    expect(wrapper.querySelector('[role="tablist"]')?.className).not.toContain("border-b");
  });

  it("gives every tab the phone's touch floor and keeps it from shrinking", () => {
    const tabs = [...strip().querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(7);
    for (const tab of tabs) {
      expect(tab.className).toContain("max-sm:min-h-11");
      expect(tab.className).toContain("shrink-0");
    }
  });

  it("still lights exactly the tab the URL names", () => {
    const selected = [...strip("/assets/a/sources").querySelectorAll('[role="tab"]')].filter(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    expect(selected.map((tab) => tab.textContent)).toEqual(["sources"]);
  });
});

describe("phone mode — the thumb floor the desk's densities are under", () => {
  it("raises every button size to 44px below `sm` and leaves the desk alone", () => {
    const { container } = render(
      <>
        <Button size="sm">Mark read</Button>
        <Button size="icon" aria-label="Open navigation" />
        <Button>Save</Button>
      </>,
    );
    const [small, icon, normal] = [...container.querySelectorAll("button")];
    expect(small!.className).toContain("h-8");
    expect(small!.className).toContain("max-sm:min-h-11");
    expect(icon!.className).toContain("size-9");
    expect(icon!.className).toContain("max-sm:size-11");
    expect(normal!.className).toContain("h-9");
    expect(normal!.className).toContain("max-sm:min-h-11");
  });

  /**
   * THE OWNER CHIP IS THE FIFTH THING (bead `ro-9smi`). `ro-md80` declared the
   * floor on buttons, fields, palette rows and nav rows; the chip is none of
   * those, which is how a 23px control on every file-owned section in the
   * product survived that sweep and `ro-khoy`'s. What is asserted here is the
   * SHAPE of the fix, because jsdom has no layout: the target and the drawn
   * chip are two elements, and the growth is given back to the row.
   */
  it("gives the owner chip a 44px box without redrawing the chip", () => {
    const { container } = render(<OwnerChip path="config/pull.json" />);
    const target = container.querySelector("button");
    expect(target?.className).toContain("max-sm:min-h-11");
    // Claimed, not added: the box grows, the row it sits in does not.
    expect(target?.className).toContain("max-sm:-my-2.5");
    // The chip is drawn INSIDE it, at the size it always had — a border, a
    // background and 11px type on the button itself would have grown with it.
    expect(target?.className).not.toContain("border-border");
    const chip = target?.firstElementChild;
    expect(chip?.className).toContain("border-border");
    expect(chip?.className).toContain("text-[11px]");
    expect(chip?.className).not.toContain("min-h-11");
    // Hover and focus still reach the chip rather than the empty box.
    expect(chip?.className).toContain("group-hover:bg-muted");
    expect(chip?.className).toContain("group-focus-visible:ring-ring");
  });

  /**
   * Bead `ro-ujb9.79`. `truncate` never truncated — nothing above the path could
   * shrink — so a long doc reference set the width of a whole phone-width row.
   * The chip is capped at its container and the path breaks anywhere; the
   * padding matches the negative margin so a wrapped, taller chip keeps its own
   * slot instead of drawing over the line above it.
   */
  it("wraps a long reference inside its container instead of widening it", () => {
    const path = "docs/11-integrations.md#microsoft-clarity-per-project-export-token-and-daily-quota";
    const { container } = render(<OwnerChip path={path} />);
    const target = container.querySelector("button")!;
    expect(target.className).toContain("max-w-full");
    expect(target.className).toContain("max-sm:py-2.5");
    const chip = target.firstElementChild!;
    expect(chip.className).toContain("min-w-0");
    expect(chip.className).toContain("max-w-full");
    const text = container.querySelector("[data-owner-chip-path]")!;
    expect(text.className).toContain("wrap-anywhere");
    expect(text.className).not.toContain("truncate");
    // The whole reference is there to read and to copy; nothing is elided.
    expect(text.textContent).toBe(path);
  });
});

/**
 * Bead `ro-ujb9.96.6.14`. A decision-owed alert printed the store's outcome
 * enum ("verdict: kill_confirmed") in its caption. The verdict is now the
 * pre-registered checks list's own chip — the same words and glyph — and the
 * "no decision recorded" state stays a chip beside it.
 */
describe("AlertRow — a decision-owed row names the verdict in plain words", () => {
  const ROW_NOW = Date.parse("2026-09-23T12:00:00.000Z");
  function owedFlag(verdict: string | null, decisionHome: string | null = null): FlagRecord {
    return {
      id: 41,
      firedAt: "2026-09-20T03:30:00.000Z",
      firstFiredAt: "2026-09-20T03:30:00.000Z",
      occurrences: 1,
      severity: "warn",
      kind: "anomaly",
      metric: "position",
      message: "watch window closed",
      ruleId: "watch-window-closed",
      ruleInputs: { outcome: verdict, metric: "position" },
      correlatedChanges: [],
      disposition: null,
      dispositionAt: null,
      dispositionNote: null,
      snoozeUntil: null,
      ackExpiry: null,
      resolvedAt: null,
      liveness: { state: "awaiting-decision", verdict, decisionHome },
    };
  }
  function renderRow(flag: FlagRecord) {
    return render(
      <AlertList label="Alerts">
        <AlertRow flag={flag} nowMs={ROW_NOW} assetId="nosh.example" />
      </AlertList>,
      { wrapper: MemoryRouter },
    );
  }

  it.each([
    ["kill_confirmed", "Decline confirmed", "▼"],
    ["ship_confirmed", "Improvement confirmed", "▲"],
    ["inconclusive", "No clear change", "="],
    ["unmeasurable", "Could not be measured", "?"],
  ])("shows %s as '%s' with its glyph, never the enum", (verdict, label, glyph) => {
    const { container } = renderRow(owedFlag(verdict));
    const owed = container.querySelector("[data-decision-owed]")!;
    expect(owed).toHaveTextContent(label);
    expect(owed).toHaveTextContent(glyph);
    expect(owed).toHaveTextContent("no decision recorded");
    expect(owed).not.toHaveTextContent(verdict);
    // No stored enum anywhere on the row: no snake_case token, no "verdict:".
    expect(container.textContent).not.toMatch(/[a-z]+_[a-z]+|verdict:/);
  });

  it("says a verdict was recorded when the store holds one the Tower has never heard of", () => {
    const { container } = renderRow(owedFlag("rolled_sideways"));
    const owed = container.querySelector("[data-decision-owed]")!;
    expect(owed).toHaveTextContent("Verdict recorded");
    expect(owed).not.toHaveTextContent("rolled_sideways");
  });

  it("names where the decision lives once one is recorded", () => {
    const { container } = renderRow(owedFlag("kill_confirmed", "ro-abc1"));
    const owed = container.querySelector("[data-decision-owed]")!;
    expect(owed).toHaveTextContent("decision: ro-abc1");
    expect(owed).not.toHaveTextContent("no decision recorded");
  });
});
