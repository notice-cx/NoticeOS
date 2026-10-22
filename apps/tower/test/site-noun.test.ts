// @vitest-environment node
import { describe, expect, it } from "vitest";
import { siteCount, siteNoun } from "@shared/site-noun";

describe("the count of assets", () => {
  it("says asset for exactly one and assets for every other count", () => {
    expect(siteCount(1)).toBe("1 asset");
    expect(siteCount(2)).toBe("2 assets");
    expect(siteCount(0)).toBe("0 assets");
    expect(siteNoun(1)).toBe("asset");
    expect(siteNoun(12)).toBe("assets");
  });
});
