import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleBacktest, RuleBacktestDay } from "@noticeos/contract";
import type { AlertRuleStatsPayload } from "@shared/alert-rules";
import type { FlagRecord, KnobFact } from "@shared/asset-detail";
import { AlertRow } from "@/components/AlertRow";
import { BacktestStrip } from "@/components/BacktestStrip";
import { FlagActions } from "@/components/FlagActions";
import { RuleTunePanel, TuneRuleAction } from "@/components/RuleTune";
import { tuneProposalTask } from "@/components/TuneRate";
import { useOsAssetId } from "@/hooks/useOsAssetId";
import { buildSettingsPayload } from "../worker/settings-payload";
import { configSaveReply } from "./config-save-reply";

// The Tune action and its preview (bead `ro-u072`). What is pinned here is the
// promise the panel makes: a rule with no honest replay is offered no trigger at
// all, a day nobody reported is drawn as a hole rather than as a quiet day, the
// preview follows the field as it is typed into, and the settings say out loud
// that they judge every asset — the sentence doc 10 removed the per-asset rule
// editor for the want of.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrap(node: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

const KNOBS: KnobFact[] = [
  {
    key: "alpha",
    label: "Anomaly sensitivity",
    jargon: "alpha",
    value: "0.01",
    explain: "How improbable a reading has to be before it alerts.",
    owner: "config/constants.json",
    pointer: "/flag_defaults/alpha",
    raw: 0.01,
  },
  {
    key: "min_baseline_per_day",
    label: "Minimum daily volume",
    jargon: "min_baseline_per_day",
    value: "3",
    explain: "Below this many a day the multi-day rule takes over.",
    owner: "config/constants.json",
    pointer: "/flag_defaults/min_baseline_per_day",
    raw: 3,
  },
  {
    key: "low_volume_window_hours",
    label: "Low-volume window",
    jargon: "low_volume_window_hours",
    value: "72",
    explain: "How many hours the low-volume rule adds up.",
    owner: "config/constants.json",
    pointer: "/flag_defaults/low_volume_window_hours",
    raw: 72,
  },
];

function settingsPayload() {
  const payload = buildSettingsPayload({
    now: new Date("2026-09-04T12:00:00.000Z"),
    osTimeZone: "Etc/UTC",
    timeZoneChosen: false,
    monthlyCaps: { dataUsd: 25 },
    operatorRateUsdPerMin: 2,
    flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
    signalPanels: {},
    pullConfig: [],
    integrations: { catalog: [], assets: {} },
    dashboard: {},
    entities: [],
    beads: { spokes: [] },
  });
  payload.alertRules.knobs = KNOBS;
  return payload;
}

/** What the store says this rule has already cost (bead `ro-ayxy`) — the read
 * the live panel makes beside its replay. Three settled, one of them answered by
 * tuning: docs/15 flow E's arithmetic at its smallest honest size. */
const RULE_STATS: AlertRuleStatsPayload = {
  generatedAt: "2026-09-04T12:00:00.000Z",
  windowDays: 90,
  since: "2026-06-06T12:00:00.000Z",
  rules: [
    {
      ruleId: "flow-poisson-low",
      fired: 5,
      settled: 3,
      tuned: 1,
      tunedOpen: 0,
      acknowledged: 1,
      resolved: 1,
      tunes: 0,
    },
  ],
};

