import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertHistoryRow } from "@shared/alert-history";
import type { AttentionItem, SnoozedItem, WallPayload } from "@shared/wall";

const state = vi.hoisted(() => ({
  data: null as WallPayload | null,
  isPending: false,
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.data, isPending: state.isPending, isError: false }),
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-08-01T12:00:00.000Z"),
}));

// The strip reads one page of the settled archive for its "Settled · 7d"
// figure; the History view reads it with its own query. One stand-in serves
// both, and `history.data` is what each test sets.
const history = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
}));

vi.mock("@/hooks/useAlertHistory", () => ({
  // The key FlagActions invalidates after every action.
  ALERT_HISTORY_KEY: ["alert-history"],
  useAlertHistory: () => ({
    data: history.data,
    isPending: history.data === undefined,
    isError: history.isError,
    error: null,
  }),
}));

import { AlertsRoute } from "@/routes/AlertsRoute";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

/** An open flag whose rule the translator has never heard of, so the headline
 * is the store's own message. */
function alert(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 1,
    asset: "meals.example",
    assetDisplayName: "Meal Planner",
    severity: "warn",
    kind: "anomaly",
    message: "Signups well below normal",
    firedAt: "2026-08-01T09:00:00.000Z",
    metric: null,
    ruleId: "rule-the-translator-does-not-know",
    ruleInputs: null,
    correlatedChanges: [],
    occurrences: 1,
    firstFiredAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

/** One row of the settled archive, closed on the given day. Only the two dates
 * the strip reads are meaningful; the rest is a valid `FlagRecord` so the
 * History view could render it unchanged. */
function settledRow(id: number, resolvedAt: string): AlertHistoryRow {
  return {
    flag: {
      id,
      firedAt: "2026-07-01T09:00:00.000Z",
      firstFiredAt: "2026-07-01T09:00:00.000Z",
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
      resolvedAt,
      liveness: { state: "historical" },
      occurrences: 1,
    },
    asset: { id: "meals.example", domain: "meals.example", displayName: "Meal Planner" },
  };
}

/** Only the slices `/alerts` reads: the flags and the asset names its filter
 * offers. Everything else on the payload is another page's business. */
function payload(attention: AttentionItem[], snoozed: SnoozedItem[] = []): WallPayload {
  return {
    generatedAt: "2026-08-01T12:00:00.000Z",
    portfolio: { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
      period: "2026-08",
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
      countdown: { emoji: "🌁", label: "SF", targetAt: "2026-09-01T07:00:00.000Z" },
    },
    assets: [
      assetCard("meals.example", "Meal Planner"),
      assetCard("areas.example", "Areas"),
    ],
    attention,
    snoozed,
    operator: {
      waiting: 0,
      urgent: 0,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 1,
      capturedAt: "2026-08-01T11:59:30.000Z",
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
    netPeriod: "2026-08",
    pulseReceivedAt: "2026-08-01T11:00:00.000Z",
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

function renderAlerts(
  attention: AttentionItem[],
  url = "/alerts",
  snoozed: SnoozedItem[] = [],
) {
  state.data = payload(attention, snoozed);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <AlertsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  state.data = null;
  state.isPending = false;
  history.data = undefined;
  history.isError = false;
});

/** The page's one sentence: how many are open and how bad. */
function answer(container: HTMLElement): string {
  const found = container.querySelector<HTMLElement>("[data-alerts-answer] h2");
  if (found === null) throw new Error("no answer line on the page");
  return found.textContent ?? "";
}

/** One figure beside the answer, by its mark. */
function figure(container: HTMLElement, mark: string): string | null {
  return container.querySelector<HTMLElement>(`[data-${mark}] dd`)?.textContent ?? null;
}

/** Open the row whose line matches, the way an operator does: the verbs are
 * inside the row and never printed under it. */
function openRow(name: RegExp | string): HTMLElement {
  const row = screen.getByRole("button", { name });
  fireEvent.click(row);
  return row.closest("li") as HTMLElement;
}

describe("/alerts — the portfolio's open exceptions", () => {
  it('links filed open and closed tasks inside the alert without changing its severity', () => {
    renderAlerts([alert({ handoffBeads: [
      { kind: 'alert', key: '1', beadId: 'mp-repair', status: 'open', closedAt: null },
      { kind: 'alert', key: '1', beadId: 'mp-review', status: 'closed', closedAt: '2026-07-31T12:00:00.000Z' },
    ] })]);
    const row = openRow(/Signups well below normal/);
    const open = within(row).getByRole('link', { name: 'Filed as work, still open, task mp-repair' });
    expect(open).toHaveAttribute('href', '/tasks/mp-repair');
    expect(open.closest('button')).toBeNull();
    const closed = within(row).getByRole('link', { name: 'Task recorded closed; outcome not verified, task mp-review' });
    expect(closed).toHaveAttribute('href', '/tasks/mp-review');
    expect(row.querySelector('[data-handoff-bead="closed"]')).not.toHaveClass('text-healthy');
    expect(within(row).getByRole('button', { name: 'Resolve alert' })).toBeInTheDocument();
  });

  it.each([undefined, []])('shows no task marker without a recorded handoff (%j)', (handoffBeads) => {
    renderAlerts([alert({ handoffBeads })]);
    const row = openRow(/Signups well below normal/);
    expect(row.querySelector('[data-handoff-bead]')).toBeNull();
    expect(within(row).getByRole('button', { name: /^File task for/ })).toBeInTheDocument();
  });
  it("gives each alert one line, with Snooze and Resolve on the row and the rest behind it", () => {
    const { container } = renderAlerts([
      alert(),
      alert({
        id: 2,
        asset: "areas.example",
        assetDisplayName: "Areas",
        severity: "error",
        message: "Clicks fell off a cliff",
      }),
    ]);

    expect(screen.getByRole("heading", { level: 1, name: "Alerts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark alert read" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Resolve alert" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Snooze alert" })).toHaveLength(2);
    expect(answer(container)).toBe("2 open alerts, 1 error");

    const row = openRow(/Signups well below normal/);
    expect(within(row).getByRole("button", { name: "Mark alert read" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Snooze alert" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Resolve alert" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /^File task for/ })).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open Meal Planner" })).toHaveAttribute(
      "href",
      "/assets/meals.example",
    );
    expect(screen.getAllByRole("button", { name: "Mark alert read" })).toHaveLength(1);
  });

  it("reads its filters from the URL, so a filtered view is a link", () => {
    const { container } = renderAlerts(
      [
        alert(),
        alert({ id: 2, asset: "areas.example", assetDisplayName: "Areas", severity: "error", message: "Clicks fell off a cliff" }),
      ],
      "/alerts?asset=areas.example",
    );

    expect(screen.getByText("Clicks fell off a cliff")).toBeInTheDocument();
    expect(screen.queryByText("Signups well below normal")).toBeNull();
    // The strip stays portfolio-wide; the panel says what a filter left on screen.
    expect(answer(container)).toBe("2 open alerts, 1 error");
    expect(screen.getByText("1 of 2 open")).toBeInTheDocument();
    expect(screen.getByLabelText("Site")).toHaveValue("areas.example");
  });

  it("narrows by severity and kind from the same query string", () => {
    renderAlerts(
      [
        alert({ id: 1, severity: "error", kind: "anomaly", message: "An error anomaly" }),
        alert({ id: 2, severity: "warn", kind: "anomaly", message: "A warning anomaly" }),
        alert({ id: 3, severity: "error", kind: "opportunity", message: "An error opportunity" }),
      ],
      "/alerts?severity=error&kind=anomaly",
    );

    expect(screen.getByText("An error anomaly")).toBeInTheDocument();
    expect(screen.queryByText("A warning anomaly")).toBeNull();
    expect(screen.queryByText("An error opportunity")).toBeNull();
  });

  /** The Open list holds warnings and errors only, and a milestone is always
   * info-severity, so "Milestones" could only ever empty the list. */
  it("offers only the kinds an open row can be, and reads an old milestone link as every kind", () => {
    renderAlerts(
      [
        alert({ id: 1, kind: "anomaly", message: "A warning anomaly" }),
        alert({ id: 2, kind: "opportunity", message: "A warning opportunity" }),
      ],
      "/alerts?kind=milestone",
    );

    const kind = screen.getByLabelText("Kind") as HTMLSelectElement;
    expect([...kind.options].map((option) => option.textContent)).toEqual([
      "Any kind",
      "Anomalies",
      "Opportunities",
    ]);
    expect(kind).toHaveValue("all");
    expect(screen.getByText("A warning anomaly")).toBeInTheDocument();
    expect(screen.getByText("A warning opportunity")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ of \d+ open$/)).toBeNull();
  });

  it("narrows the page when the operator picks a filter", () => {
    renderAlerts([
      alert(),
      alert({ id: 2, asset: "areas.example", assetDisplayName: "Areas", message: "Clicks fell off a cliff" }),
    ]);

    fireEvent.change(screen.getByLabelText("Site"), {
      target: { value: "areas.example" },
    });

    expect(screen.getByText("Clicks fell off a cliff")).toBeInTheDocument();
    expect(screen.queryByText("Signups well below normal")).toBeNull();
  });

  // The never-reported row stands for four assets and carries each of their
  // actions, so filtering to one of them must not hide it.
  it("keeps a cross-asset row when the filter picks any asset it stands for", () => {
    renderAlerts([
      alert({
        id: 7,
        asset: "fees.example",
        assetDisplayName: "Fee Codes",
        severity: "error",
        ruleId: "ingest-freshness",
        ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
        occurrences: 2,
        members: [
          { id: 7, asset: "fees.example", assetDisplayName: "Fee Codes", firedAt: "2026-07-05T09:00:00.000Z" },
          { id: 8, asset: "areas.example", assetDisplayName: "Areas", firedAt: "2026-07-06T09:00:00.000Z" },
        ],
      }),
    ]);

    fireEvent.change(screen.getByLabelText("Site"), {
      target: { value: "areas.example" },
    });

    expect(screen.getByText("Two sites have no nightly reports")).toBeInTheDocument();
    expect(screen.queryByText("No open alerts match these filters")).toBeNull();
  });

  /** The sidebar and the command palette open a site with no number yet on
   * its Data sources; these links must agree. */
  it("opens a site where the nav does, and builds every site link with the id encoded", () => {
    const firstNumberYet = { ...assetCard("meals.example", "Meal Planner"), pulseReceivedAt: null };
    state.data = {
      ...payload([
        alert({
          correlatedChanges: [
            { id: 3, at: "2026-08-01T08:00:00.000Z", kind: "deploy", ref: "abc1234", note: "shipped" },
          ],
        }),
        alert({
          id: 7,
          asset: "areas.example",
          assetDisplayName: "Areas",
          ruleId: "ingest-freshness",
          ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
          occurrences: 2,
          members: [
            { id: 7, asset: "areas.example", assetDisplayName: "Areas", firedAt: "2026-07-05T09:00:00.000Z" },
            { id: 8, asset: "meals.example", assetDisplayName: "Meal Planner", firedAt: "2026-07-06T09:00:00.000Z" },
          ],
        }),
      ]),
      assets: [firstNumberYet, assetCard("areas.example", "Areas")],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/alerts"]}>
          <AlertsRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const row = openRow(/Signups well below normal/);
    expect(within(row).getByRole("link", { name: "Open Meal Planner" }))
      .toHaveAttribute("href", "/assets/meals.example/sources");
    expect(within(row).getByRole("link", { name: /config|deploy|before/i }))
      .toHaveAttribute("href", "/assets/meals.example#timeline");

    // Areas has reported, so its Overview; Meal Planner has not, so its Data sources.
    const grouped = openRow(/Two sites have no nightly reports/);
    expect(within(grouped).getByRole("link", { name: "Areas" }))
      .toHaveAttribute("href", "/assets/areas.example");
    expect(within(grouped).getByRole("link", { name: "Meal Planner" }))
      .toHaveAttribute("href", "/assets/meals.example/sources");
  });

  it("never calls a filtered blank an all-clear", () => {
    renderAlerts([alert()], "/alerts?asset=areas.example");

    expect(
      screen.getByText("No open alerts match these filters"),
    ).toBeInTheDocument();
    expect(screen.queryByText("All clear.")).toBeNull();
  });

  it("states the all-clear when nothing at all is open", () => {
    const { container } = renderAlerts([]);

    expect(answer(container)).toBe("No open alerts");
    expect(container.querySelector('[data-finish-line="quiet"]')).toHaveTextContent("All clear.");
    expect(container.querySelector("[data-kpi]")).toBeNull();
  });

  it("distinguishes an old first detection from a recent confirmation without nesting controls", () => {
    const { container } = renderAlerts([alert({
      firstFiredAt: "2026-07-01T09:00:00.000Z",
      verification: {
        state: "confirmed", lastConfirmedAt: "2026-08-01T09:00:00.000Z",
        lastEvaluatedAt: "2026-08-01T09:00:00.000Z", source: "Nightly report", reason: "report-still-flags",
      },
    })]);
    const row = screen.getByText("Signups well below normal").closest("li")!;
    expect(row).toHaveTextContent("Confirmed 3h ago");
    expect(row).toHaveTextContent("first seen");
    expect(row.querySelector("button button")).toBeNull();
    expect(container.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
  });

  /** Everything checkable is one press away in the Evidence panel: the rule's
   * numbers, then the checks, said once. */
  it("opens onto one Evidence panel holding the numbers and the checks, said once", () => {
    renderAlerts([alert({
      firstFiredAt: "2026-07-01T09:00:00.000Z",
      ruleId: "flow-poisson-low",
      metric: "signups",
      message: "22 in last24h (avg7d 39.3, P(<=22)~=0.0020)",
      ruleInputs: { metric: "signups", observed: 22, baselinePerDay: 39.3, pLowerTail: 0.002, alpha: 0.01 },
      verification: {
        state: "unverified", lastConfirmedAt: "2026-07-20T09:00:00.000Z",
        lastEvaluatedAt: "2026-07-20T09:00:00.000Z", source: "Central metric rule", reason: "confirmation-stale",
      },
    })]);
    const row = openRow(/Signups well below normal/);
    const body = row.querySelector("[data-list-row-body]") as HTMLElement;
    expect(body.textContent).not.toContain("Last known");
    expect(within(body).queryByRole("button", { name: "Alert verification details" })).toBeNull();
    fireEvent.click(within(body).getByRole("button", { name: /^Why this fired/ }));
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveTextContent("Arrived");
    expect(panel).toHaveTextContent(/First seen\s*·/);
    expect(panel).toHaveTextContent(/Last confirmed\s*·/);
    expect(panel).toHaveTextContent("Central metric rule");
    expect(panel).toHaveTextContent("Last check is past its freshness window");
    expect(panel.querySelector("p")).toBeNull();
    expect(panel.textContent).not.toContain("avg7d");
    expect(body.textContent).not.toContain("avg7d");
  });

  it("keeps unverified and legacy alerts visible as last known, not newly confirmed", () => {
    renderAlerts([alert(), alert({
      id: 2, message: "Old check needs verification",
      verification: {
        state: "unverified", lastConfirmedAt: "2026-07-01T09:00:00.000Z",
        lastEvaluatedAt: "2026-07-01T09:00:00.000Z", source: "Daily hygiene check", reason: "confirmation-stale",
      },
    })]);
    for (const headline of ["Signups well below normal", "Old check needs verification"]) {
      const row = screen.getByText(headline).closest("li")!;
      expect(row).toHaveTextContent("Last known");
      expect(row).not.toHaveTextContent("Confirmed");
    }
    expect(screen.queryByText("All clear")).toBeNull();
  });

  it("keeps each grouped asset's verification separate from the group's last-known summary", () => {
    const confirmed = {
      state: "confirmed" as const, lastConfirmedAt: "2026-08-01T09:00:00.000Z",
      lastEvaluatedAt: "2026-08-01T09:00:00.000Z", source: "Report status", reason: "source-confirms" as const,
    };
    renderAlerts([alert({
      ruleId: "ingest-freshness", ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
      occurrences: 2,
      verification: { ...confirmed, state: "unverified", lastConfirmedAt: null, reason: "mixed-states" },
      members: [
        { id: 7, asset: "fees.example", assetDisplayName: "Fee Codes", firedAt: "2026-07-05T09:00:00.000Z", verification: confirmed },
        { id: 8, asset: "areas.example", assetDisplayName: "Areas", firedAt: "2026-07-06T09:00:00.000Z" },
      ],
    })]);
    const row = screen.getByText("Two sites have no nightly reports").closest("li")!;
    expect(row).toHaveTextContent("Last known");
    fireEvent.click(within(row).getByRole("button", { expanded: false }));
    expect(row.querySelector('[data-attention-group-member="fees.example"]')).toHaveTextContent("Confirmed 3h ago");
    expect(row.querySelector('[data-attention-group-member="areas.example"]')).toHaveTextContent("Last known");
    expect(row.querySelector("button button")).toBeNull();
  });

  /** Each count carries the shape of its own share: "9 open" is a shrug when
   * it is nine warnings and an emergency when it is nine errors. */
  describe("the answer says how bad tonight is", () => {
    it("says how many are open and how bad, in a sentence", () => {
      const lines = (severities: ("error" | "warn")[]) => {
        const { container, unmount } = renderAlerts(severities.map((severity, index) => alert({ id: index + 1, severity })));
        const line = answer(container);
        unmount();
        return line;
      };
      expect(lines(["warn"])).toBe("1 open alert, a warning");
      expect(lines(["error"])).toBe("1 open alert, an error");
      expect(lines(["warn", "warn"])).toBe("2 open alerts, both warnings");
      expect(lines(["error", "error", "error"])).toBe("3 open alerts, all errors");
      expect(lines(["error", "error", "warn"])).toBe("3 open alerts, 2 errors");
    });

    it("stays portfolio-wide while a filter narrows the list, and ends an unfiltered list", () => {
      const both = [
        alert({ id: 1, severity: "error" }),
        alert({ id: 2, severity: "warn", asset: "areas.example", assetDisplayName: "Areas" }),
      ];
      const filtered = renderAlerts(both, "/alerts?asset=meals.example");
      // A filtered list is not a finished one.
      expect(answer(filtered.container)).toBe("2 open alerts, 1 error");
      expect(screen.getByText("1 of 2 open")).toBeInTheDocument();
      expect(filtered.container.querySelector("[data-finish-line]")).toBeNull();
      filtered.unmount();

      const whole = renderAlerts(both);
      expect(whole.container.querySelector("[data-finish-line]")).toHaveTextContent("That's every open alert.");
    });

    it("names the oldest open alert's age beside the answer", () => {
      const { container } = renderAlerts([
        alert({ id: 1, firstFiredAt: "2026-07-31T12:00:00.000Z" }),
        alert({ id: 2, firstFiredAt: "2026-07-04T12:00:00.000Z" }),
      ]);
      expect(figure(container, "alerts-oldest")).toBe("28d");
    });

    it("counts what settled this week, and marks the figure a floor when the page cannot reach back", () => {
      history.data = {
        rows: [
          settledRow(1, "2026-07-30T12:00:00.000Z"),
          settledRow(2, "2026-07-01T12:00:00.000Z"),
        ],
        total: 2,
        offset: 0,
        limit: 100,
        hasMore: false,
        generatedAt: "2026-08-01T12:00:00.000Z",
      };
      const exact = renderAlerts([alert()]);
      // The page holds every settled row there is, so the count is a count
      // rather than a floor.
      expect(figure(exact.container, "alerts-settled")).toBe("1");
      exact.unmount();

      history.data = {
        rows: [settledRow(1, "2026-07-30T12:00:00.000Z")],
        total: 400,
        offset: 0,
        limit: 100,
        hasMore: true,
        generatedAt: "2026-08-01T12:00:00.000Z",
      };
      const floor = renderAlerts([alert()]);
      expect(figure(floor.container, "alerts-settled")).toBe("1+");
    });
  });

  it("keeps the recurrence chip on the row's own line", () => {
    renderAlerts([
      alert({ id: 1, severity: "error", occurrences: 4, firstFiredAt: "2026-07-30T12:00:00.000Z" }),
    ]);

    const row = screen.getByRole("button", { name: /Signups well below normal/ });
    expect(row.textContent).toContain("4× in 2d");
    // The ring carries the severity and the mark carries the kind, so neither
    // is colour alone.
    expect(row.querySelector(".text-error")).not.toBeNull();
    expect(row.textContent).toContain("△");
  });

  it("offers every asset in the store as a filter, not only the ones alerting", () => {
    renderAlerts([alert()]);

    const select = screen.getByLabelText("Site");
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Every site", "Meal Planner", "Areas"]);
  });

  it("offers no site filter with one site to pick, unless a link already narrows", () => {
    const oneSite = (url: string) => {
      const data = payload([alert()], []);
      state.data = { ...data, assets: data.assets.slice(0, 1) };
      return render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={[url]}>
            <AlertsRoute />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    };

    const plain = oneSite("/alerts");
    expect(screen.queryByLabelText("Site")).toBeNull();
    expect(screen.queryByText("Every site")).toBeNull();
    plain.unmount();

    oneSite("/alerts?asset=meals.example");
    expect(screen.getByLabelText("Site")).toHaveValue("meals.example");
  });

  /** A snooze that produced no visible row would be a mute with a friendlier
   * name, so the page carries the ledger of what was silenced. */
  describe("Snoozed — the honest half of a snooze", () => {
    function snoozed(overrides: Partial<SnoozedItem> = {}): SnoozedItem {
      return {
        ...alert({ id: 9, message: "Signups well below normal" }),
        snoozeUntil: "2026-08-04T12:00:00.000Z",
        ...overrides,
      };
    }

    it("lists a parked condition with its count, its date and an Unsnooze", () => {
      const { container } = renderAlerts([], "/alerts", [snoozed()]);
      const section = container.querySelector("[data-snoozed-alerts]")!;

      expect(section.textContent).toContain("Snoozed");
      expect(section.textContent).toContain("1 parked");
      expect(section.textContent).toContain("Meal Planner");
      expect(section.textContent).toContain("Signups well below normal");
      expect(section.querySelector('[data-snooze-state="active"]')).not.toBeNull();
      expect(section.textContent).toContain("Aug 4, 2026");
      expect(section.textContent).toContain("Last known");
      expect(section.textContent).toContain("first seen");
      expect(section.querySelector("button button")).toBeNull();

      // Unsnooze is the one verb this row has, inside the row.
      expect(screen.queryByRole("button", { name: "Unsnooze alert" })).toBeNull();
      const row = openRow(/Signups well below normal/);
      expect(
        within(row).getByRole("button", { name: "Unsnooze alert" }),
      ).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: /^Why this fired/ })).toHaveTextContent("Evidence");
      expect(within(row).queryByRole("button", { name: "Alert verification details" })).toBeNull();
    });

    it("stays out of the open count and the severity split", () => {
      const { container } = renderAlerts([], "/alerts", [
        snoozed({ severity: "error" }),
      ]);
      // The answer counts what needs attention; a parked row must not be in it.
      expect(answer(container)).toBe("No open alerts");
    });

    /** Snooze is offered on every open row of the asset page, info and
     * milestone included, so this ledger must carry them too. */
    it("lists a parked info row the open list above it could never carry", () => {
      const { container } = renderAlerts([], "/alerts", [
        snoozed({
          id: 11,
          severity: "info",
          kind: "milestone",
          message: "1,000th signup",
        }),
      ]);
      const section = container.querySelector("[data-snoozed-alerts]")!;
      expect(section.textContent).toContain("1,000th signup");

      // The severity is the row's own, carried by the ring; the `◦` mark says
      // parked. There is no milestone glyph, so the kind is stated in words.
      const row = within(section as HTMLElement).getByRole("button", {
        name: /1,000th signup/,
      });
      expect(row.textContent).toContain("◦");

      expect(answer(container)).toBe("No open alerts");
    });

    it("is absent entirely when nothing is parked", () => {
      const { container } = renderAlerts([alert()]);
      expect(container.querySelector("[data-snoozed-alerts]")).toBeNull();
    });

    it("survives a filter that hides every open row — a ledger a dropdown can shorten is one that can hide the row it was set to hide", () => {
      const { container } = renderAlerts([alert()], "/alerts?severity=error", [
        snoozed(),
      ]);
      expect(screen.getByText("No open alerts match these filters")).toBeInTheDocument();
      expect(container.querySelector("[data-snoozed-alerts]")).not.toBeNull();
    });
  });
});
