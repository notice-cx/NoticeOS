import { describe, expect, it } from "vitest";
import { render } from "./render";
import { DeltaChip, paceTone, performanceToneClass } from "@/components/DeltaChip";
import { wallTrafficTone } from "@/lib/wall-traffic-tone";

describe("Wall traffic display colors", () => {
  it.each([[0.001, "pace-on"], [23, "pace-on"], [100, "pace-on"], [-0.001, "pace-behind"], [-9.999, "pace-behind"], [-10, "wall-traffic-decline"], [-24.999, "wall-traffic-decline"], [-25, "pace-far-behind"], [-100, "pace-far-behind"], [0, "neutral"], [null, "neutral"], [undefined, "neutral"], [NaN, "neutral"], [Infinity, "neutral"]] as const)("maps %s to %s", (value, expected) => {
    expect(wallTrafficTone(value)).toBe(expected);
  });
  it("uses the existing orange token without changing general pace semantics", () => {
    expect(paceTone(-25)).toBe("pace-behind");
    expect(performanceToneClass(wallTrafficTone(-10))).toContain("text-urgent");
    const view = render(<DeltaChip value={-10} tone={wallTrafficTone(-10)} render={value => `${value}%`} meaning="10% lower traffic" />);
    expect(view.getByLabelText("10% lower traffic")).toHaveAttribute("data-tone", "wall-traffic-decline");
  });
});
