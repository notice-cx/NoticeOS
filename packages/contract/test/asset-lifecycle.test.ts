import { describe, expect, it } from "vitest";
import { assetLifecycleStatus, canSetLifecycleControl, lifecycleControlValue } from "../src/asset-lifecycle";

describe("observed asset lifecycle", () => {
  it.each(["onboarding", "baselining", "live", "unknown"])("ignores the old %s assignment", (stored) => {
    expect(assetLifecycleStatus(stored, false)).toBe("onboarding");
    expect(assetLifecycleStatus(stored, true)).toBe("live");
  });
  it.each(["pre-launch", "retired"])("preserves the human %s decision even with collection history", (stored) => {
    expect(assetLifecycleStatus(stored, false)).toBe(stored);
    expect(assetLifecycleStatus(stored, true)).toBe(stored);
  });
  it("normalizes old restore targets to an enabled monitoring control", () => {
    expect(lifecycleControlValue("live")).toBe("onboarding");
    expect(lifecycleControlValue("baselining")).toBe("onboarding");
    expect(lifecycleControlValue("pre-launch")).toBe("pre-launch");
    expect(lifecycleControlValue("retired")).toBe("retired");
  });
  it("permits decisions and restoration while rejecting assigned progress", () => {
    expect(canSetLifecycleControl("onboarding", "live")).toBe(false);
    expect(canSetLifecycleControl("live", "baselining")).toBe(false);
    expect(canSetLifecycleControl("baselining", "onboarding")).toBe(false);
    expect(canSetLifecycleControl("onboarding", "retired")).toBe(true);
    expect(canSetLifecycleControl("live", "pre-launch")).toBe(true);
    expect(canSetLifecycleControl("pre-launch", "onboarding")).toBe(true);
    expect(canSetLifecycleControl("retired", "onboarding")).toBe(true);
    expect(canSetLifecycleControl("retired", "live")).toBe(true);
  });
});
