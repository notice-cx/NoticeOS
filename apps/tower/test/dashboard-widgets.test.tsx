import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "./render";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CountdownWidget } from "@/components/DashboardWidgets";

/** The countdown's editor saves through the config lane, so it reads and
 * writes through TanStack Query. Nothing here stubs `fetch`: the writability
 * question failing is the state a browser is in before the answer arrives,
 * and the field stays live for it (useConfigWritable's optimistic default). */
function withClient(node: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>
  );
}

const NOW = new Date(2026, 6, 29, 10, 15).getTime();
const TARGET = new Date(2026, 8, 2, 12, 45).toISOString();
const DAY = 86_400_000;
const MINUTE = 60_000;
const BAND_TINTS = [
  "text-muted-foreground",
  "text-foreground",
  "text-warn",
  "text-urgent",
  "text-error",
];
/** Only the two hot bands paint the segment box behind the value. */
const BAND_SURFACES = ["bg-urgent/10", "bg-error-soft"];

/**
 * Renders one countdown in isolation and reports the band carried by its one
 * primary measure. Boundaries are asserted from both sides, so an off-by-one
 * cannot pass while subordinate measures stay deliberately quiet.
 */
function countdownAt(offsetMs: number): {
  band: string | null;
  primaryTint: string | null;
  primarySurface: string | null;
} {
  const view = render(
    <CountdownWidget
      config={{
        emoji: "🚀",
        label: "Launch",
        targetAt: new Date(NOW + offsetMs).toISOString(),
      }}
      nowMs={NOW}
    />,
  );
  const widget = view.container.querySelector("[data-proximity]");
  const primary = widget?.querySelector("[data-countdown-primary='true']") ?? null;
  const value = primary?.querySelector("[data-countdown-value]") ?? null;
  const present = (element: Element | null, names: string[]) =>
    names.filter((name) => element?.classList.contains(name) ?? false);
  const result = {
    band: widget?.getAttribute("data-proximity") ?? null,
    primaryTint: present(value, BAND_TINTS)[0] ?? null,
    primarySurface: present(primary, BAND_SURFACES)[0] ?? null,
  };
  view.unmount();
  return result;
}

