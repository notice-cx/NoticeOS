import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertHistoryPayload, AlertHistoryRow } from "@shared/alert-history";
import type { FlagRecord } from "@shared/asset-detail";
import type { WallPayload } from "@shared/wall";

// `/alerts`' Open | History switch (bead `ro-ju7f`).
//
// The wall read and the history read are both stubbed: what is under test is
// the PAGE — which view the URL selects, what each one states, and that a
// settled row carries the two things an asset page's own history cannot (which
// asset, and how long the alert stayed open). The read itself is asserted
// against the real schema in `alert-history.test.ts`.

const state = vi.hoisted(() => ({
  wall: null as WallPayload | null,
  history: null as AlertHistoryPayload | null,
  historyPending: false,
  historyError: null as Error | null,
  lastQuery: null as unknown,
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.wall, isPending: false, isError: false }),
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-09-04T12:00:00.000Z"),
}));

vi.mock("@/hooks/useAlertHistory", () => ({
  // The key FlagActions invalidates after every action (bead ro-ujb9.195).
  ALERT_HISTORY_KEY: ["alert-history"],
  useAlertHistory: (query: unknown) => {
    state.lastQuery = query;
    return {
      data: state.historyError ? undefined : state.history,
      isPending: state.historyPending,
      isError: state.historyError !== null,
      error: state.historyError ?? undefined,
    };
  },
}));

import { AlertsRoute } from "@/routes/AlertsRoute";
import { AlertHistoryPageError } from "@/lib/api";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function flag(overrides: Partial<FlagRecord> = {}): FlagRecord {
  return {
    id: 1,
    firedAt: at(9),
    firstFiredAt: at(9),
    occurrences: 1,
    severity: "warn",
    kind: "anomaly",
    metric: null,
    message: "Signups well below normal",
    ruleId: "rule-the-translator-does-not-know",
    ruleInputs: null,
    correlatedChanges: [],
    disposition: null,
    dispositionAt: null,
    dispositionNote: null,
    snoozeUntil: null,
    ackExpiry: null,
    resolvedAt: at(6),
    liveness: { state: "historical" },
    ...overrides,
  };
}

function row(
  overrides: Partial<FlagRecord> = {},
  asset: AlertHistoryRow["asset"] = {
    id: "meals.example",
    domain: "meals.example",
    displayName: "Meal Planner",
  },
): AlertHistoryRow {
  return { flag: flag(overrides), asset };
}

function history(
  rows: AlertHistoryRow[],
  over: Partial<AlertHistoryPayload> = {},
): AlertHistoryPayload {
  return {
    rows,
    total: rows.length,
    offset: 0,
    limit: 25,
    hasMore: false,
    generatedAt: "2026-09-04T12:00:00.000Z",
    ...over,
  };
}

/** Only the slices `/alerts` reads. Everything else is another page's business. */
function wall(): WallPayload {
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    portfolio: { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
      period: "2026-09",
      booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      netTrend: [],
      netTrendAll: [],
      trendGranularity: "monthly",
      bookedDelta: null,
      residue: {
        booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
        forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      },
      firstRun: true,
      daysIn: 1,
      periodIsCurrent: true,
    },
    system: {
      assetId: "root-os",
      hasPulse: true,
      spendTodayUsd: 1,
      dailyCapUsd: 2,
      ingest: { fresh: 2, stale: 0, notExpected: 0, expected: 2 },
      scheduledLanes: [],
    },
    dashboard: {
      countdown: { emoji: "🌁", label: "SF", targetAt: "2026-10-01T07:00:00.000Z" },
    },
    assets: [assetCard("meals.example", "Meal Planner"), assetCard("nosh.example", "Nosh")],
    attention: [],
    snoozed: [],
    operator: {
      waiting: 0,
      urgent: 0,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 1,
      capturedAt: "2026-09-04T11:59:30.000Z",
    },
    ledgerRecordedAt: null,
  };
}

function assetCard(id: string, displayName: string): WallPayload["assets"][number] {
  return { netByMonthCurrency: 'USD',
    id,
    displayName,
    status: "live",
    senseOnly: false,
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-09",
    pulseReceivedAt: "2026-09-04T11:00:00.000Z",
    firstReportAt: null,
    dataSources: [],
    activeUsers: {
      series: [],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    },
    work: null,
    panelReview: null,
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    latestPanelDate: null,
  };
}

/** Rendered through the real `/alerts/:tab?` shape, so the tab genuinely comes
 * off the URL rather than off a prop the test invented. */
