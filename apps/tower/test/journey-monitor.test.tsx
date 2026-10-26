import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyMonitor } from "@/components/JourneyMonitor";
import { JourneyDefinitionEditor } from "@/components/JourneyDefinitionEditor";
import { journeyComparison, journeyRateDomain, journeyReading, journeyStepChange, journeyStepReach, journeyStepReachChange, matchingJourneyResult, previousJourneyWeek } from "@/lib/journey-presentation";
import { JOURNEY_DEMO_DEFINITIONS, JOURNEY_DEMO_SNAPSHOT } from "@/routes/kitchen-sink/journey-fixture";
import type { JourneyDefinition, JourneySnapshot } from "@noticeos/contract/journeys";

const account = JOURNEY_DEMO_DEFINITIONS[0]!;
const result = JOURNEY_DEMO_SNAPSHOT.funnels[0]!;
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); });
afterEach(() => vi.unstubAllGlobals());

describe("ordered journey presentation", () => {
  it("uses ordered users for completion, absolute largest loss and adjacent comparisons", () => {
    const reading = journeyReading(account, result.current28);
    expect(reading.visitors).toBe(24000);
    expect(reading.rateBasis).toBe("visitors");
    expect(reading.rate).toBe(11);
    expect(reading.largestLoss).toBe(2);
    expect(reading.counts[1]! - reading.counts[2]!).toBe(5800);
    expect(journeyComparison(account, result.current28, result.prior28)).toBe(1);
    expect(journeyComparison(account, result.current7, result.prior28)).toBeNull();
    expect(journeyReading(account, { ...result.current28!, quality: "sampled" }).rate).toBeNull();
    expect(journeyReading(account, { ...result.current28!, complete: false }).rate).toBeNull();
    expect(journeyReading(account, { ...result.current28!, steps: result.current28!.steps.map((step, i) => ({ ...step, users: i === 1 ? 15000 : step.users })) }).rate).toBeNull();
  });

  it("keeps legacy, unavailable and incompatible visitor baselines distinct from measured reach", () => {
    const legacy = { ...result.current28!, visitors: undefined };
    expect(journeyReading(account, legacy)).toMatchObject({ visitors: null, rateBasis: "entrants", rate: 22 });
    expect(journeyComparison(account, legacy, result.prior28)).toBeNull();
    for (const visitors of [{ users: 100, quality: "complete" as const }, { users: 24000, quality: "sampled" as const }, { users: null, quality: "unavailable" as const }]) {
      expect(journeyReading(account, { ...result.current28!, visitors }).visitors).toBeNull();
    }
    expect(journeyReading(account, { ...result.current28!, visitors: { users: 0, quality: "complete" }, steps: account.steps.map((step) => ({ id: step.id, users: 0 })) }).rate).toBeNull();
  });

  it("shows a measured regression and recovery only against adjacent complete weeks", () => {
    const dip = result.weekly[6]!;
    const before = previousJourneyWeek(dip, result.weekly)!;
    expect(journeyStepChange(account, dip, before, 2)).toBeLessThan(0);
    expect(journeyStepChange(account, result.weekly[7]!, dip, 2)).toBeGreaterThan(0);
    expect(previousJourneyWeek(dip, result.weekly.filter((week) => week !== before))).toBeNull();
    expect(journeyStepChange(account, dip, result.weekly[4]!, 2)).toBeNull();
    expect(matchingJourneyResult({ ...account, version: 2 }, [result])).toBeNull();
  });

  it("uses the selected step's visitor reach and rejects incompatible weekly comparisons", () => {
    expect(journeyStepReach(account, result.current28, 0)).toBe(50);
    expect(journeyStepReach(account, result.current28, 2)).toBeCloseTo(15);
    expect(journeyStepReach(account, result.current28, 4)).toBe(11);
    expect(journeyStepReach(account, { ...result.current28!, visitors: undefined }, 2)).toBe(30);
    expect(journeyStepReach(account, { ...result.current28!, quality: "sampled" }, 2)).toBeNull();
    expect(journeyStepReachChange(account, result.current28, { ...result.prior28!, visitors: undefined }, 2)).toBeNull();
    expect(journeyStepReachChange(account, result.weekly[6]!, result.weekly[5]!, 2)).toBeLessThan(0);
  });

  it("fits percentage axes to low, flat and boundary series without dropping real values", () => {
    for (const values of [[0.28, 0.31, 0.44], [0.003, 0.004], [47, 53, 49], [0, 100], [100], [0.3], [0], []]) {
      const { min, max, ticks } = journeyRateDomain(values);
      expect(max).toBeGreaterThan(min);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(100);
      for (const value of values) { expect(min).toBeLessThanOrEqual(value); expect(max).toBeGreaterThanOrEqual(value); }
      expect(ticks[0]).toBe(min);
      expect(ticks.at(-1)).toBe(max);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
    expect(journeyRateDomain([0.28, 0.31, 0.44]).max).toBeLessThan(0.6);
    expect(journeyRateDomain([0.003, 0.004]).max).toBeLessThan(0.005);
    expect(journeyRateDomain([47, 53, 49]).max - journeyRateDomain([47, 53, 49]).min).toBeLessThanOrEqual(10);
  });

  it("keeps the gallery's weekly and period sample counts consistent", () => {
    for (const item of JOURNEY_DEMO_SNAPSHOT.funnels) {
      expect(item.current28!.visitors).toEqual(result.current28!.visitors);
      expect(item.weekly.map((week) => week.visitors)).toEqual(result.weekly.map((week) => week.visitors));
      for (const [first, last, period] of [[0, 4, item.prior28], [4, 8, item.current28]] as const) {
        expect(period!.steps.map((step) => step.users)).toEqual(item.weekly.slice(first, last).reduce<number[]>((sum, week) => week.steps.map((step, i) => (sum[i] ?? 0) + step.users!), []));
      }
      expect(item.weekly[6]!.steps).toEqual(item.prior7!.steps);
      expect(item.weekly[7]!.steps).toEqual(item.current7!.steps);
    }
  });
});

describe("JourneyMonitor", () => {
  it("opens on the largest absolute loss and keeps counts on a shared ruler", () => {
    const { container } = render(<JourneyMonitor illustrative definitions={JOURNEY_DEMO_DEFINITIONS} snapshot={JOURNEY_DEMO_SNAPSHOT} />);
    expect(screen.getByText("Illustrative design data")).toBeInTheDocument();
    expect(container.querySelector('[data-largest-loss="true"]')).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-largest-loss="true"]')!.textContent).toContain("5,800");
    expect(container.querySelectorAll('[data-outcome="true"]')).toHaveLength(1);
    const first = container.querySelectorAll<HTMLElement>(".journey-current")[0]!;
    const last = container.querySelectorAll<HTMLElement>(".journey-current")[4]!;
    expect(first.style.width).toBe("50%");
    expect(last.style.width).toBe("11%");
    expect(container.querySelector(".journey-baseline")!.textContent).toContain("24,000");
    expect(container.querySelector(".journey-baseline")!.textContent).toContain("100%");
    expect(container.querySelector('[data-step-index="0"]')!.textContent).toContain("50% did not enter");
    expect(container.querySelector('[data-step-index="2"]')!.textContent).toContain("61.7% drop-off");
    expect(container.querySelector('[data-step-index="4"]')!.textContent).toContain("11%of visitors");
    expect(screen.getByRole("heading", { name: "Choose save" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Visit calculator" }));
    expect(screen.getByRole("heading", { name: "Visit calculator" })).toBeInTheDocument();
    expect(screen.getByText("people entered")).toBeInTheDocument();
  });

  it("keeps the funnel visible while step selection changes its history and weekly counts", () => {
    const measured = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    try {
      const { container } = render(<JourneyMonitor definitions={[account]} snapshot={JOURNEY_DEMO_SNAPSHOT} />);
      expect(screen.queryByRole("button", { name: "Steps" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Over time" })).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Journey steps" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Choose save: weekly percentage of visitors" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Inspect Account created" }));
      expect(screen.getByRole("heading", { name: "Account created over time" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Account created: weekly percentage of visitors" })).toBeInTheDocument();
      expect(container.querySelectorAll(".journey-step")).toHaveLength(account.steps.length);
      fireEvent.click(screen.getByRole("button", { name: /Oct 5–11, 2026: 10% of visitors reached Account created/ }));
      expect(container.querySelector('[data-step-index="4"]')).toHaveAttribute("aria-pressed", "true");
      expect(container.querySelector('[data-step-index="4"]')!.textContent).toContain("600");
      expect(screen.getByText(/Viewing week · Oct 5–11, 2026/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Return to 28-day period" }));
      expect(container.querySelector('[data-step-index="4"]')!.textContent).toContain("2,640");
    } finally { measured.mockRestore(); }
  });

  it("keeps an unavailable week as a gap without switching the history's visitor baseline", () => {
    const measured = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    try {
      const weekly = result.weekly.map((week, index) => index === 6 ? { ...week, quality: "unavailable" as const } : week);
      const { container } = render(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, weekly }] }} />);
      fireEvent.click(screen.getByRole("button", { name: /Oct 5–11, 2026: — of visitors reached Choose save/ }));
      expect(screen.getByText("Ordered conversion is unavailable")).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Choose save: weekly percentage of visitors" })).toBeInTheDocument();
      expect(container.querySelectorAll(".journey-trend-point")).toHaveLength(7);
      expect(screen.getByText("Count unavailable", { exact: false })).toBeInTheDocument();
    } finally { measured.mockRestore(); }
  });

  it.each([7, 28] as const)("opens available weekly counts explicitly when the current %i-day report is missing", (days) => {
    const { container } = render(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, current7: null, current28: null }] }} />);
    fireEvent.click(screen.getByRole("button", { name: `${days} days` }));
    expect(screen.getByText(`No current ${days}-day report is available. Weekly reports are collected separately.`)).toBeInTheDocument();
    expect(container.querySelectorAll(".journey-step")).toHaveLength(0);
    expect(screen.getByText(/Complete weeks are ready for collection on Tuesday/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View week · Oct 12–18, 2026" }));
    expect(screen.getByText("Viewing week · Oct 12–18, 2026")).toBeInTheDocument();
    expect(container.querySelectorAll(".journey-step")).toHaveLength(account.steps.length);
    expect(container.querySelector('[data-step-index="0"]')!.textContent).toContain("3,200");
    expect(screen.queryByText("Ordered conversion is unavailable")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `Return to ${days}-day period` }));
    expect(screen.getByText(`No current ${days}-day report is available. Weekly reports are collected separately.`)).toBeInTheDocument();
    expect(container.querySelectorAll(".journey-step")).toHaveLength(0);
  });

  it("offers the latest complete week and excludes sampled or invalid weeks from the shortcut", () => {
    const weekly = result.weekly.slice(-2).map((week, index) => index === 1 ? { ...week, quality: "sampled" as const } : week);
    const { rerender } = render(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, current28: null, weekly }] }} />);
    expect(screen.getByRole("button", { name: "View week · Oct 5–11, 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View week · Oct 12–18, 2026" })).not.toBeInTheDocument();
    const invalid = { ...weekly[0]!, steps: account.steps.map((step, index) => ({ id: step.id, users: index + 1 })) };
    rerender(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, current28: null, weekly: [invalid, weekly[1]!] }] }} />);
    expect(screen.queryByRole("button", { name: /View week/ })).not.toBeInTheDocument();
    expect(screen.getByText("No ordered report has been collected for this period.")).toBeInTheDocument();
  });

  it("preserves a known zero count and displays a small nonzero weekly change", () => {
    const zero = { ...result.weekly[7]!, visitors: { users: 0, quality: "complete" as const }, steps: account.steps.map((step) => ({ id: step.id, users: 0 })) };
    const { container, rerender } = render(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, weekly: [zero] }] }} />);
    expect(container.querySelector(".journey-history-reading")!.textContent).toContain("0 people");
    expect(container.querySelector(".journey-history-reading")!.textContent).not.toContain("Count unavailable");
    const weekly = result.weekly.slice(6).map((week, index) => ({ ...week, visitors: { users: 100000, quality: "complete" as const }, steps: week.steps.map((step, stepIndex) => ({ ...step, users: stepIndex === 4 ? 3 + index : step.users })) }));
    rerender(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, weekly }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Account created" }));
    expect(container.querySelector(".journey-history-reading")!.textContent).toContain("0.004%");
    expect(container.querySelector(".journey-history-reading")!.textContent).toContain("+0.001 pts vs prior week");
  });

  it("shows a missing visitor reference honestly without hiding the ordered funnel", () => {
    render(<JourneyMonitor definitions={[account]} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, current28: { ...result.current28!, visitors: undefined } }] }} />);
    expect(screen.getByText(/Visitor totals were not collected/)).toBeInTheDocument();
    expect(screen.getAllByText("of entrants").length).toBeGreaterThan(0);
    expect(screen.queryByText("starting point")?.parentElement?.textContent).toContain("—");
  });

  it("selects a week in the change grid and opens its actual weekly counts", () => {
    const { container } = render(<JourneyMonitor definitions={JOURNEY_DEMO_DEFINITIONS} snapshot={JOURNEY_DEMO_SNAPSHOT} />);
    fireEvent.click(screen.getByText("All step changes"));
    expect(screen.getByRole("heading", { name: "Where continuation changed" })).toBeInTheDocument();
    const regression = screen.getByRole("button", { name: /Choose save, Oct 5–11, 2026:.*down/i });
    expect(regression).toHaveAttribute("data-trend", "negative");
    fireEvent.click(regression);
    expect(screen.getByText(/Viewing week · Oct 5–11, 2026/)).toBeInTheDocument();
    expect(container.querySelector('[data-step-index="0"]')!.textContent).toContain("3,000");
    expect(container.querySelector('[data-step-index="4"]')!.textContent).toContain("600");
    fireEvent.click(screen.getByRole("button", { name: "Return to 28-day period" }));
    expect(container.querySelector('[data-step-index="0"]')!.textContent).toContain("12,000");
  });

  it("does not fabricate counts for missing, sampled, planned or session reports", () => {
    const sampled: JourneySnapshot = { ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, current28: { ...result.current28!, quality: "sampled", reason: "Provider sampled this query." } }] };
    const { container, rerender } = render(<JourneyMonitor definitions={JOURNEY_DEMO_DEFINITIONS} snapshot={sampled} />);
    expect(screen.getByText("Provider sampled this query.")).toBeInTheDocument();
    expect(container.querySelector(".journey-current")).toBeNull();
    rerender(<JourneyMonitor definitions={JOURNEY_DEMO_DEFINITIONS} snapshot={null} />);
    expect(screen.getByText("No ordered report has been collected for this period.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Paid subscriptions/ }));
    expect(screen.getByText("Planned journey")).toBeInTheDocument();
    expect(container.querySelector(".journey-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Exploration/ }));
    expect(screen.getByText("Session paths are not collected")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Selected step history" })).not.toBeInTheDocument();
  });

  it("keeps real calendar gaps in the trend and withholds a change verdict after a gap", () => {
    const measured = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    try {
      const weekly = [result.weekly[0]!, result.weekly[1]!, result.weekly[7]!];
      const snapshot = { ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, weekly }] };
      const { container } = render(<JourneyMonitor definitions={[account]} snapshot={snapshot} />);
      fireEvent.click(screen.getByText("All step changes"));
      const path = container.querySelector(".journey-trend-line")!.getAttribute("d")!;
      expect(path.match(/M/g)).toHaveLength(2);
      expect(path.match(/L/g)).toHaveLength(1);
      expect(screen.getByRole("button", { name: /Choose save, Oct 12–18, 2026:.*no comparable prior week/ })).toHaveAttribute("data-trend", "neutral");
    } finally { measured.mockRestore(); }
  });
});