describe("the desk countdown", () => {

  it("shows calendar-month countdown values and stays read-only without Configure", () => {
    const { container } = render(
      <CountdownWidget
        config={{ emoji: "🚀", label: "Launch", targetAt: TARGET }}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Countdown symbol: 🚀" })).toBeInTheDocument();
    expect(container.querySelector("[data-countdown-emoji] span")).toHaveClass(
      "text-[clamp(5rem,20vw,8rem)]",
      "leading-none",
    );
    expect(container.querySelector("[data-countdown-emoji]")).toHaveClass("row-span-2");
    const target = container.querySelector("[data-countdown-target]");
    expect(target).toHaveClass("col-start-2", "bg-background");
    expect(target).not.toHaveClass("bg-muted/35");
    expect(target?.parentElement).toHaveAttribute("data-countdown-layout");
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
  });

  it("hides zero units and makes the most significant current measure primary", () => {
    const { container } = render(
      <CountdownWidget
        config={{
          emoji: "🗓️",
          label: "Two-day marker",
          targetAt: new Date(NOW + 2 * DAY + 5 * MINUTE).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByText("Months")).not.toBeInTheDocument();
    expect(screen.queryByText("Hours")).not.toBeInTheDocument();
    expect(screen.getByText("Days").parentElement).toHaveAttribute(
      "data-countdown-primary",
      "true",
    );
    expect(container.querySelector("[data-countdown-layout]")).toHaveClass(
      "grid-rows-[6rem_auto]",
    );
    expect(container.querySelector("[data-countdown-measures]")).toHaveClass("h-full");
    expect(screen.getByText("Days").previousElementSibling).toHaveClass("text-5xl");
    const minuteCard = screen.getByText("Minutes").parentElement?.parentElement;
    expect(minuteCard?.querySelector("[data-countdown-value]")).toHaveClass(
      "text-muted-foreground",
    );
    expect(minuteCard).toHaveClass("border-l");
    expect(minuteCard).not.toHaveClass("rounded-xl", "border");
    expect(container.querySelectorAll("[data-countdown-unit]")).toHaveLength(2);
  });

  // The three values are one setting with one Save: the emoji, the words and
  // the moment are one landmark, written as a single changeset or not at all.
  // Until the save lands the widget keeps showing what is configured.
  it("edits its three values as one form with one Save, and previews nothing", () => {
    render(
      withClient(
        <CountdownWidget
          config={{ emoji: "🚀", label: "Launch", targetAt: TARGET }}
          nowMs={NOW}
          interactive
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Countdown emoji"), { target: { value: "🌁" } });
    fireEvent.change(screen.getByLabelText("Countdown label"), { target: { value: "Team offsite" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Countdown symbol: 🚀" })).toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.queryByText("Team offsite")).not.toBeInTheDocument();
    expect(screen.queryByText(/only staged/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Review changes")).not.toBeInTheDocument();

    const target = screen.getByLabelText("Target date and time") as HTMLInputElement;
    expect(target.type).toBe("datetime-local");
  });

  it("refuses to save a value its own validator rejects", () => {
    render(
      withClient(
        <CountdownWidget
          config={{ emoji: "🚀", label: "Launch", targetAt: TARGET }}
          nowMs={NOW}
          interactive
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    fireEvent.change(screen.getByLabelText("Countdown emoji"), {
      target: { value: "not an emoji" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Use one emoji.")).toBeInTheDocument();
  });

  it("labels an elapsed target without showing negative units", () => {
    render(
      <CountdownWidget
        config={{
          emoji: "🏁",
          label: "Past launch",
          targetAt: new Date(NOW - 60_000).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    const reached = document.querySelector("[data-countdown-reached]");
    expect(reached).toHaveTextContent("Reached");
    expect(screen.queryByText("00")).not.toBeInTheDocument();
    expect(screen.queryByText("Months")).not.toBeInTheDocument();
  });

  it("cools an elapsed target to gray instead of nagging in red", () => {
    const view = render(
      <CountdownWidget
        config={{
          emoji: "🏁",
          label: "Past launch",
          targetAt: new Date(NOW - 6 * DAY).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    const reached = view.container.querySelector("[data-countdown-reached]")!;
    // Below the ramp's own muted floor: this word is set in the live
    // measures' 4xl/5xl bold caps, which a finished countdown has not earned.
    expect(reached).toHaveClass("text-muted-foreground/50");
    expect(reached).not.toHaveClass("text-error");
    expect(reached).not.toHaveClass("bg-error-soft");
    expect(
      view.container.querySelector("[data-proximity]"),
    ).toHaveAttribute("data-proximity", "reached");
  });

  it("keeps a target it cannot parse hot, because that one is still broken", () => {
    const view = render(
      <CountdownWidget
        config={{ emoji: "🏁", label: "Typo", targetAt: "not a date" }}
        nowMs={NOW}
      />,
    );
    expect(view.container.querySelector("[data-countdown-reached]")).toHaveClass(
      "text-error",
    );
    expect(view.container.querySelector("[data-proximity]")).toHaveAttribute(
      "data-proximity",
      "imminent",
    );
    expect(screen.getByText("Invalid date")).toBeInTheDocument();
  });

  it("names the final partial minute instead of rendering four zero tiles", () => {
    render(
      <CountdownWidget
        config={{
          emoji: "⏳",
          label: "Almost there",
          targetAt: new Date(NOW + 30_000).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText("<1")).toBeInTheDocument();
    expect(screen.getByText("Minute")).toBeInTheDocument();
    expect(screen.queryByText("Months")).not.toBeInTheDocument();
  });

  it("leaves a target a month or more out quiet", () => {
    expect(countdownAt(60 * DAY)).toEqual({
      band: "far",
      primaryTint: "text-muted-foreground",
      primarySurface: null,
    });
    expect(countdownAt(30 * DAY)).toEqual({
      band: "far",
      primaryTint: "text-muted-foreground",
      primarySurface: null,
    });
    expect(countdownAt(30 * DAY - MINUTE).band).toBe("approaching");
  });

  it("promotes the value to the default foreground inside 30 days", () => {
    expect(countdownAt(14 * DAY)).toEqual({
      band: "approaching",
      primaryTint: "text-foreground",
      primarySurface: null,
    });
    expect(countdownAt(14 * DAY - MINUTE).band).toBe("near");
  });

  it("warms to warn amber inside two weeks, still without a tinted field", () => {
    expect(countdownAt(7 * DAY)).toEqual({
      band: "near",
      primaryTint: "text-warn",
      primarySurface: null,
    });
    expect(countdownAt(7 * DAY - MINUTE).band).toBe("soon");
  });

  it("escalates to urgent orange inside a week and paints the primary field", () => {
    expect(countdownAt(2 * DAY)).toEqual({
      band: "soon",
      primaryTint: "text-urgent",
      primarySurface: "bg-urgent/10",
    });
    expect(countdownAt(2 * DAY - MINUTE).band).toBe("imminent");
  });

  it("burns error red inside two days", () => {
    expect(countdownAt(DAY)).toEqual({
      band: "imminent",
      primaryTint: "text-error",
      primarySurface: "bg-error-soft",
    });
  });

  it("uses typography rather than card chrome below the two hot bands", () => {
    const view = render(
      <CountdownWidget
        config={{
          emoji: "🚀",
          label: "Launch",
          targetAt: new Date(NOW + 10 * DAY).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    const box = view.container
      .querySelector("[data-countdown-primary='true']");
    expect(box).not.toHaveClass("rounded-xl", "border", "shadow-inner");
    expect(box).not.toHaveClass("bg-background/75");
  });

  it("uses a borderless tint for an imminent primary measure", () => {
    const view = render(
      <CountdownWidget
        config={{
          emoji: "🚀",
          label: "Launch",
          targetAt: new Date(NOW + DAY).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    const box = view.container
      .querySelector("[data-countdown-primary='true']");
    expect(box).toHaveClass("bg-error-soft");
    expect(box).not.toHaveClass("border-error/40", "rounded-xl", "border");
  });

  it("tints the value only — the label and unit captions stay quiet", () => {
    render(
      <CountdownWidget
        config={{
          emoji: "🚀",
          label: "Launch",
          targetAt: new Date(NOW + DAY).toISOString(),
        }}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText("Launch")).toHaveClass("text-foreground");
    expect(screen.getByText("Launch")).not.toHaveClass("text-error");
    expect(screen.getByText("Days")).toHaveClass("text-muted-foreground");
    expect(screen.getByText("Days")).not.toHaveClass("text-error");
  });
});
