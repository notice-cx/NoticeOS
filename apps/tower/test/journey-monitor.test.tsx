import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyMonitor } from "@/components/JourneyMonitor";
import { JourneyDefinitionEditor } from "@/components/JourneyDefinitionEditor";
import { journeyComparison, journeyReading, journeyStepChange, matchingJourneyResult, previousJourneyWeek } from "@/lib/journey-presentation";
import { JOURNEY_DEMO_DEFINITIONS, JOURNEY_DEMO_SNAPSHOT } from "@/routes/kitchen-sink/journey-fixture";
import type { JourneyDefinition, JourneySnapshot } from "@noticeos/contract/journeys";

const account = JOURNEY_DEMO_DEFINITIONS[0]!;
const result = JOURNEY_DEMO_SNAPSHOT.funnels[0]!;
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); });
afterEach(() => vi.unstubAllGlobals());

describe("ordered journey presentation", () => {
  it("uses ordered users for completion, absolute largest loss and adjacent comparisons", () => {
    const reading = journeyReading(account, result.current28);
    expect(reading.rate).toBe(22);
    expect(reading.largestLoss).toBe(2);
    expect(reading.counts[1]! - reading.counts[2]!).toBe(5800);
    expect(journeyComparison(account, result.current28, result.prior28)).toBe(2);
    expect(journeyComparison(account, result.current7, result.prior28)).toBeNull();
    expect(journeyReading(account, { ...result.current28!, quality: "sampled" }).rate).toBeNull();
    expect(journeyReading(account, { ...result.current28!, complete: false }).rate).toBeNull();
    expect(journeyReading(account, { ...result.current28!, steps: result.current28!.steps.map((step, i) => ({ ...step, users: i === 1 ? 15000 : step.users })) }).rate).toBeNull();
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

  it("keeps the gallery's weekly and period sample counts consistent", () => {
    for (const item of JOURNEY_DEMO_SNAPSHOT.funnels) {
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
    expect(first.style.width).toBe("100%");
    expect(last.style.width).toBe("22%");
    expect(screen.getByRole("heading", { name: "Choose save" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Visit calculator" }));
    expect(screen.getByRole("heading", { name: "Visit calculator" })).toBeInTheDocument();
    expect(screen.getByText("people entered")).toBeInTheDocument();
  });

  it("selects a week in the change grid and opens its actual weekly counts", () => {
    const { container } = render(<JourneyMonitor definitions={JOURNEY_DEMO_DEFINITIONS} snapshot={JOURNEY_DEMO_SNAPSHOT} />);
    fireEvent.click(screen.getByRole("button", { name: "Over time" }));
    expect(screen.getByRole("heading", { name: "Where continuation changed" })).toBeInTheDocument();
    const regression = screen.getByRole("button", { name: /Choose save, Oct 5–11, 2026:.*down/i });
    expect(regression).toHaveAttribute("data-trend", "negative");
    fireEvent.click(regression);
    fireEvent.click(screen.getByRole("button", { name: "View this week →" }));
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
    expect(screen.getByRole("button", { name: "Over time" })).toBeDisabled();
  });

  it("keeps real calendar gaps in the trend and withholds a change verdict after a gap", () => {
    const measured = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    try {
      const weekly = [result.weekly[0]!, result.weekly[1]!, result.weekly[7]!];
      const snapshot = { ...JOURNEY_DEMO_SNAPSHOT, funnels: [{ ...result, weekly }] };
      const { container } = render(<JourneyMonitor definitions={[account]} snapshot={snapshot} />);
      fireEvent.click(screen.getByRole("button", { name: "Over time" }));
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