function backtest(
  script: (index: number) => { state: RuleBacktestDay["state"]; stored?: boolean },
  windowDays = 30,
): RuleBacktest {
  const days: RuleBacktestDay[] = Array.from({ length: windowDays }, (_, index) => {
    const { state, stored = false } = script(index);
    return {
      date: new Date(Date.UTC(2026, 7, 6) + index * 86_400_000).toISOString().slice(0, 10),
      state,
      firings: state === "fired" ? [{ metric: "signups", severity: "warn" as const }] : [],
      ...(state === "unjudged" ? { reason: "no-baseline" as const } : {}),
      stored,
    };
  });
  return {
    asset: "nosh.example",
    ruleId: "flow-poisson-low",
    metric: "signups",
    config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
    windowDays,
    firstDay: days[0]!.date,
    lastDay: days[days.length - 1]!.date,
    days,
    wouldFire: days.filter((day) => day.state === "fired").length,
    judged: days.filter((day) => day.state === "fired" || day.state === "quiet").length,
    reported: days.filter((day) => day.state !== "no-report").length,
    firedInStore: days.filter((day) => day.stored).length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BacktestStrip", () => {
  it("states the count and draws one slot per day", () => {
    const { container } = render(
      <BacktestStrip
        backtest={backtest((index) =>
          index === 2 || index === 17 ? { state: "fired" } : { state: "quiet" },
        )}
      />,
    );
    expect(screen.getByText(/Would have fired/)).toHaveTextContent(
      "Would have fired 2 times in the last 30 days",
    );
    expect(container.querySelectorAll("[data-backtest-day]")).toHaveLength(30);
    expect(container.querySelectorAll('[data-backtest-day="fired"]')).toHaveLength(2);
  });

  it("draws a day nobody reported as a hole, never as a quiet day", () => {
    const { container } = render(
      <BacktestStrip
        backtest={backtest((index) =>
          index < 4 ? { state: "no-report" } : { state: "quiet" },
        )}
      />,
    );
    expect(container.querySelectorAll('[data-backtest-day="no-report"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-backtest-day="quiet"]')).toHaveLength(26);
    // 26 of 30, not 30 of 30: the strip never counts a hole as an answer.
    expect(container.querySelector("[data-backtest-judged]")).toHaveTextContent(
      "26 of 30 days could be judged",
    );
  });

  it("marks the days the rule really fired, beside what the candidate would do", () => {
    const { container } = render(
      <BacktestStrip
        backtest={backtest((index) => ({
          state: index === 5 ? "fired" : "quiet",
          stored: index === 5 || index === 9 || index === 20,
        }))}
      />,
    );
    expect(container.querySelector("[data-backtest-reality]")).toHaveTextContent(
      "It really fired 3 times",
    );
    expect(container.querySelectorAll("[data-backtest-stored]")).toHaveLength(3);
  });

  it("says an asset filed nothing rather than that the rule would stay quiet", () => {
    const { container } = render(
      <BacktestStrip backtest={backtest(() => ({ state: "no-report" }))} />,
    );
    expect(container.querySelector('[data-backtest-strip="no-reports"]')).not.toBeNull();
    expect(container.querySelector('[data-backtest-strip="no-reports"]')).toHaveTextContent(
      "No reports in the last 30 days",
    );
    // No count, because there is no answer — a "0 times" here would be a lie.
    expect(screen.queryByText(/Would have fired/)).toBeNull();
  });

  it("says too little history is an unanswered question, not a quiet rule", () => {
    const { container } = render(
      <BacktestStrip backtest={backtest(() => ({ state: "unjudged" }))} />,
    );
    // The headline IS the state: never "Would have fired 0 times", which reads
    // as a quiet rule — it says the replay could not answer.
    expect(container.querySelector('[data-backtest-note="unjudged"]')).toHaveTextContent(
      "Not enough history to replay",
    );
    expect(screen.queryByText(/Would have fired/)).toBeNull();
  });

  it("bands the weeks from the newest one backwards", () => {
    // 2026-08-06 is a Thursday, so the newest week starts on the 30th day's own
    // Sunday and parity alternates back from there — never from the first
    // visible date (doc 14).
    const { container } = render(
      <BacktestStrip backtest={backtest(() => ({ state: "quiet" }))} />,
    );
    const cells = [...container.querySelectorAll("[data-backtest-day]")];
    const shaded = cells.map((cell) => cell.className.includes("bg-chart-week-band"));
    // The last cell is 2026-09-04 (a Friday); its week is unshaded.
    expect(shaded[29]).toBe(false);
    // Seven days earlier is the previous calendar week, which is shaded.
    expect(shaded[22]).toBe(true);
  });
});