describe("JourneyDefinitionEditor", () => {
  it("preserves exact parameters and label-only versions, permits a second edit and reverses removal", async () => {
    let saved: JourneyDefinition[] = [];
    const undo = vi.fn(async () => ({ undone: true }));
    const onSave = vi.fn(async (next: JourneyDefinition[]) => { saved = next; return { saved: true, undo }; });
    const { rerender } = render(<JourneyDefinitionEditor definition={account} definitions={[account]} eventNames={[]} onSave={onSave} onClose={() => {}} onSelected={() => {}} />);
    fireEvent.change(screen.getByLabelText("Journey name *"), { target: { value: "Account completion" } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(saved[0]!.version).toBe(1);
    expect(saved[0]!.steps[3]!.alternatives[0]!.parameters).toEqual([{ name: "intent", value: "signup" }]);
    rerender(<JourneyDefinitionEditor definition={account} definitions={saved} eventNames={[]} onSave={onSave} onClose={() => {}} onSelected={() => {}} />);
    fireEvent.change(screen.getAllByLabelText("GA4 event *")[1]!, { target: { value: "calculation_finished" } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(saved[0]!.version).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove journey" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3));
    expect(saved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Previous definition restored")).toBeInTheDocument();
  });

  it("keeps keyboard focus on the step moved and edits OR parameter filters", () => {
    render(<JourneyDefinitionEditor definition={account} definitions={[account]} eventNames={[]} onSave={async () => ({ saved: true })} onClose={() => {}} onSelected={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 down" }));
    expect(document.activeElement).toHaveValue("Complete calculation");
    const editor = screen.getByRole("region", { name: "Journey definition" });
    fireEvent.change(within(editor).getByLabelText("Exact value *"), { target: { value: "new_account" } });
    expect(within(editor).getByLabelText("Exact value *")).toHaveValue("new_account");
  });
});


it("edits first-party exploration without GA4 conditions", async () => {
  const definition: JourneyDefinition = { id: "section-exploration", label: "Section exploration", goal: "First-party session paths between site sections", kind: "exploration", source: "first-party", reportingLagDays: 2, status: "planned", version: 1, steps: [] };
  const onSave = vi.fn().mockResolvedValue({ saved: true });
  render(<JourneyDefinitionEditor definition={definition} definitions={[definition]} eventNames={[]} onSave={onSave} onClose={() => {}} onSelected={() => {}}/>);
  expect(screen.getByText(/First-party session paths are supplied by asset reports/)).toBeInTheDocument();
  expect(screen.queryByLabelText("GA4 event *")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add step" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Measurement")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith([definition]));
});
