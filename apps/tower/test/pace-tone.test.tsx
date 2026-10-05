// Comparable pace direction (ro-trai.48): ahead green, equality neutral,
// behind amber, with the existing far-behind boundary red.

import { render } from "./render";
import { describe, expect, it } from "vitest";
import { DeltaChip, PACE_FAR_RATIO, paceDirectionLabel, paceTone, performanceToneClass } from "@/components/DeltaChip";

describe("paceTone", () => {
  it("preserves the existing far-behind presentation boundary", () => {
    expect(PACE_FAR_RATIO).toBe(0.6);
  });

  it("is green only when ahead", () => {
    for (const percent of [0.0001, 6.9, 150]) expect(paceTone(percent)).toBe("pace-on");
    expect(paceTone(0)).toBe("neutral");
    expect(paceTone(-0)).toBe("neutral");
  });

  it("is amber for every deficit down to the existing 0.60 boundary", () => {
    for (const percent of [-0.0001, -1.7, -5, -5.01, -6, -25, -39.99, -40]) expect(paceTone(percent)).toBe("pace-behind");
  });

  it("is far behind below 0.60, down to no visitors at all", () => {
    for (const percent of [-40.01, -43, -58, -90, -100]) expect(paceTone(percent)).toBe("pace-far-behind");
  });

  it("claims nothing for a pace that is not a number", () => {
    expect(paceTone(Number.NaN)).toBe("neutral");
    expect(paceTone(Number.POSITIVE_INFINITY)).toBe("neutral");
    expect(paceDirectionLabel(Number.NaN)).toBeNull();
    expect(paceDirectionLabel(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("states the direction in words, including exact equality", () => {
    expect(paceDirectionLabel(-1.7)).toBe("behind");
    expect(paceDirectionLabel(-58)).toBe("behind");
    expect(paceDirectionLabel(6.9)).toBe("ahead");
    expect(paceDirectionLabel(0)).toBe("on pace");
    expect(paceDirectionLabel(-0)).toBe("on pace");
  });

  it("colours the chip and anything drawn in the pace from one table, never without the arrow", () => {
    const { container } = render(
      <>
        {[-1.7, -58, 6.9, 0].map((value) => <DeltaChip key={value} value={value} tone={paceTone(value)} directionLabel={paceDirectionLabel(value) ?? undefined} render={(value) => `${value}%`} />)}
      </>,
    );
    const chips = [...container.querySelectorAll("[data-tone]")];
    expect(chips.map((chip) => chip.getAttribute("data-tone"))).toEqual(["pace-behind", "pace-far-behind", "pace-on", "neutral"]);
    expect(chips.map((chip) => chip.textContent)).toEqual(["1.7% behind", "58% behind", "6.9% ahead", "0% on pace"]);
    expect(chips[0]!.className).toContain("data-[tone=pace-behind]:text-pace-behind");
    // Colour is never alone: every step keeps its arrow and its number.
    for (const chip of chips) {
      expect(chip.querySelector("svg")).not.toBeNull();
      expect(chip.textContent).toMatch(/% (ahead|behind|on pace)$/);
    }
    expect(performanceToneClass("pace-far-behind")).toContain("text-pace-far-behind");
  });
});