function renderAlerts(url: string) {
  state.wall = wall();
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/alerts/:tab?" element={<AlertsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  state.wall = null;
  state.history = null;
  state.historyPending = false;
  state.historyError = null;
  state.lastQuery = null;
});

describe("/alerts — the Open | History switch", () => {
  it("makes the view the URL, with Open as the bare path", () => {
    renderAlerts("/alerts");

    const tabs = screen.getByRole("tablist", { name: "Alert views" });
    const open = within(tabs).getByRole("tab", { name: "Open" });
    const settled = within(tabs).getByRole("tab", { name: "History" });

    expect(open).toHaveAttribute("aria-selected", "true");
    expect(open).toHaveAttribute("href", "/alerts");
    expect(settled).toHaveAttribute("aria-selected", "false");
    expect(settled).toHaveAttribute("href", "/alerts/history");
  });

  it("selects History from the URL segment", () => {
    state.history = history([]);
    renderAlerts("/alerts/history");

    const tabs = screen.getByRole("tablist", { name: "Alert views" });
    expect(within(tabs).getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The sentence that used to sit under the title is in the About with the
    // rest of the prose (doc 14 principle 3, bead `ro-78qo.7`); what says which
    // view this is, is the selected tab.
    expect(within(tabs).getByRole("tab", { name: "Open" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  /** A mistyped tab is still the page the operator asked for. It lands on Open
   * AND the URL is corrected to say so, because `Tabs` matches on the path —
   * left alone, `/alerts/nonsense` would render Open under a bar with nothing
   * selected. */
  it("canonicalises a tab nobody built back to Open", () => {
    renderAlerts("/alerts/nonsense");

    expect(
      screen.getByRole("tab", { name: "Open" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("All clear.")).toBeInTheDocument();
  });

  it("keeps the filters while it corrects a mistyped tab", () => {
    renderAlerts("/alerts/nonsence?asset=nosh.example");

    expect(screen.getByLabelText("Site")).toHaveValue("nosh.example");
  });

  it("keeps the Open view's filters working under the tabs", () => {
    renderAlerts("/alerts?asset=nosh.example&severity=error");

    expect(screen.getByLabelText("Site")).toHaveValue("nosh.example");
    expect(screen.getByLabelText("Severity")).toHaveValue("error");
    // Nothing matches, and the page says so as an empty state rather than as a
    // zero beside the filters — the strip above owns the portfolio's counts.
    expect(
      screen.getByText("No open alerts match these filters"),
    ).toBeInTheDocument();
  });

  /** "What is open for this asset" and "what closed for this asset" are one
   * question asked twice (bead `ro-clz8`), so the narrowing crosses the switch
   * rather than costing three clicks on the far side. */
  it("hands the asset and severity narrowing from Open to History", () => {
    state.history = history([]);
    renderAlerts("/alerts?asset=nosh.example&severity=error");

    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "href",
      "/alerts/history?asset=nosh.example&severity=error",
    );

    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Site")).toHaveValue("nosh.example");
    expect(screen.getByLabelText("Severity")).toHaveValue("error");
  });

  it("hands it back from History to Open", () => {
    state.history = history([]);
    renderAlerts("/alerts/history?asset=nosh.example&severity=error");

    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute(
      "href",
      "/alerts?asset=nosh.example&severity=error",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Open" }));

    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Site")).toHaveValue("nosh.example");
    expect(screen.getByLabelText("Severity")).toHaveValue("error");
  });

  /** A tab carries only what the destination can honour. Anything else arrives
   * as a `<select>` sitting on a value that is not one of its options. */
  it("drops the kind filter History has no answer for", () => {
    renderAlerts("/alerts?asset=nosh.example&kind=anomaly");

    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "href",
      "/alerts/history?asset=nosh.example",
    );
  });

  it("drops an info severity Open's list can never hold", () => {
    state.history = history([]);
    renderAlerts("/alerts/history?asset=nosh.example&severity=info");

    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute(
      "href",
      "/alerts?asset=nosh.example",
    );
  });

  it("leaves History's page number behind", () => {
    state.history = history([], { offset: 25 });
    renderAlerts("/alerts/history?asset=nosh.example&offset=25");

    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute(
      "href",
      "/alerts?asset=nosh.example",
    );
  });
});

describe("/alerts/history — what already closed", () => {
  it("renders a row per settled alert, naming its asset and linking to its Alerts tab", () => {
    state.history = history([
      row({ id: 11 }),
      row({ id: 12, message: "Search clicks fell off a cliff" }, {
        id: "nosh.example",
        domain: "nosh.example",
        displayName: "Nosh",
      }),
    ]);
    renderAlerts("/alerts/history");

    expect(screen.getByText("Signups well below normal")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Meal Planner/ })).toHaveAttribute(
      "href",
      "/assets/meals.example/alerts",
    );
    expect(screen.getByRole("link", { name: /Nosh/ })).toHaveAttribute(
      "href",
      "/assets/nosh.example/alerts",
    );
  });

  // `ro-hou2`: the asset link's accessible name is the asset, exactly. The
  // favicon beside it used to carry `title="Meal Planner favicon"`, which joined the
  // link's name (accname step 2I) and made a screen reader say the identity
  // twice, the second time with the word "favicon" in it.
  it("names the asset link by the asset alone, not by its favicon", () => {
    state.history = history([row({ id: 11 })]);
    renderAlerts("/alerts/history");

    expect(screen.getByRole("link", { name: "Meal Planner" })).toHaveAttribute(
      "href",
      "/assets/meals.example/alerts",
    );
    expect(screen.queryByTitle(/favicon/i)).toBeNull();
  });

  // Bead `ro-ujb9.96.6.7`: one status per subject. A settled row's caption is
  // its disposition; "Recorded closed" beside it was the same closure twice. It
  // survives in the Evidence panel, where it says recovery was not checked.
  it("states a settled row's closure once, as its disposition", () => {
    state.history = history([row({
      id: 11, disposition: "ack", dispositionAt: at(6),
      verification: { state: "recorded-closed", source: null, lastConfirmedAt: null, lastEvaluatedAt: null, reason: "recorded-closed" },
    })]);
    renderAlerts("/alerts/history");

    const line = screen.getByText("Signups well below normal").closest("li")!;
    expect(line).toHaveTextContent("Acknowledged");
    expect(line).not.toHaveTextContent("Recorded closed");
    fireEvent.click(within(line).getByRole("button", { expanded: false }));
    fireEvent.click(within(line).getByRole("button", { name: /^Why this fired/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Recorded closed");
    expect(screen.getByRole("dialog")).toHaveTextContent("recovery not checked");
  });

  it("carries no lifecycle actions — a settled alert has nothing left to do", () => {
    state.history = history([row()]);
    renderAlerts("/alerts/history");

    expect(screen.queryByRole("button", { name: "Mark alert read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve alert" })).toBeNull();
  });

  it("shows resolution without a future snooze countdown in an expanded history row", () => {
    state.history = history([row({
      disposition: "snooze",
      dispositionAt: at(2),
      dispositionNote: "Check after the campaign",
      snoozeUntil: at(-3),
      resolvedAt: at(1),
    })]);
    renderAlerts("/alerts/history");

    const line = screen.getByText("Signups well below normal").closest("li")!;
    fireEvent.click(within(line).getByRole("button", { expanded: false }));
    expect(line).toHaveTextContent("resolved 1d ago");
    expect(line).toHaveTextContent("Check after the campaign");
    expect(line).not.toHaveTextContent("quiet until");
    expect(line.querySelector('[data-snooze-state="active"]')).toBeNull();
  });

  /** doc 14's 2026-09-04 rule: the duration is the fact neither date states,
   * and the operator's question over a list of closed alerts is which of them
   * dragged on. */
  it("shows how long each alert stayed open as a glyph and a duration", () => {
    state.history = history([
      row({ id: 11, firedAt: at(9), firstFiredAt: at(9), resolvedAt: at(6) }),
      row({ id: 12, firedAt: at(2), firstFiredAt: at(2), resolvedAt: at(2) }),
    ]);
    const { container } = renderAlerts("/alerts/history");

    const spans = [...container.querySelectorAll("[data-alert-open-span]")].map(
      (el) => el.getAttribute("data-alert-open-span"),
    );
    expect(spans).toEqual(["3d", "0s"]);
    // The glyph carries its own accessible name; the bar is not color-only.
    expect(
      screen.getByRole("img", { name: "Open for 3d" }),
    ).toBeInTheDocument();
  });

  it("draws no span at all when nothing recorded a closing time", () => {
    state.history = history([
      row({ id: 13, disposition: "tune", dispositionAt: null, resolvedAt: null }),
    ]);
    const { container } = renderAlerts("/alerts/history");

    expect(container.querySelector("[data-alert-open-span]")).toBeNull();
    expect(screen.getByText("Rule tuned")).toBeInTheDocument();
  });

  it("reads its filters from the URL and hands them to the read", () => {
    state.history = history([row()]);
    renderAlerts("/alerts/history?asset=nosh.example&severity=error");

    expect(screen.getByLabelText("Site")).toHaveValue("nosh.example");
    expect(screen.getByLabelText("Severity")).toHaveValue("error");
    expect(state.lastQuery).toMatchObject({ asset: "nosh.example", severity: "error" });
  });

  it("offers Info, which the open list never can", () => {
    state.history = history([]);
    renderAlerts("/alerts/history");

    const options = within(screen.getByLabelText("Severity"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Any severity", "Errors", "Warnings", "Info"]);
  });

  it("sends a filter change back to the first page", () => {
    state.history = history([row()], { offset: 50, total: 60, hasMore: true });
    renderAlerts("/alerts/history?offset=50");

    fireEvent.change(screen.getByLabelText("Site"), {
      target: { value: "nosh.example" },
    });

    expect(state.lastQuery).toMatchObject({ asset: "nosh.example", offset: 0 });
  });

  it("states which slice of what, once", () => {
    state.history = history(
      [row({ id: 21 }), row({ id: 22 })],
      { offset: 25, total: 60, hasMore: true },
    );
    const { container } = renderAlerts("/alerts/history?offset=25");

    expect(container.querySelector("[data-history-range]")!.textContent).toBe(
      "26–27 of 60 settled",
    );
  });

  it("pages by offset, and the first page cannot go back", () => {
    state.history = history([row()], { offset: 0, total: 60, hasMore: true });
    renderAlerts("/alerts/history");

    expect(screen.getByRole("button", { name: "Newer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(state.lastQuery).toMatchObject({ offset: 25 });
  });

  it("hides the pager entirely when one page is the whole list", () => {
    state.history = history([row()]);
    const { container } = renderAlerts("/alerts/history");

    expect(container.querySelector("[data-history-pager]")).toBeNull();
  });

  it("never calls a filtered blank an empty archive", () => {
    state.history = history([], { total: 0 });
    renderAlerts("/alerts/history?asset=nosh.example");

    expect(
      screen.getByText("No settled alerts match these filters"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No settled alerts yet")).toBeNull();
  });

  it("states the honest empty when nothing has ever settled", () => {
    state.history = history([], { total: 0 });
    renderAlerts("/alerts/history");

    expect(screen.getByText("No settled alerts yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "An alert appears here once it has been resolved or acknowledged.",
      ),
    ).toBeInTheDocument();
  });

  it("says the read failed rather than showing an empty archive", () => {
    state.historyError = new Error("GET /api/alerts/history failed: 500");
    renderAlerts("/alerts/history");

    // The desk's one failure state (bead ro-ujb9.218).
    expect(screen.getByText("Couldn't load alert history")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("No settled alerts yet")).toBeNull();
  });

  it("names a page it cannot read rather than quietly showing page one", () => {
    // Bead `ro-oefa`. Page one of the archive looks the same however the reader
    // got there, so an operator who shared "page 4" and got page 1 back had no
    // way to see that anything was dropped.
    state.historyError = new AlertHistoryPageError(400, 137, 25);
    state.history = history([row()], { total: 137, offset: 75 });
    renderAlerts("/alerts/history?offset=nonsense");

    expect(
      screen.getByText("“nonsense” is not a page of this archive"),
    ).toBeInTheDocument();
    // The archive's size in figures, not a paragraph about paging.
    expect(screen.getByText("137 settled · 25 per page")).toBeInTheDocument();
    // The range badge would be describing a page that does not exist — and with
    // `keepPreviousData` its numbers are the LAST GOOD page's.
    expect(screen.queryByText(/of 137 settled/)).toBeNull();
    expect(screen.queryByText("Couldn't load alert history")).toBeNull();
  });

  it("offers the first page as the way out, dropping both page params", () => {
    state.historyError = new AlertHistoryPageError(400, 4, 25);
    renderAlerts("/alerts/history?asset=nosh.example&offset=nonsense&limit=abc");

    fireEvent.click(screen.getByRole("button", { name: "First page" }));

    // The narrowing the operator chose survives; only the page does not.
    expect(state.lastQuery).toMatchObject({
      asset: "nosh.example",
      offset: 0,
      malformed: null,
    });
  });
});