describe("TuneRuleAction", () => {
  it("offers no trigger for a rule a pulse replay cannot serve", () => {
    render(wrap(<TuneRuleAction asset="nosh.example" ruleId="ingest-freshness" />));
    expect(screen.queryByRole("button", { name: "Tune rule" })).toBeNull();
  });

  it("offers the trigger beside the two lifecycle actions on a rule-driven alert", () => {
    render(
      wrap(
        <FlagActions
          flagId={12}
          assetId="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Mark alert read" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve alert" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tune rule" })).toBeInTheDocument();
  });

  it("adds nothing to a row that was given no rule", () => {
    render(wrap(<FlagActions flagId={12} assetId="nosh.example" />));
    expect(screen.queryByRole("button", { name: "Tune rule" })).toBeNull();
  });

  it("opens a panel that asks for the replay, and closes it on Escape", async () => {
    const asked: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/alerts/backtest") {
          asked.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify(backtest((index) => ({ state: index === 1 ? "fired" : "quiet" }))),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/settings") {
          return new Response(JSON.stringify(settingsPayload()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "/api/alerts/rules") {
          return new Response(JSON.stringify(RULE_STATS), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ writable: true, reason: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    render(
      wrap(<TuneRuleAction asset="nosh.example" ruleId="flow-poisson-low" metric="signups" />),
    );
    fireEvent.click(screen.getByRole("button", { name: "Tune rule" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Tune rule/ })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(asked).toEqual([
        {
          asset: "nosh.example",
          ruleId: "flow-poisson-low",
          metric: "signups",
          config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByText(/Would have fired/)).toHaveTextContent(
        "Would have fired 1 time in the last 30 days",
      );
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

describe("RuleTunePanel", () => {
  function renderPanel(
    preview: Parameters<typeof RuleTunePanel>[0]["preview"],
    onDraftChange = vi.fn(),
  ) {
    const saved: unknown[] = [];
    render(
      wrap(
        <RuleTunePanel
          asset="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
          knobs={KNOBS}
          preview={preview}
          onDraftChange={onDraftChange}
          onSave={async (op) => {
            saved.push(op);
          }}
        />,
      ),
    );
    return { saved, onDraftChange };
  }

  it("leads with the scope, because these settings judge every asset", () => {
    renderPanel({ state: "ready", backtest: backtest(() => ({ state: "quiet" })) });
    const container = document.body;
    // The scope is the panel's first mark, stated ONCE — a chip above the
    // numbers, not a sentence and not a note under every field.
    const scope = container.querySelector("[data-rule-tune-scope]")!;
    expect(scope).toHaveTextContent("Applies to every site");
    expect(scope.querySelector("svg")).not.toBeNull();
    expect(screen.getAllByText("Applies to every site")).toHaveLength(1);
    const panel = container.querySelector("[data-rule-tune]")!;
    expect(panel.children[1]).toBe(scope);
    // The replay names what it replayed, in its own heading.
    expect(container.querySelector("[data-rule-tune-replay]")).toHaveTextContent(/Replay · /);
  });

  it("renders the three portfolio settings and links to where they live", () => {
    renderPanel({ state: "loading" });
    for (const knob of KNOBS) {
      expect(screen.getByLabelText(new RegExp(knob.label))).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /Every alert rule/ })).toHaveAttribute(
      "href",
      "/settings#alert-rules",
    );
  });

  it("reports the validated draft as a field is typed into, and null when it is refused", () => {
    const onDraftChange = vi.fn();
    renderPanel({ state: "loading" }, onDraftChange);
    onDraftChange.mockClear();

    const alpha = screen.getByLabelText(/Anomaly sensitivity/);
    fireEvent.change(alpha, { target: { value: "0.05" } });
    expect(onDraftChange).toHaveBeenLastCalledWith("alpha", 0.05);

    fireEvent.change(alpha, { target: { value: "9" } });
    expect(onDraftChange).toHaveBeenLastCalledWith("alpha", null);
  });

  it("writes the edited setting as one guarded file op", async () => {
    const { saved } = renderPanel({ state: "loading" });
    fireEvent.change(screen.getByLabelText(/Anomaly sensitivity/), {
      target: { value: "0.05" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => {
      expect(saved).toEqual([
        {
          kind: "file-json-set",
          file: "config/constants.json",
          pointer: "/flag_defaults/alpha",
          expect: 0.01,
          value: 0.05,
        },
      ]);
    });
  });

  it("says which kind of nothing it has, rather than showing an empty box", () => {
    const { unmount } = render(
      wrap(
        <RuleTunePanel
          asset="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
          knobs={KNOBS}
          preview={{ state: "invalid" }}
          onDraftChange={vi.fn()}
          onSave={async () => {}}
        />,
      ),
    );
    expect(screen.getByText(/Fix the value above/)).toBeInTheDocument();
    unmount();

    render(
      wrap(
        <RuleTunePanel
          asset="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
          knobs={KNOBS}
          preview={{ state: "failed", message: "No preview for this rule — it is not judged by these settings." }}
          onDraftChange={vi.fn()}
          onSave={async () => {}}
        />,
      ),
    );
    expect(screen.getByText(/No preview for this rule/)).toBeInTheDocument();
  });
});

/**
 * `ro-van6` — the save records the tune on the alert it was made from, and the
 * row says so while staying in the queue.
 */
function openFlag(overrides: Partial<FlagRecord> = {}): FlagRecord {
  return {
    id: 12,
    firedAt: "2026-09-03T02:00:00.000Z",
    firstFiredAt: "2026-09-03T02:00:00.000Z",
    occurrences: 1,
    severity: "warn",
    kind: "anomaly",
    metric: "signups",
    message: "Signups well below normal",
    ruleId: "flow-poisson-low",
    ruleInputs: null,
    correlatedChanges: [],
    disposition: null,
    dispositionAt: null,
    dispositionNote: null,
    snoozeUntil: null,
    ackExpiry: null,
    resolvedAt: null,
    liveness: { state: "live" },
    ...overrides,
  };
}

/** The reads the live panel makes, with the write lane open and the store
 * answering. Returns the PATCHes it saw, which is what these tests are about. */
function stubPanelStore(): { url: string; body: unknown }[] {
  const patched: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/flags/")) {
        patched.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/settings") {
        return new Response(JSON.stringify(settingsPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // One URL, two questions: GET asks whether this deployment may write
      // files at all, PUT is the write.
      if (url === "/api/config") {
        return new Response(
          JSON.stringify(
            init?.method === "PUT"
              ? configSaveReply(init, { archive: "config/changesets/0009_x.json", commit: "abc1234" })
              : { writable: true, reason: null },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/alerts/backtest") {
        return new Response(JSON.stringify(backtest(() => ({ state: "quiet" }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/alerts/rules") {
        return new Response(JSON.stringify(RULE_STATS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ writable: true, reason: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return patched;
}

async function tuneAlpha(node: ReactNode): Promise<void> {
  render(wrap(node));
  fireEvent.click(screen.getByRole("button", { name: "Tune rule" }));
  await waitFor(() => {
    expect(screen.getByLabelText(/Anomaly sensitivity/)).toBeInTheDocument();
  });
  fireEvent.change(screen.getByLabelText(/Anomaly sensitivity/), {
    target: { value: "0.05" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
}

describe("a saved tune is recorded on the alert it was tuned from", () => {
  it("PATCHes that flag with the setting that moved and both of its values", async () => {
    const patched = stubPanelStore();
    await tuneAlpha(
      <TuneRuleAction
        asset="nosh.example"
        ruleId="flow-poisson-low"
        metric="signups"
        flagId={12}
      />,
    );

    await waitFor(() => {
      expect(patched).toEqual([
        {
          url: "/api/flags/12",
          body: {
            action: "tune",
            // The store composes the note from these; nothing free-text is sent,
            // and `from` is the value the field was showing when it changed.
            tuned: { setting: "alpha", from: 0.01, to: 0.05 },
          },
        },
      ]);
    });
  });

  it("records nothing when the panel was opened with no alert in front of it", async () => {
    const patched = stubPanelStore();
    await tuneAlpha(<TuneRuleAction asset="nosh.example" ruleId="flow-poisson-low" />);

    // The setting still saves — said beside the field (bead ro-ujb9.96.7.12) —
    // there is simply no flag to disposition, and one is never invented
    // (`TuneRuleActionProps.flagId`).
    await waitFor(() => {
      expect(document.querySelector('[data-save-state="saved"]')).not.toBeNull();
    });
    expect(patched).toEqual([]);
  });
});

describe("a tuned alert stays open and says it was tuned", () => {
  const NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");
  const TUNED = {
    disposition: "tune" as const,
    dispositionAt: "2026-09-04T11:00:00.000Z",
    dispositionNote: "Anomaly sensitivity (alpha) 0.01 → 0.05",
  };

  /**
   * Open the row, the way an operator does.
   *
   * `AlertRow` is doc 21's `ListRow` since bead `ro-78qo.17`: closed, it is a
   * mark, a headline, one caption and an age; the evidence, the dated facts and
   * the verbs are revealed IN PLACE. So a test that wants any of those presses
   * the row first — which is the assertion, not a workaround for one.
   */
  function openRow(): void {
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]!);
  }

  it("wears the chip among the actions it still has", () => {
    const { container } = render(
      wrap(
        <AlertRow flag={openFlag(TUNED)} nowMs={NOW_MS} assetId="nosh.example" />,
      ),
    );
    // Nothing is printed under the row until it is opened.
    expect(container.querySelector("[data-alert-tuned]")).toBeNull();
    openRow();
    expect(container.querySelector("[data-alert-tuned]")).toHaveTextContent("tuned");
    // Still open: every lifecycle verb is on the row, because the firing was
    // never answered — only the rule that produced it changed.
    expect(screen.getByRole("button", { name: "Mark alert read" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve alert" })).toBeInTheDocument();
    // And the settled footer stays away: its badge would say what the chip
    // says, and its span would measure a row that is still open.
    expect(screen.queryByText("Rule tuned")).toBeNull();
    expect(container.querySelector("[data-alert-open-span]")).toBeNull();
  });

  /**
   * `ro-vu8d.23`. The OS now sends a message for a new open error alert, and the
   * row says so — the question every alert list raises is *did I already know
   * about this*. The mark is EVIDENCE: the record is written only when a message
   * actually landed, so an unmarked row is one the operator was never
   * interrupted for.
   */
  it("says when the operator was already told about this one", () => {
    const { container } = render(
      wrap(
        <AlertRow
          flag={openFlag({
            severity: "error",
            notifiedAt: "2026-09-04T11:45:00.000Z",
          })}
          nowMs={NOW_MS}
          assetId="nosh.example"
        />,
      ),
    );
    openRow();
    const mark = container.querySelector("[data-notified-at]");
    expect(mark).toHaveTextContent("notified");
    expect(mark?.getAttribute("title")).toContain("2026-09-04T11:45:00.000Z");
  });

  it("says nothing about notification on a row that was never sent", () => {
    // Which covers three cases that all mean the same thing to the operator:
    // the alert did not qualify, the delivery failed, or the OS has nowhere to
    // record what it sent and is standing down.
    const { container } = render(
      wrap(<AlertRow flag={openFlag()} nowMs={NOW_MS} assetId="nosh.example" />),
    );
    expect(container.querySelector("[data-notified-at]")).toBeNull();
  });

  it("says nothing at all on a row nobody has tuned", () => {
    const { container } = render(
      wrap(<AlertRow flag={openFlag()} nowMs={NOW_MS} assetId="nosh.example" />),
    );
    expect(container.querySelector("[data-alert-tuned]")).toBeNull();
  });

  /**
   * `ro-bkcl`. The row that used to forget: tuned, then marked read. The
   * disposition slot holds one decision, so the badge says what the operator did
   * with the FIRING and the chip says what they did to the RULE — and the quoted
   * reason is the decision's half alone, because the setting is already in the
   * chip's hover (doc 14, one representation per fact).
   */
  it("keeps the chip on a settled row it was tuned on before it was read", () => {
    const { container } = render(
      wrap(
        <AlertRow
          flag={openFlag({
            disposition: "ack",
            dispositionAt: "2026-09-04T11:30:00.000Z",
            dispositionNote:
              "Marked read by operator · rule tuned: Anomaly sensitivity (alpha) 0.01 → 0.05",
          })}
          nowMs={NOW_MS}
          assetId="nosh.example"
          history
        />,
      ),
    );

    // The disposition is the settled row's CAPTION — what was decided is the
    // fact a list of closed alerts is scanned for, so it stays on the line.
    expect(screen.getByText("Acknowledged")).toBeInTheDocument();

    openRow();
    const chip = container.querySelector("[data-alert-tuned]");
    expect(chip).toHaveTextContent("tuned");
    expect(chip?.getAttribute("title")).toContain(
      "Anomaly sensitivity (alpha) 0.01 → 0.05",
    );
    expect(screen.getByText("“Marked read by operator”")).toBeInTheDocument();
  });

  it("draws this rule's tune record in the panel, above the replay", async () => {
    stubPanelStore();
    render(
      wrap(
        <TuneRuleAction
          asset="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
          flagId={12}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Tune rule" }));

    const dialog = await screen.findByRole("dialog", { name: /Tune rule/ });
    await waitFor(() => {
      expect(dialog.querySelector("[data-rule-tune-rate]")).not.toBeNull();
    });
    // docs/15 flow E's arithmetic, from the shipped read (bead `ro-ayxy`): one
    // of the three alerts this rule produced that are finished with was
    // answered by tuning it.
    expect(screen.getByText("1 of 3 settled")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();

    // A MEASUREMENT BEFORE A PROJECTION: what the rule has cost leads what a
    // change would do, because the operator opening this panel has already
    // decided that one alert was noise.
    const record = dialog.querySelector("[data-rule-tune-rate]")!;
    const replay = dialog.querySelector(
      "[data-backtest-day], [data-rule-tune-preview]",
    )!;
    expect(
      record.compareDocumentPosition(replay) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /**
   * `ro-bgny`. The proposal reaches the panel because it lives inside
   * `TuneRate`, which both surfaces already draw — a rule the OS wants quieter
   * has to say so where the quietening happens, and a panel of its own would be
   * a second place to learn one thing.
   */
  it("carries the OS's proposal into the panel, where the tuning happens", () => {
    const { container } = render(
      wrap(
        <RuleTunePanel
          asset="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
          knobs={KNOBS}
          preview={{ state: "loading" }}
          stats={{
            generatedAt: "2026-09-04T12:00:00.000Z",
            windowDays: 90,
            since: "2026-06-06T12:00:00.000Z",
            rules: [
              {
                ruleId: "flow-poisson-low",
                fired: 22,
                settled: 8,
                tuned: 5,
                tunedOpen: 0,
                acknowledged: 2,
                resolved: 1,
                tunes: 0,
              },
            ],
          }}
          onDraftChange={() => {}}
          onSave={async () => {}}
        />,
      ),
    );

    const proposal = container.querySelector(
      "[data-tune-proposal='flow-poisson-low']",
    ) as HTMLElement;
    expect(proposal).not.toBeNull();
    expect(proposal.textContent).toMatch(/make this rule quieter/);
    // It is a reading of the counts, so it sits UNDER them: a reading that
    // arrives before its evidence is an instruction.
    const rate = container.querySelector("[data-tune-rate-share]")!;
    expect(
      rate.compareDocumentPosition(proposal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws no figure at all when no counts reached the panel", () => {
    // The gallery, a test, or a deployment whose read failed. A panel that said
    // "no firings yet" on the strength of a fetch that never answered would be
    // inventing evidence about the rule it is asking the operator to change.
    const { container } = render(
      wrap(
        <RuleTunePanel
          asset="nosh.example"
          ruleId="flow-poisson-low"
          metric="signups"
          knobs={KNOBS}
          preview={{ state: "loading" }}
          onDraftChange={() => {}}
          onSave={async () => {}}
        />,
      ),
    );

    expect(container.querySelector("[data-rule-tune-rate]")).toBeNull();
    expect(container.querySelector("[data-tune-rate]")).toBeNull();
  });

  it("becomes a disposition in the history once the alert settles", () => {
    const { container } = render(
      wrap(
        <AlertRow
          flag={openFlag({
            ...TUNED,
            resolvedAt: "2026-09-04T11:30:00.000Z",
            liveness: { state: "historical" },
          })}
          nowMs={NOW_MS}
          assetId="nosh.example"
          history
        />,
      ),
    );
    expect(screen.getByText("Rule tuned")).toBeInTheDocument();
    openRow();
    expect(screen.getByText(/Anomaly sensitivity/)).toBeInTheDocument();
    // No chip beside the badge: "Rule tuned" already says it, and two marks for
    // one fact is doc 14's own rule broken.
    expect(container.querySelector("[data-alert-tuned]")).toBeNull();
  });
});

// Bead ro-ujb9.118: the proposal files into the OS's own project as the STORE
// names it (`assets.is_os`), never into an id written into the product.
describe("the tune proposal files against the OS's own project", () => {
  const facts = { ruleId: "flow-poisson-low", share: 0.625, tuned: 5, settled: 8 };

  it("takes the project from the store's OS asset, whatever it is called", () => {
    expect(tuneProposalTask(facts, 30, "home-os.example").project).toBe("home-os.example");
  });

  it("names no project while the OS asset is unknown, so the composer asks", () => {
    expect(tuneProposalTask(facts, 30, null)).not.toHaveProperty("project");
  });

  it("reads the OS asset from the Wall read the desk already holds, and never fetches", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let seen: string | null = "unset";
    function Probe() {
      seen = useOsAssetId();
      return null;
    }
    const held = new QueryClient();
    held.setQueryData(["wall"], { system: { assetId: "home-os.example" } });
    render(
      <QueryClientProvider client={held}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(seen).toBe("home-os.example");

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(seen).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
